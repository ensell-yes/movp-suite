-- CMS Phase 4 - Part C: curation + SEO.

alter table public.content_collection
  add constraint content_collection_ws_key_uk unique (workspace_id, key);

drop policy if exists content_collection_rw on public.content_collection;
create policy content_collection_select on public.content_collection for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_collection_insert on public.content_collection for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy content_collection_update on public.content_collection for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

alter table public.content_collection_entry
  add constraint content_collection_entry_col_item_uk unique (collection_id, content_item_id);

drop policy if exists content_collection_entry_rw on public.content_collection_entry;
create policy content_collection_entry_select on public.content_collection_entry for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_collection_entry_update on public.content_collection_entry for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy content_collection_entry_insert on public.content_collection_entry for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.content_item ci
      where ci.id = content_collection_entry.content_item_id
        and ci.workspace_id = content_collection_entry.workspace_id
        and ci.status = 'published'
    )
  );

alter table public.content_seo
  add constraint content_seo_item_uk unique (content_item_id);

drop policy if exists content_seo_rw on public.content_seo;
create policy content_seo_select on public.content_seo for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_seo_insert on public.content_seo for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy content_seo_update on public.content_seo for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
