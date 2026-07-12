-- C5a.3 external_record guards: immutable external identity, no generic deletion, and
-- payload-change-only event emission. The generated delta owns the event_type catalog row.

alter table public.external_record
  add constraint external_record_identity_uk unique (workspace_id, source, external_id);

-- The generated collection policy grants FOR ALL. Replace it here so no generic DELETE path remains.
drop policy if exists external_record_rw on public.external_record;
create policy external_record_select on public.external_record
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy external_record_insert on public.external_record
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy external_record_update on public.external_record
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create or replace function public.external_record_identity_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.source is distinct from old.source
     or new.external_id is distinct from old.external_id then
    raise exception 'external_ref_identity_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.external_record_identity_immutable() from public, anon, authenticated;

drop trigger if exists external_record_identity_tg on public.external_record;
create trigger external_record_identity_tg
  before update on public.external_record
  for each row execute function public.external_record_identity_immutable();

create or replace function public.external_record_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'external.record.upserted',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'source', new.source, 'external_id', new.external_id),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.external_record_emit_event() from public, anon, authenticated;

drop trigger if exists external_record_emit_insert_tg on public.external_record;
create trigger external_record_emit_insert_tg
  after insert on public.external_record
  for each row execute function public.external_record_emit_event();

drop trigger if exists external_record_emit_update_tg on public.external_record;
create trigger external_record_emit_update_tg
  after update on public.external_record
  for each row when (old.payload is distinct from new.payload)
  execute function public.external_record_emit_event();
