-- Make workflow task idempotency available to authenticated agents without
-- allowing callers to forge revision authorship.

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
  v_actor uuid := case
    when current_user = 'service_role' then coalesce(p_actor_id, (select auth.uid()))
    else (select auth.uid())
  end;
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

revoke all on function public.create_workflow_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_workflow_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text, text, uuid)
  to service_role, authenticated;
