-- Domain Workflows Phase 7 - Part B: automation engine.

create or replace function public.get_event(ev_id uuid, ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event movp_internal.movp_events%rowtype;
begin
  if not public.is_workspace_member(ws) then
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

  return jsonb_build_object(
    'id', v_event.id,
    'type', v_event.type,
    'workspace_id', v_event.workspace_id,
    'payload', v_event.payload,
    'trace_id', v_event.trace_id,
    'created_at', v_event.created_at
  );
end;
$$;

revoke all on function public.get_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_event(uuid, uuid) to authenticated, service_role;

alter table public.task
  add column if not exists workflow_idempotency_key text;

create unique index if not exists task_workflow_idempotency_key_unique
  on public.task (workspace_id, workflow_idempotency_key)
  where workflow_idempotency_key is not null;

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
