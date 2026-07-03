-- CMS Phase 4 - Part B RPCs. SECURITY INVOKER so capability RLS stays in force.

create or replace function public.submit_for_approval(
  p_item_id uuid,
  p_policy text default 'single',
  p_approvals_required int default 1
)
returns public.content_item
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_item public.content_item;
begin
  select workspace_id into v_ws from public.content_item where id = p_item_id;
  if v_ws is null then
    raise exception 'content_item_not_found' using errcode = 'P0002';
  end if;

  insert into public.content_approval (workspace_id, content_item_id, state, policy, approvals_required)
    values (v_ws, p_item_id, 'pending', p_policy, coalesce(p_approvals_required, 1));

  update public.content_item
     set status = 'in_review'
   where id = p_item_id
   returning * into v_item;
  return v_item;
end;
$$;
revoke all on function public.submit_for_approval(uuid, text, int) from public, anon;
grant execute on function public.submit_for_approval(uuid, text, int) to authenticated;

create or replace function public.decide_approval(p_approval_id uuid, p_vote text)
returns public.content_approval
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_appr public.content_approval;
  v_uid uuid := (select auth.uid());
  v_approve_count int;
  v_rev uuid;
  v_hash text;
begin
  select * into v_appr from public.content_approval where id = p_approval_id;
  if v_appr.id is null then
    raise exception 'approval_not_found' using errcode = 'P0002';
  end if;

  insert into public.content_approval_vote (workspace_id, approval_id, voter_id, vote)
    values (v_appr.workspace_id, p_approval_id, v_uid, p_vote);

  if p_vote = 'reject' then
    update public.content_approval
       set state = 'rejected', decided_at = now(), decided_by = v_uid
     where id = p_approval_id
     returning * into v_appr;
    return v_appr;
  end if;

  select count(distinct voter_id) into v_approve_count
    from public.content_approval_vote
   where approval_id = p_approval_id
     and vote = 'approve';

  if (v_appr.policy = 'single' and v_approve_count >= 1)
     or (v_appr.policy in ('multi', 'moderation') and v_approve_count >= v_appr.approvals_required) then
    select current_revision_id into v_rev from public.content_item where id = v_appr.content_item_id;
    select content_hash into v_hash from public.content_revision where id = v_rev;

    update public.content_approval
       set state = 'approved',
           decided_at = now(),
           decided_by = v_uid,
           approved_revision_id = v_rev,
           approved_content_hash = v_hash
     where id = p_approval_id
     returning * into v_appr;

    update public.content_item
       set status = 'approved',
           approved_revision_id = v_rev
     where id = v_appr.content_item_id;
  end if;

  return v_appr;
end;
$$;
revoke all on function public.decide_approval(uuid, text) from public, anon;
grant execute on function public.decide_approval(uuid, text) to authenticated;

create or replace function public.publish_content(p_item_id uuid)
returns public.content_item
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item public.content_item;
  v_ws uuid;
  v_rev uuid;
  v_hash text;
  v_uid uuid := (select auth.uid());
begin
  select workspace_id, coalesce(approved_revision_id, current_revision_id)
    into v_ws, v_rev
    from public.content_item
   where id = p_item_id;
  if v_ws is null then
    raise exception 'content_item_not_found' using errcode = 'P0002';
  end if;
  if v_rev is null then
    raise exception 'content_no_revision' using errcode = 'P0001';
  end if;

  select content_hash into v_hash from public.content_revision where id = v_rev;
  insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values (v_ws, p_item_id, 'publish', v_rev, v_hash, v_uid);

  update public.content_item
     set status = 'published',
         published_revision_id = v_rev,
         published_at = now()
   where id = p_item_id
   returning * into v_item;
  return v_item;
end;
$$;
revoke all on function public.publish_content(uuid) from public, anon;
grant execute on function public.publish_content(uuid) to authenticated;

create or replace function public.unpublish_content(p_item_id uuid)
returns public.content_item
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item public.content_item;
  v_ws uuid;
  v_rev uuid;
  v_hash text;
  v_uid uuid := (select auth.uid());
begin
  select workspace_id, published_revision_id
    into v_ws, v_rev
    from public.content_item
   where id = p_item_id;
  if v_ws is null then
    raise exception 'content_item_not_found' using errcode = 'P0002';
  end if;
  if v_rev is null then
    raise exception 'content_not_published' using errcode = 'P0001';
  end if;

  select content_hash into v_hash from public.content_revision where id = v_rev;
  insert into public.content_publish_event (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values (v_ws, p_item_id, 'unpublish', v_rev, v_hash, v_uid);

  update public.content_item
     set status = 'archived',
         published_revision_id = null
   where id = p_item_id
   returning * into v_item;
  return v_item;
end;
$$;
revoke all on function public.unpublish_content(uuid) from public, anon;
grant execute on function public.unpublish_content(uuid) to authenticated;
