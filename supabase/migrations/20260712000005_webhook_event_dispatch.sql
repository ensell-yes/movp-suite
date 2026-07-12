-- C5 webhook dispatch: callers with stable entity ids can supply a per-mutation discriminator.
-- Generic events retain business-id dedupe; external_record emits a fresh discriminator per change.
create or replace function public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
begin
  insert into movp_internal.movp_events (type, workspace_id, payload, trace_id)
  values (ev_type, ws, payload, coalesce(trace, gen_random_uuid()::text))
  returning id into v_event_id;

  if payload ? 'recipient_user_id' or payload ? 'email' then
    insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    values ('notify', ev_type || ':' || coalesce(payload->>'id', gen_random_uuid()::text),
            payload || jsonb_build_object('event', ev_type), ws)
    on conflict (kind, idempotency_key) do nothing;
  end if;

  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  select 'webhook', ev_type || ':' || coalesce(payload->>'webhook_dedupe_key', payload->>'id', '') || ':' || w.id::text,
         payload || jsonb_build_object('event', ev_type, 'webhook_id', w.id, 'url', w.url, 'secret', w.secret), ws
    from movp_internal.webhooks w
   where w.workspace_id = ws and w.event_type = ev_type and w.active
  on conflict (kind, idempotency_key) do nothing;

  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values ('automate', v_event_id::text,
          jsonb_build_object(
            'event_id', v_event_id,
            'event_type', ev_type,
            'depth', case when payload->>'depth' ~ '^\d+$' then (payload->>'depth')::int else 0 end
          ),
          ws)
  on conflict (kind, idempotency_key) do nothing;
end;
$$;

create or replace function public.external_record_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'external.record.upserted',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'source', new.source,
      'external_id', new.external_id,
      'webhook_dedupe_key', gen_random_uuid()::text
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.external_record_emit_event() from public, anon, authenticated;
