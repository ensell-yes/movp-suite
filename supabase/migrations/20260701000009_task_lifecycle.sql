-- Task Management Phase 3 - Part B. Sorts AFTER Part A's task migrations.
-- Hand-authored: emit_event notify guard, task lifecycle/transition/dependency/
-- due-soon triggers, and the inbox_feed 'assigned' tab. All fan-out goes through
-- public.emit_event -> movp_internal.movp_events/movp_jobs.

-- emit_event: add the notify-enqueue guard.
-- create or replace preserves the existing grants from the async-RPC migration.
create or replace function public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into movp_internal.movp_events (type, workspace_id, payload, trace_id)
  values (ev_type, ws, payload, coalesce(trace, gen_random_uuid()::text));

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
end; $$;

-- insert-event triggers: fan out through public.emit_event.
create or replace function public.task_created_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('task.created', new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type','task','entity_id', new.id, 'title', new.title),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.task_created_emit_event() from public, anon, authenticated;
drop trigger if exists task_created_emit_event_tg on public.task;
create trigger task_created_emit_event_tg after insert on public.task
  for each row execute function public.task_created_emit_event();

create or replace function public.task_assignment_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('task.assigned', new.workspace_id,
    jsonb_build_object('id', new.task_id::text || ':' || new.assignee_user_id::text,
                       'entity_type','task','entity_id', new.task_id,
                       'assignee_user_id', new.assignee_user_id, 'role', new.role,
                       'recipient_user_id', new.assignee_user_id),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.task_assignment_emit_event() from public, anon, authenticated;
drop trigger if exists task_assignment_emit_event_tg on public.task_assignment;
create trigger task_assignment_emit_event_tg after insert on public.task_assignment
  for each row execute function public.task_assignment_emit_event();

create or replace function public.task_observer_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('task.observer_added', new.workspace_id,
    jsonb_build_object('id', new.task_id::text || ':' || new.observer_user_id::text,
                       'entity_type','task','entity_id', new.task_id,
                       'observer_user_id', new.observer_user_id,
                       'recipient_user_id', new.observer_user_id),
    gen_random_uuid()::text);
  return new;
end; $$;
revoke all on function public.task_observer_emit_event() from public, anon, authenticated;
drop trigger if exists task_observer_emit_event_tg on public.task_observer;
create trigger task_observer_emit_event_tg after insert on public.task_observer
  for each row execute function public.task_observer_emit_event();
