-- Domain Workflows Phase 7 - Part A: catalog guards and automate enqueue.

insert into movp_internal.movp_job_kind (kind)
values ('automate')
on conflict (kind) do nothing;

alter table public.workflow_run
  add constraint workflow_run_event_rule_unique unique (source_event_id, automation_rule_id);

create index workflow_run_workspace_created_idx on public.workflow_run (workspace_id, created_at desc);
create index workflow_run_workspace_outcome_idx on public.workflow_run (workspace_id, outcome);
create index workflow_run_workspace_event_type_idx on public.workflow_run (workspace_id, event_type);

drop policy if exists workflow_run_rw on public.workflow_run;
drop policy if exists workflow_run_select on public.workflow_run;
create policy workflow_run_select on public.workflow_run
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.workflow_run from authenticated;
grant select on public.workflow_run to authenticated;
grant select, insert, update, delete on public.workflow_run to service_role;

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
  select 'webhook', ev_type || ':' || coalesce(payload->>'id','') || ':' || w.id::text,
         payload || jsonb_build_object('event', ev_type, 'url', w.url, 'secret', w.secret), ws
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
