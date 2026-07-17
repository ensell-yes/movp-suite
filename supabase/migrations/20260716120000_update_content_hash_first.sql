-- Forward-only fix (spec §4): check the effective-payload hash BEFORE the optimistic-lock revision so a
-- lost-response retry of an identical payload is idempotent instead of a false content_update_conflict.
-- Do NOT edit 20260701000012_cms_content_rpcs.sql; this create-or-replace supersedes that function body.
create or replace function public.update_content(
  p_item_id uuid,
  p_data jsonb,
  p_content_hash text,
  p_search_text text,
  p_search_body text,
  p_expected_revision_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_parent uuid;
  current_hash text;
  next_number int;
  new_rev_id uuid;
  result jsonb;
begin
  select ci.workspace_id, ci.current_revision_id, r.content_hash
    into v_ws, v_parent, current_hash
    from public.content_item ci
    left join public.content_revision r on r.id = ci.current_revision_id
   where ci.id = p_item_id;

  if v_ws is null then
    raise exception 'content item not found or inaccessible' using errcode = 'no_data_found';
  end if;

  -- Hash-first: an identical effective payload is idempotent regardless of expected-revision staleness.
  if current_hash is not null and current_hash = p_content_hash then
    update public.content_item
       set search_text = p_search_text, search_body = p_search_body
     where id = p_item_id;
    select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
    return result;
  end if;

  -- Only a DIFFERING payload on a stale base is a conflict.
  if p_expected_revision_id is not null and v_parent is distinct from p_expected_revision_id then
    raise exception 'content_update_conflict';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_number
    from public.content_revision where content_item_id = p_item_id;

  insert into public.content_revision (workspace_id, content_item_id, revision_number, data, content_hash, author_id, parent_id)
    values (v_ws, p_item_id, next_number, p_data, p_content_hash, (select auth.uid()), v_parent)
    returning id into new_rev_id;

  update public.content_item
     set current_revision_id = new_rev_id, search_text = p_search_text, search_body = p_search_body
   where id = p_item_id;

  select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
  return result;
end;
$$;
