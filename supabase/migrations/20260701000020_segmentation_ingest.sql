-- Segmentation Phase 6 — Part B (external ingestion). Sorts AFTER Part A's 000019.
-- Hand-authored: the ingest_key registry (private, like movp_internal.webhooks),
-- mint_ingest_key (service-role-only; returns the raw key once), and the API-key
-- ingest RPC (resolves the workspace from the key hash; the payload workspace_id
-- is never trusted). No codegen — nothing here is a config-first collection.

-- ── movp_internal.ingest_key: hashed-key registry (mirror movp_internal.webhooks)
create table movp_internal.ingest_key (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  key_hash     text not null unique,            -- encode(extensions.digest(raw,'sha256'),'hex')
  label        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table movp_internal.ingest_key enable row level security;   -- no policies: closed to anon/authenticated
revoke all on movp_internal.ingest_key from anon, authenticated;
grant all on movp_internal.ingest_key to service_role;

-- ── mint_ingest_key: emit a raw key ONCE, store only its hash ────────────────
-- GOTCHA: keep `set search_path = ''` (definer-audit gate). gen_random_bytes /
-- digest are pgcrypto -> extensions-qualified. encode is pg_catalog (unqualified).
-- Service-role-only: a member must NOT be able to self-issue an ingest key.
create or replace function public.mint_ingest_key(ws uuid, label text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw_key text;
begin
  raw_key := encode(extensions.gen_random_bytes(24), 'hex');   -- 48 hex chars
  insert into movp_internal.ingest_key (workspace_id, key_hash, label)
    values (ws, encode(extensions.digest(raw_key, 'sha256'), 'hex'), label);
  return raw_key;   -- returned ONCE; the caller must store it now. Never persisted/logged raw.
end; $$;
revoke all on function public.mint_ingest_key(uuid, text) from public, anon, authenticated;
grant execute on function public.mint_ingest_key(uuid, text) to service_role;  -- operator/admin path only

-- ── ingest_platform_event: API-key path — workspace comes from the KEY ───────
-- GOTCHA: keep `set search_path = ''`. The workspace is resolved from the hashed
-- key; EVERY row is stamped with that workspace_id, so events->>'workspace_id' is
-- ignored — a workspace-A key can never write a workspace-B row. Malformed /
-- oversized events are DROPPED (never buffered/inserted); the batch is capped.
create or replace function public.ingest_platform_event(api_key text, events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ws          uuid;
  v_event       jsonb;
  v_type        text;
  v_subject_ref text;
  v_props       jsonb;
  v_occurred    timestamptz;
  n_ok          int := 0;
  n_bad         int := 0;
begin
  -- resolve workspace from the HASHED key (server-side; never trust client input)
  select k.workspace_id into v_ws
    from movp_internal.ingest_key k
   where k.key_hash = encode(extensions.digest(api_key, 'sha256'), 'hex')
     and k.active
   limit 1;
  if v_ws is null then
    raise exception 'ingest_key_invalid' using errcode = '28000';   -- invalid_authorization_specification
  end if;

  if jsonb_typeof(events) is distinct from 'array' then
    raise exception 'events_not_array' using errcode = '22023';
  end if;
  if jsonb_array_length(events) > 500 then                          -- INGEST_MAX_BATCH
    raise exception 'batch_too_large' using errcode = '54000';      -- program_limit_exceeded
  end if;

  for v_event in select value from jsonb_array_elements(events)
  loop
    v_type        := v_event->>'event_type';
    v_subject_ref := v_event->>'subject_ref';
    v_props       := coalesce(v_event->'properties', '{}'::jsonb);
    begin
      v_occurred := (v_event->>'occurred_at')::timestamptz;
    exception when others then
      v_occurred := null;
    end;
    -- required shape + serialized-byte bound (superset discriminator vs the client's exact bytes)
    if v_type is null or length(v_type) = 0
       or v_subject_ref is null or length(v_subject_ref) = 0
       or v_occurred is null
       or octet_length(v_props::text) > 16384 then                  -- INGEST_MAX_PROP_BYTES
      n_bad := n_bad + 1;
      continue;
    end if;
    -- Per-row INSERT wrapped with a NARROW handler: only EXPECTED data-shape errors (not_null/check/
    -- text-repr/datetime) DROP the single row (counted) and continue; any UNEXPECTED error propagates and
    -- aborts the batch loudly (never a silent loss of valid events — see the handler note below).
    -- subject_type is coalesced to 'user' (Part A NOT NULL) so the expected 23502 can't fire here anyway.
    begin
      insert into public.platform_event
        (workspace_id, event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at, ingested_at)
      values
        (v_ws, v_type, coalesce(v_event->>'subject_type', 'user'), v_subject_ref, v_event->>'actor_ref',
         'external', v_props, v_occurred, now());                   -- workspace = v_ws (the KEY's), never the payload
      n_ok := n_ok + 1;
    exception
      when not_null_violation or check_violation or invalid_text_representation or datetime_field_overflow then
        n_bad := n_bad + 1;                                         -- EXPECTED data-shape error → DROP (counted), batch continues
        continue;
      -- NOTE: `when others` is intentionally NOT caught — an UNEXPECTED insert failure (schema drift, a
      -- new constraint/trigger, a DB fault) on an already-validated event must NOT be silently dropped.
      -- It propagates and aborts the batch loudly (the caller sees a hard error + can retry) rather than
      -- losing valid events. Expected malformed input is already dropped by the pre-insert shape check above.
    end;
  end loop;

  return jsonb_build_object('inserted', n_ok, 'dropped', n_bad);
end; $$;
revoke all on function public.ingest_platform_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_platform_event(text, jsonb) to service_role;  -- edge fn (service-role client)
