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
