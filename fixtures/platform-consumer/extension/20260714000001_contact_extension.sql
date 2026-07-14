-- Project extension fixture: a `contact` collection tagged layer='project'.
-- Byte shape of the metadata upserts mirrors emit-sql.ts collectionMetadataSql for a project layer.
create table if not exists public.contact (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  full_name text not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.contact enable row level security;
grant select, insert, update, delete on public.contact to authenticated;
grant select, insert, update, delete on public.contact to service_role;
create policy contact_rw on public.contact for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

insert into public.movp_collections (name, label, label_plural, workspace_scoped, layer)
values ('contact', 'Contact', 'Contacts', true, 'project')
on conflict (name) do update set label = excluded.label, label_plural = excluded.label_plural, workspace_scoped = excluded.workspace_scoped, layer = excluded.layer;

insert into public.movp_fields (collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer)
values
  ('contact', 'full_name', 'text', 'Full name', null, null, false, false, 'project'),
  ('contact', 'email', 'text', 'Email', null, null, false, false, 'project')
on conflict (collection_name, name) do update set
  type = excluded.type,
  label = excluded.label,
  cardinality = excluded.cardinality,
  reporting_role = excluded.reporting_role,
  searchable = excluded.searchable,
  embeddable = excluded.embeddable,
  layer = excluded.layer;
