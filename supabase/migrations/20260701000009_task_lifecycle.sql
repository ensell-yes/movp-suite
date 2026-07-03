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

-- task_notify_recipients: DISTINCT owner-assignees plus observers.
create or replace function public.task_notify_recipients(t uuid)
returns table(recipient uuid)
language sql stable security definer set search_path = '' as $$
  select ta.assignee_user_id from public.task_assignment ta
    where ta.task_id = t and ta.role = 'owner'
  union
  select o.observer_user_id from public.task_observer o
    where o.task_id = t;
$$;
revoke all on function public.task_notify_recipients(uuid) from public, anon, authenticated;

-- task_status_transition: category-keyed completed/reopened/status_changed.
create or replace function public.task_status_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  from_cat text;
  to_cat   text;
  r        record;
begin
  if new.status_id is not distinct from old.status_id then
    return new;
  end if;

  select category into from_cat from public.task_status_option where id = old.status_id;
  select category into to_cat   from public.task_status_option where id = new.status_id;

  perform public.emit_event('task.status_changed', new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type','task','entity_id', new.id,
                       'from_status_id', old.status_id, 'to_status_id', new.status_id,
                       'from_category', from_cat, 'to_category', to_cat),
    gen_random_uuid()::text);

  insert into public.task_status_history (workspace_id, task_id, from_status_id, to_status_id, changed_by)
    values (new.workspace_id, new.id, old.status_id, new.status_id, (select auth.uid()));

  if to_cat = 'done' and from_cat is distinct from 'done' then
    update public.task set completed_at = now() where id = new.id;
    for r in select recipient from public.task_notify_recipients(new.id) loop
      perform public.emit_event('task.completed', new.workspace_id,
        jsonb_build_object('id', new.id::text || ':' || r.recipient::text,
                           'entity_type','task','entity_id', new.id::text,
                           'recipient_user_id', r.recipient, 'title', new.title),
        gen_random_uuid()::text);
    end loop;
  elsif from_cat = 'done' and to_cat is distinct from 'done' then
    update public.task set completed_at = null where id = new.id;
    for r in select recipient from public.task_notify_recipients(new.id) loop
      perform public.emit_event('task.reopened', new.workspace_id,
        jsonb_build_object('id', new.id::text || ':' || r.recipient::text,
                           'entity_type','task','entity_id', new.id::text,
                           'recipient_user_id', r.recipient, 'title', new.title),
        gen_random_uuid()::text);
    end loop;
  end if;

  return new;
end; $$;
revoke all on function public.task_status_transition() from public, anon, authenticated;
drop trigger if exists task_status_transition_tg on public.task;
create trigger task_status_transition_tg
  after update of status_id on public.task
  for each row execute function public.task_status_transition();

-- recompute_task_blocked: recompute dependency_blocked; emit on false->true.
create or replace function public.recompute_task_blocked(t uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  was_blocked boolean;
  now_blocked boolean;
  ws          uuid;
  ttitle      text;
  r           record;
begin
  select dependency_blocked, workspace_id, title into was_blocked, ws, ttitle
    from public.task where id = t;
  if not found then return; end if;

  select exists (
    select 1
      from public.task_dependency d
      join public.task bt on bt.id = d.blocker_id
      join public.task_status_option so on so.id = bt.status_id
     where d.task_id = t and so.category <> 'done'
  ) into now_blocked;

  if now_blocked is distinct from was_blocked then
    update public.task set dependency_blocked = now_blocked where id = t;
    if now_blocked then
      for r in select recipient from public.task_notify_recipients(t) loop
        perform public.emit_event('task.dependency_blocked', ws,
          jsonb_build_object('id', t::text || ':' || r.recipient::text,
                             'entity_type','task','entity_id', t::text,
                             'recipient_user_id', r.recipient, 'title', ttitle),
          gen_random_uuid()::text);
      end loop;
    end if;
  end if;
end; $$;
revoke all on function public.recompute_task_blocked(uuid) from public, anon, authenticated;

create or replace function public.task_dependency_recompute()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_task_blocked(old.task_id);
    return old;
  end if;
  perform public.recompute_task_blocked(new.task_id);
  return new;
end; $$;
revoke all on function public.task_dependency_recompute() from public, anon, authenticated;
drop trigger if exists task_dependency_recompute_tg on public.task_dependency;
create trigger task_dependency_recompute_tg
  after insert or delete on public.task_dependency
  for each row execute function public.task_dependency_recompute();

create or replace function public.task_status_recompute_dependents()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct d.task_id from public.task_dependency d where d.blocker_id = new.id loop
    perform public.recompute_task_blocked(r.task_id);
  end loop;
  return new;
end; $$;
revoke all on function public.task_status_recompute_dependents() from public, anon, authenticated;
drop trigger if exists task_status_recompute_dependents_tg on public.task;
create trigger task_status_recompute_dependents_tg
  after update of status_id on public.task
  for each row execute function public.task_status_recompute_dependents();

-- emit_due_soon: notify owners+observers of tasks due within one day.
create or replace function public.emit_due_soon()
returns void language plpgsql security definer set search_path = '' as $$
declare
  t record;
  r record;
begin
  for t in
    select tk.id, tk.workspace_id, tk.title
      from public.task tk
      join public.task_status_option so on so.id = tk.status_id
     where tk.due_date is not null
       and tk.due_date <= (current_date + 1)
       and so.category <> 'done'
       and tk.due_soon_notified_at is null
  loop
    for r in select recipient from public.task_notify_recipients(t.id) loop
      perform public.emit_event('task.due_soon', t.workspace_id,
        jsonb_build_object('id', t.id::text || ':' || r.recipient::text,
                           'entity_type','task','entity_id', t.id::text,
                           'recipient_user_id', r.recipient, 'title', t.title),
        gen_random_uuid()::text);
    end loop;
    update public.task set due_soon_notified_at = now() where id = t.id;
  end loop;
end; $$;
revoke all on function public.emit_due_soon() from public, anon, authenticated;

-- DEPLOY-TIME CRON (documentation only; not applied by this migration).
-- Schedule out-of-band so `supabase db diff` stays empty and no secret is
-- committed. At deploy time, with service credentials sourced outside git:
--   select cron.schedule('task-due-soon', '*/15 * * * *', $cron$ select public.emit_due_soon(); $cron$);
-- pgTAP/e2e call `select public.emit_due_soon();` directly.
