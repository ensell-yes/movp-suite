-- CMS content RPCs: SECURITY INVOKER writes that run under the caller's RLS.
-- content_hash is computed by the domain service and passed as a parameter.

create or replace function public.create_content_with_revision(
  ws uuid,
  p_content_type_id uuid,
  p_slug text,
  p_data jsonb,
  p_content_hash text,
  p_search_text text,
  p_search_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_item_id uuid;
  new_rev_id uuid;
  result jsonb;
begin
  insert into public.content_item (workspace_id, content_type_id, slug, status, search_text, search_body)
    values (ws, p_content_type_id, p_slug, 'draft', p_search_text, p_search_body)
    returning id into new_item_id;

  insert into public.content_revision (workspace_id, content_item_id, revision_number, data, content_hash, author_id)
    values (ws, new_item_id, 1, p_data, p_content_hash, (select auth.uid()))
    returning id into new_rev_id;

  update public.content_item set current_revision_id = new_rev_id where id = new_item_id;

  select to_jsonb(ci) into result from public.content_item ci where ci.id = new_item_id;
  return result;
end;
$$;

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

  if p_expected_revision_id is not null and v_parent is distinct from p_expected_revision_id then
    raise exception 'content_update_conflict' using errcode = '40001';
  end if;

  if current_hash is not null and current_hash = p_content_hash then
    update public.content_item
       set search_text = p_search_text, search_body = p_search_body
     where id = p_item_id;
    select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
    return result;
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

revoke all on function public.create_content_with_revision(uuid, uuid, text, jsonb, text, text, text) from public, anon;
revoke all on function public.update_content(uuid, jsonb, text, text, text, uuid) from public, anon;
grant execute on function public.create_content_with_revision(uuid, uuid, text, jsonb, text, text, text) to authenticated;
grant execute on function public.update_content(uuid, jsonb, text, text, text, uuid) to authenticated;
