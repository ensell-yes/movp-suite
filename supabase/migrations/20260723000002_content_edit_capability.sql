-- C7.4: privileged CMS authoring capability and exact write-policy matrix.

create or replace function public.has_content_capability(ws uuid, cap text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when wm.role in ('owner', 'admin') then cap in ('edit', 'approve', 'publish')
      else false
    end
    from public.workspace_membership wm
    where wm.workspace_id = ws
      and wm.user_id = (select auth.uid())
  ), false);
$$;
revoke all on function public.has_content_capability(uuid, text) from public, anon;
grant execute on function public.has_content_capability(uuid, text) to authenticated;

create or replace function movp_internal.guard_content_publication_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  is_system_demotion boolean := false;
begin
  -- Internal/service-role workflows have no auth.uid() and own their separate caller checks.
  if (select auth.uid()) is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if (
      new.approved_revision_id is not null
      or new.status = 'approved'
    ) and not public.has_content_capability(new.workspace_id, 'approve') then
      raise exception 'content_approve_forbidden' using errcode = '42501';
    end if;

    if (
      new.published_revision_id is not null
      or new.published_at is not null
      or new.status in ('published', 'archived')
    ) and not public.has_content_capability(new.workspace_id, 'publish') then
      raise exception 'content_publish_forbidden' using errcode = '42501';
    end if;

    return new;
  end if;

  is_system_demotion :=
    pg_trigger_depth() > 1
    and old.status = 'published'
    and new.status = 'in_review'
    and new.approved_revision_id is not distinct from old.approved_revision_id
    and new.published_revision_id is not distinct from old.published_revision_id
    and new.published_at is not distinct from old.published_at;

  if (
    new.approved_revision_id is distinct from old.approved_revision_id
    or (new.status = 'approved' and new.status is distinct from old.status)
  ) and not public.has_content_capability(new.workspace_id, 'approve') then
    raise exception 'content_approve_forbidden' using errcode = '42501';
  end if;

  if (
    new.published_revision_id is distinct from old.published_revision_id
    or new.published_at is distinct from old.published_at
    or (
      new.status in ('published', 'archived')
      and new.status is distinct from old.status
    )
    or (
      old.status in ('published', 'archived')
      and new.status not in ('published', 'archived')
      and not is_system_demotion
    )
  ) and not public.has_content_capability(new.workspace_id, 'publish') then
    raise exception 'content_publish_forbidden' using errcode = '42501';
  end if;

  return new;
end;
$$;
revoke all on function movp_internal.guard_content_publication_transition()
  from public, anon, authenticated;

drop trigger if exists content_item_publication_transition_guard_tg
  on public.content_item;
create trigger content_item_publication_transition_guard_tg
  before insert or update on public.content_item
  for each row execute function movp_internal.guard_content_publication_transition();

drop policy if exists content_type_rw on public.content_type;
drop policy if exists content_type_select on public.content_type;
drop policy if exists content_type_edit_insert on public.content_type;
drop policy if exists content_type_edit_update on public.content_type;
drop policy if exists content_type_edit_delete on public.content_type;
create policy content_type_select on public.content_type
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_type_edit_insert on public.content_type
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'edit'));
create policy content_type_edit_update on public.content_type
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'edit'));
-- DELETE has no WITH CHECK phase; unauthorized rows therefore remain invisible.
create policy content_type_edit_delete on public.content_type
  for delete to authenticated
  using (public.has_content_capability(workspace_id, 'edit'));

drop policy if exists content_item_rw on public.content_item;
drop policy if exists content_item_select on public.content_item;
drop policy if exists content_item_edit_insert on public.content_item;
drop policy if exists content_item_edit_update on public.content_item;
drop policy if exists content_item_edit_delete on public.content_item;
create policy content_item_select on public.content_item
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_item_edit_insert on public.content_item
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'edit'));
create policy content_item_edit_update on public.content_item
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'edit'));
-- DELETE has no WITH CHECK phase; unauthorized rows therefore remain invisible.
create policy content_item_edit_delete on public.content_item
  for delete to authenticated
  using (public.has_content_capability(workspace_id, 'edit'));

drop policy if exists content_revision_insert on public.content_revision;
drop policy if exists content_revision_edit_insert on public.content_revision;
create policy content_revision_edit_insert on public.content_revision
  for insert to authenticated
  with check (
    public.has_content_capability(workspace_id, 'edit')
    and author_id = (select auth.uid())
  );

drop policy if exists content_approval_insert on public.content_approval;
drop policy if exists content_approval_update on public.content_approval;
drop policy if exists content_approval_edit_insert on public.content_approval;
drop policy if exists content_approval_approve_update on public.content_approval;
create policy content_approval_edit_insert on public.content_approval
  for insert to authenticated
  with check (
    public.has_content_capability(workspace_id, 'edit')
    and public.can_access_entity('content_item', content_item_id, workspace_id)
  );
create policy content_approval_approve_update on public.content_approval
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'approve'));

drop policy if exists content_approval_vote_insert on public.content_approval_vote;
drop policy if exists content_approval_vote_approve_insert on public.content_approval_vote;
create policy content_approval_vote_approve_insert on public.content_approval_vote
  for insert to authenticated
  with check (
    public.has_content_capability(workspace_id, 'approve')
    and voter_id = (select auth.uid())
  );

drop policy if exists content_publish_event_insert on public.content_publish_event;
drop policy if exists content_publish_event_publish_insert on public.content_publish_event;
create policy content_publish_event_publish_insert on public.content_publish_event
  for insert to authenticated
  with check (
    public.has_content_capability(workspace_id, 'publish')
    and public.can_access_entity('content_item', content_item_id, workspace_id)
    and actor_id = (select auth.uid())
  );

drop policy if exists content_schedule_insert on public.content_schedule;
drop policy if exists content_schedule_update on public.content_schedule;
drop policy if exists content_schedule_publish_insert on public.content_schedule;
drop policy if exists content_schedule_publish_update on public.content_schedule;
create policy content_schedule_publish_insert on public.content_schedule
  for insert to authenticated
  with check (
    public.has_content_capability(workspace_id, 'publish')
    and scheduled_by = (select auth.uid())
  );
create policy content_schedule_publish_update on public.content_schedule
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'publish'));

drop policy if exists asset_insert on public.asset;
drop policy if exists asset_update on public.asset;
drop policy if exists asset_edit_insert on public.asset;
drop policy if exists asset_edit_update on public.asset;
create policy asset_edit_insert on public.asset
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'edit'));
create policy asset_edit_update on public.asset
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'edit'));

drop policy if exists content_collection_insert on public.content_collection;
drop policy if exists content_collection_update on public.content_collection;
drop policy if exists content_collection_edit_insert on public.content_collection;
drop policy if exists content_collection_edit_update on public.content_collection;
create policy content_collection_edit_insert on public.content_collection
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'edit'));
create policy content_collection_edit_update on public.content_collection
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'edit'));

drop policy if exists content_collection_entry_insert
  on public.content_collection_entry;
drop policy if exists content_collection_entry_update
  on public.content_collection_entry;
drop policy if exists content_collection_entry_edit_insert
  on public.content_collection_entry;
drop policy if exists content_collection_entry_edit_update
  on public.content_collection_entry;
create policy content_collection_entry_edit_insert
  on public.content_collection_entry
  for insert to authenticated
  with check (
    public.has_content_capability(workspace_id, 'edit')
    and exists (
      select 1
      from public.content_item ci
      where ci.id = content_collection_entry.content_item_id
        and ci.workspace_id = content_collection_entry.workspace_id
        and ci.status = 'published'
    )
  );
create policy content_collection_entry_edit_update
  on public.content_collection_entry
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'edit'));

drop policy if exists content_seo_insert on public.content_seo;
drop policy if exists content_seo_update on public.content_seo;
drop policy if exists content_seo_edit_insert on public.content_seo;
drop policy if exists content_seo_edit_update on public.content_seo;
create policy content_seo_edit_insert on public.content_seo
  for insert to authenticated
  with check (public.has_content_capability(workspace_id, 'edit'));
create policy content_seo_edit_update on public.content_seo
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.has_content_capability(workspace_id, 'edit'));

drop policy if exists edges_rw on public.edges;
drop policy if exists edges_select on public.edges;
drop policy if exists edges_content_edit_insert on public.edges;
drop policy if exists edges_content_edit_update on public.edges;
drop policy if exists edges_content_edit_delete on public.edges;
create policy edges_select on public.edges
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy edges_content_edit_insert on public.edges
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (
      src_type <> 'content_item'
      or public.has_content_capability(workspace_id, 'edit')
    )
  );
create policy edges_content_edit_update on public.edges
  for update to authenticated
  -- Unlike ordinary CMS rows, the old edge direction is itself authorization state.
  using (
    public.is_workspace_member(workspace_id)
    and (
      src_type <> 'content_item'
      or public.has_content_capability(workspace_id, 'edit')
    )
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (
      src_type <> 'content_item'
      or public.has_content_capability(workspace_id, 'edit')
    )
  );
create policy edges_content_edit_delete on public.edges
  for delete to authenticated
  -- DELETE has no WITH CHECK phase, so the directional predicate must remain in USING.
  using (
    public.is_workspace_member(workspace_id)
    and (
      src_type <> 'content_item'
      or public.has_content_capability(workspace_id, 'edit')
    )
  );
