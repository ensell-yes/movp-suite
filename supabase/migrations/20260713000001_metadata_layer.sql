-- Stage C6a: add the platform/project tier marker to schema metadata.
-- Forward-only (new file). `add column ... not null default 'platform'` backfills every existing
-- row to 'platform'; the check constraint pins the allowed values.
alter table public.movp_collections
  add column if not exists layer text not null default 'platform';
alter table public.movp_collections
  add constraint movp_collections_layer_check check (layer in ('platform', 'project'));

alter table public.movp_fields
  add column if not exists layer text not null default 'platform';
alter table public.movp_fields
  add constraint movp_fields_layer_check check (layer in ('platform', 'project'));
