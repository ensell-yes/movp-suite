-- Task RPCs: transactional invoker writes for internal task records.
-- Both functions run under the caller's RLS, pin search_path, and schema-qualify
-- every object. pgcrypto is installed in the extensions schema.

create or replace function public.create_task_with_revision(
  ws uuid,
  p_title text,
  p_status_id uuid,
  p_priority_id uuid,
  p_parent_id uuid,
  p_start_date date,
  p_due_date date,
  p_body text
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
begin
  insert into public.task (workspace_id, title, status_id, priority_id, parent_id, start_date, due_date)
    values (ws, p_title, p_status_id, p_priority_id, p_parent_id, p_start_date, p_due_date)
    returning id into new_task_id;

  insert into public.task_revision (workspace_id, task_id, body, content_hash, author_id)
    values (
      ws,
      new_task_id,
      coalesce(p_body, ''),
      encode(extensions.digest(coalesce(p_body, ''), 'sha256'), 'hex'),
      (select auth.uid())
    )
    returning id into new_rev_id;

  update public.task set current_revision_id = new_rev_id where id = new_task_id;

  select to_jsonb(t) into result from public.task t where t.id = new_task_id;
  return result;
end;
$$;

create or replace function public.update_task_description(
  p_task_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_hash text := encode(extensions.digest(coalesce(p_body, ''), 'sha256'), 'hex');
  v_ws uuid;
  current_hash text;
  new_rev_id uuid;
  result jsonb;
begin
  select t.workspace_id, r.content_hash
    into v_ws, current_hash
    from public.task t
    left join public.task_revision r on r.id = t.current_revision_id
   where t.id = p_task_id;

  if v_ws is null then
    raise exception 'task not found or inaccessible' using errcode = 'no_data_found';
  end if;

  if current_hash is not null and current_hash = new_hash then
    select to_jsonb(t) into result from public.task t where t.id = p_task_id;
    return result;
  end if;

  insert into public.task_revision (workspace_id, task_id, body, content_hash, author_id)
    values (v_ws, p_task_id, coalesce(p_body, ''), new_hash, (select auth.uid()))
    returning id into new_rev_id;

  update public.task set current_revision_id = new_rev_id where id = p_task_id;

  select to_jsonb(t) into result from public.task t where t.id = p_task_id;
  return result;
end;
$$;

revoke all on function public.create_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text) from public, anon;
revoke all on function public.update_task_description(uuid, text) from public, anon;
grant execute on function public.create_task_with_revision(uuid, text, uuid, uuid, uuid, date, date, text) to authenticated;
grant execute on function public.update_task_description(uuid, text) to authenticated;
