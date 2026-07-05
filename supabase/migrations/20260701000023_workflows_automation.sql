-- Domain Workflows Phase 7 - Part B: automation engine.

create or replace function public.get_event(ev_id uuid, ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event movp_internal.movp_events%rowtype;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_workspace_member(ws) then
    return null;
  end if;

  select *
    into v_event
    from movp_internal.movp_events
   where id = ev_id
     and workspace_id = ws;

  if not found then
    return null;
  end if;

  v_payload := v_event.payload;
  if coalesce(auth.role(), '') <> 'service_role' then
    v_payload := v_payload - 'email';
  end if;

  return jsonb_build_object(
    'id', v_event.id,
    'type', v_event.type,
    'workspace_id', v_event.workspace_id,
    'payload', v_payload,
    'trace_id', v_event.trace_id,
    'created_at', v_event.created_at
  );
end;
$$;

revoke all on function public.get_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_event(uuid, uuid) to authenticated, service_role;

create or replace function public.workflow_webhook_for_action(sub_id uuid, ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  select w.url, w.secret
    into v_row
    from public.webhook_subscription s
    join movp_internal.webhooks w
      on w.id = s.internal_webhook_id
     and w.workspace_id = s.workspace_id
   where s.id = sub_id
     and s.workspace_id = ws
     and s.active
     and w.active;

  if not found then
    return null;
  end if;

  return jsonb_build_object('url', v_row.url, 'secret', v_row.secret);
end;
$$;

revoke all on function public.workflow_webhook_for_action(uuid, uuid) from public, anon, authenticated;
grant execute on function public.workflow_webhook_for_action(uuid, uuid) to service_role;

create unique index if not exists movp_events_workflow_dedupe_unique
  on movp_internal.movp_events ((payload->>'workflow_dedupe'))
  where payload ? 'workflow_dedupe';

create or replace function public.workflow_emit_event(ev_type text, ws uuid, payload jsonb, trace text, dedupe_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if dedupe_key is null or length(dedupe_key) = 0 then
    raise exception 'workflow dedupe key is required' using errcode = '23514';
  end if;

  begin
    perform public.emit_event(
      ev_type,
      ws,
      coalesce(payload, '{}'::jsonb) || jsonb_build_object('workflow_dedupe', dedupe_key),
      trace
    );
  exception when unique_violation then
    return;
  end;
end;
$$;

revoke all on function public.workflow_emit_event(text, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.workflow_emit_event(text, uuid, jsonb, text, text) to service_role;

alter table public.task
  add column if not exists workflow_idempotency_key text;

create unique index if not exists task_workflow_idempotency_key_unique
  on public.task (workspace_id, workflow_idempotency_key)
  where workflow_idempotency_key is not null;

alter table public.automation_rule
  add constraint automation_rule_condition_object
  check (jsonb_typeof(condition) = 'object');

alter table public.automation_rule
  add constraint automation_rule_action_config_object
  check (jsonb_typeof(action_config) = 'object');

create or replace function public.seed_workflow_default_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.automation_rule
    (workspace_id, trigger_event_type_id, condition, action_type, action_config, enabled, priority)
  select
    new.id,
    et.id,
    '{}'::jsonb,
    seed.action_type,
    seed.action_config,
    false,
    seed.priority
  from (values
    ('deliverable.due_soon', 'create_task', '{"title":"Follow up deliverable"}'::jsonb, 100),
    ('content.approved', 'advance_deliverable', '{"deliverableId":"$event.deliverable_id"}'::jsonb, 110),
    ('segment.membership_changed', 'recompute_segment', '{"segmentId":"$event.entity_id"}'::jsonb, 120)
  ) as seed(event_key, action_type, action_config, priority)
  join public.event_type et on et.key = seed.event_key
  where not exists (
    select 1
      from public.automation_rule ar
     where ar.workspace_id = new.id
       and ar.trigger_event_type_id = et.id
       and ar.action_type = seed.action_type
       and ar.action_config = seed.action_config
  );

  return new;
end;
$$;

revoke all on function public.seed_workflow_default_rules() from public, anon, authenticated;

drop trigger if exists workspace_seed_workflow_rules_tg on public.workspace;
create trigger workspace_seed_workflow_rules_tg
  after insert on public.workspace
  for each row execute function public.seed_workflow_default_rules();

create or replace function public.create_workflow_task_with_revision(
  ws uuid,
  p_title text,
  p_status_id uuid,
  p_priority_id uuid,
  p_parent_id uuid,
  p_start_date date,
  p_due_date date,
  p_body text,
  p_idempotency_key text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_task_id uuid;
  new_rev_id uuid;
  result jsonb;
  v_actor uuid := coalesce(p_actor_id, (select auth.uid()));
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'workflow idempotency key is required' using errcode = '23514';
  end if;

  if v_actor is null then
    raise exception 'task actor is required' using errcode = '23514';
  end if;

  select to_jsonb(t)
    into result
    from public.task t
   where t.workspace_id = ws
     and t.workflow_idempotency_key = p_idempotency_key;
  if result is not null then
    return result;
  end if;

  insert into public.task (workspace_id, title, status_id, priority_id, parent_id, start_date, due_date, workflow_idempotency_key)
    values (ws, p_title, p_status_id, p_priority_id, p_parent_id, p_start_date, p_due_date, p_idempotency_key)
    returning id into new_task_id;

  insert into public.task_revision (workspace_id, task_id, body, content_hash, author_id)
    values (
      ws,
      new_task_id,
      coalesce(p_body, ''),
      encode(extensions.digest(coalesce(p_body, ''), 'sha256'), 'hex'),
      v_actor
    )
    returning id into new_rev_id;

  update public.task set current_revision_id = new_rev_id where id = new_task_id;

  select to_jsonb(t) into result from public.task t where t.id = new_task_id;
  return result;
end;
$$;

revoke all on function public.create_workflow_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_workflow_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text, text, uuid) to service_role;
