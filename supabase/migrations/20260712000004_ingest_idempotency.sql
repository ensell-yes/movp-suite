-- C5a.5 optional idempotency keys for API-key platform-event ingest. The hash is derived from
-- the normalized payload that reaches platform_event; unknown fields and idempotency_key are excluded.
create table if not exists movp_internal.ingest_idempotency (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  idempotency_key text not null,
  payload_hash text not null,
  event_id uuid not null references public.platform_event(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);
alter table movp_internal.ingest_idempotency enable row level security;
revoke all on movp_internal.ingest_idempotency from anon, authenticated;
grant all on movp_internal.ingest_idempotency to service_role;

create or replace function public.ingest_platform_event(api_key text, events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_event jsonb;
  v_type text;
  v_subject_ref text;
  v_subject_type text;
  v_actor_ref text;
  v_props jsonb;
  v_occurred timestamptz;
  v_idem text;
  v_effective jsonb;
  v_hash text;
  v_stored_hash text;
  v_new_id uuid;
  n_ok int := 0;
  n_bad int := 0;
  n_dup int := 0;
  n_conflict int := 0;
begin
  -- jsonb serialization of timestamptz follows the session timezone; hash in UTC so a retry
  -- from another timezone compares the same effective payload.
  perform set_config('TimeZone', 'UTC', true);
  select k.workspace_id into v_ws
    from movp_internal.ingest_key k
   where k.key_hash = encode(extensions.digest(api_key, 'sha256'), 'hex')
     and k.active
   limit 1;
  if v_ws is null then
    raise exception 'ingest_key_invalid' using errcode = '28000';
  end if;
  if jsonb_typeof(events) is distinct from 'array' then
    raise exception 'events_not_array' using errcode = '22023';
  end if;
  if jsonb_array_length(events) > 500 then
    raise exception 'batch_too_large' using errcode = '54000';
  end if;

  -- Keyed events must acquire transaction advisory locks in one global order. Without this,
  -- concurrent batches [A, B] and [B, A] can deadlock while each waits on the other's key.
  for v_event in
    select value
      from jsonb_array_elements(events) with ordinality as item(value, ordinality)
     order by
       case
         when jsonb_typeof(value->'idempotency_key') = 'string'
           and length(value->>'idempotency_key') > 0 then 0
         else 1
       end,
       value->>'idempotency_key',
       ordinality
  loop
    v_type := v_event->>'event_type';
    v_subject_ref := v_event->>'subject_ref';
    v_subject_type := coalesce(v_event->>'subject_type', 'user');
    v_actor_ref := v_event->>'actor_ref';
    v_props := coalesce(v_event->'properties', '{}'::jsonb);
    v_idem := v_event->>'idempotency_key';
    begin
      v_occurred := (v_event->>'occurred_at')::timestamptz;
    exception when others then
      v_occurred := null;
    end;

    if v_type is null or length(v_type) = 0
       or v_subject_ref is null or length(v_subject_ref) = 0
       or v_occurred is null
       -- This canonical jsonb byte length is authoritative. The Edge's compact JSON check is
       -- defense in depth and can admit a near-limit payload that this check reports as dropped.
       or octet_length(v_props::text) > 16384
       or (v_event ? 'idempotency_key' and jsonb_typeof(v_event->'idempotency_key') <> 'string')
       or (v_idem is not null and octet_length(v_idem) > 255) then
      n_bad := n_bad + 1;
      continue;
    end if;

    -- This is the payload the insert below actually consumes. Hashing it prevents dropped
    -- unknown fields or the key itself from changing idempotency semantics.
    v_effective := jsonb_build_object(
      'event_type', v_type,
      'subject_type', v_subject_type,
      'subject_ref', v_subject_ref,
      'actor_ref', v_actor_ref,
      'properties', v_props,
      'occurred_at', v_occurred
    );

    if v_idem is not null and length(v_idem) > 0 then
      v_hash := encode(extensions.digest(v_effective::text, 'sha256'), 'hex');
      -- platform_event is append-only, so serialize the check+insert path before creating it.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_ws::text || ':' || v_idem, 0)
      );
      select ii.payload_hash into v_stored_hash
        from movp_internal.ingest_idempotency ii
       where ii.workspace_id = v_ws and ii.idempotency_key = v_idem;
      if found then
        if v_stored_hash = v_hash then
          n_dup := n_dup + 1;
          continue;
        end if;
        n_bad := n_bad + 1;
        n_conflict := n_conflict + 1;
        perform public.emit_event(
          'ingest.idempotency_conflict',
          v_ws,
          jsonb_build_object(
            'idempotency_key_present', true,
            'reason', 'payload_mismatch',
            'workspace_hash', encode(extensions.digest(v_ws::text, 'sha256'), 'hex')
          ),
          gen_random_uuid()::text
        );
        continue;
      end if;
    end if;

    begin
      insert into public.platform_event
        (workspace_id, event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at, ingested_at)
      values
        (v_ws, v_type, v_subject_type, v_subject_ref, v_actor_ref, 'external', v_props, v_occurred, now())
      returning id into v_new_id;

      if v_idem is not null and length(v_idem) > 0 then
        insert into movp_internal.ingest_idempotency (workspace_id, idempotency_key, payload_hash, event_id)
        values (v_ws, v_idem, v_hash, v_new_id);
      end if;
      n_ok := n_ok + 1;
    exception
      when not_null_violation or check_violation or invalid_text_representation or datetime_field_overflow then
        n_bad := n_bad + 1;
        continue;
    end;
  end loop;

  return jsonb_build_object(
    'inserted', n_ok,
    'dropped', n_bad,
    'duplicate', n_dup,
    'conflict', n_conflict
  );
end;
$$;
revoke all on function public.ingest_platform_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_platform_event(text, jsonb) to service_role;
