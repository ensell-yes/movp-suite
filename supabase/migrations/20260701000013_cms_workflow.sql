-- CMS Phase 4 - Part B. Capability, capability-enforcing RLS,
-- immutability guards, lifecycle emit triggers, and demote-on-edit.

create or replace function public.has_content_capability(ws uuid, cap text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when wm.role in ('owner', 'admin') then cap in ('approve', 'publish')
      else false
    end
    from public.workspace_membership wm
    where wm.workspace_id = ws and wm.user_id = (select auth.uid())
  ), false);
$$;
revoke all on function public.has_content_capability(uuid, text) from public, anon;
grant execute on function public.has_content_capability(uuid, text) to authenticated;

alter table public.content_approval_vote
  add constraint content_approval_vote_uniq unique (approval_id, voter_id);

drop policy if exists content_approval_rw on public.content_approval;
create policy content_approval_select on public.content_approval
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_approval_insert on public.content_approval
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and public.can_access_entity('content_item', content_item_id, workspace_id)
  );
create policy content_approval_update on public.content_approval
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'approve'));

drop policy if exists content_approval_vote_rw on public.content_approval_vote;
create policy content_approval_vote_select on public.content_approval_vote
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_approval_vote_insert on public.content_approval_vote
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists content_publish_event_rw on public.content_publish_event;
create policy content_publish_event_select on public.content_publish_event
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_publish_event_insert on public.content_publish_event
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and public.has_content_capability(workspace_id, 'publish')
    and public.can_access_entity('content_item', content_item_id, workspace_id)
  );

create or replace function public.content_vote_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'content_approval_vote is immutable (% not allowed)', tg_op using errcode = 'P0001';
end;
$$;
revoke all on function public.content_vote_immutable() from public, anon, authenticated;

drop trigger if exists content_vote_immutable_tg on public.content_approval_vote;
create trigger content_vote_immutable_tg
  before update or delete on public.content_approval_vote
  for each row execute function public.content_vote_immutable();

create or replace function public.content_publish_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'content_publish_event is immutable (% not allowed)', tg_op using errcode = 'P0001';
end;
$$;
revoke all on function public.content_publish_event_immutable() from public, anon, authenticated;

drop trigger if exists content_publish_event_immutable_tg on public.content_publish_event;
create trigger content_publish_event_immutable_tg
  before update or delete on public.content_publish_event
  for each row execute function public.content_publish_event_immutable();

create or replace function public.content_item_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'content.created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'content_type_id', new.content_type_id, 'status', new.status),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.content_item_created_emit_event() from public, anon, authenticated;

drop trigger if exists content_item_created_emit_event_tg on public.content_item;
create trigger content_item_created_emit_event_tg
  after insert on public.content_item
  for each row execute function public.content_item_created_emit_event();

create or replace function public.content_revision_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'content.revision_created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'content_item_id', new.content_item_id, 'content_hash', new.content_hash),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.content_revision_created_emit_event() from public, anon, authenticated;

drop trigger if exists content_revision_created_emit_event_tg on public.content_revision;
create trigger content_revision_created_emit_event_tg
  after insert on public.content_revision
  for each row execute function public.content_revision_created_emit_event();

create or replace function public.content_item_submitted_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'in_review' and new.status is distinct from old.status then
    perform public.emit_event(
      'content.submitted_for_approval',
      new.workspace_id,
      jsonb_build_object(
        'id', new.id,
        'content_type_id', new.content_type_id,
        'status', new.status,
        'actor_id', (select auth.uid())
      ),
      gen_random_uuid()::text
    );
  end if;
  return new;
end;
$$;
revoke all on function public.content_item_submitted_emit_event() from public, anon, authenticated;

drop trigger if exists content_item_submitted_emit_event_tg on public.content_item;
create trigger content_item_submitted_emit_event_tg
  after update of status on public.content_item
  for each row execute function public.content_item_submitted_emit_event();

create or replace function public.content_approval_decided_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'approved' and new.state is distinct from old.state then
    perform public.emit_event(
      'content.approved',
      new.workspace_id,
      jsonb_build_object(
        'id', new.content_item_id,
        'approval_id', new.id,
        'revision_id', new.approved_revision_id,
        'content_hash', new.approved_content_hash,
        'actor_id', new.decided_by,
        'status', 'approved'
      ),
      gen_random_uuid()::text
    );
  elsif new.state = 'rejected' and new.state is distinct from old.state then
    perform public.emit_event(
      'content.rejected',
      new.workspace_id,
      jsonb_build_object(
        'id', new.content_item_id,
        'approval_id', new.id,
        'actor_id', new.decided_by,
        'status', 'rejected'
      ),
      gen_random_uuid()::text
    );
  end if;
  return new;
end;
$$;
revoke all on function public.content_approval_decided_emit_event() from public, anon, authenticated;

drop trigger if exists content_approval_decided_emit_event_tg on public.content_approval;
create trigger content_approval_decided_emit_event_tg
  after update of state on public.content_approval
  for each row execute function public.content_approval_decided_emit_event();

create or replace function public.content_publish_event_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.action = 'publish' then
    perform public.emit_event(
      'content.published',
      new.workspace_id,
      jsonb_build_object(
        'id', new.content_item_id,
        'revision_id', new.revision_id,
        'content_hash', new.content_hash,
        'actor_id', new.actor_id,
        'status', 'published'
      ),
      gen_random_uuid()::text
    );
  elsif new.action = 'unpublish' then
    perform public.emit_event(
      'content.unpublished',
      new.workspace_id,
      jsonb_build_object(
        'id', new.content_item_id,
        'revision_id', new.revision_id,
        'content_hash', new.content_hash,
        'actor_id', new.actor_id,
        'status', 'archived'
      ),
      gen_random_uuid()::text
    );
  end if;
  return new;
end;
$$;
revoke all on function public.content_publish_event_emit_event() from public, anon, authenticated;

drop trigger if exists content_publish_event_emit_event_tg on public.content_publish_event;
create trigger content_publish_event_emit_event_tg
  after insert on public.content_publish_event
  for each row execute function public.content_publish_event_emit_event();

create or replace function public.content_demote_on_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approved uuid;
begin
  select approved_revision_id into v_approved
    from public.content_item
   where id = new.content_item_id;

  if v_approved is not null and v_approved <> new.id then
    update public.content_approval
       set state = 'superseded', decided_at = now()
     where content_item_id = new.content_item_id
       and state in ('pending', 'approved');

    update public.content_item
       set status = 'in_review'
     where id = new.content_item_id
       and status <> 'in_review';
  end if;
  return new;
end;
$$;
revoke all on function public.content_demote_on_edit() from public, anon, authenticated;

drop trigger if exists content_demote_on_edit_tg on public.content_revision;
create trigger content_demote_on_edit_tg
  after insert on public.content_revision
  for each row execute function public.content_demote_on_edit();
