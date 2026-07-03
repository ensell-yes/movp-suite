-- CMS Phase 4 - Part C: schedule + assets.

drop policy if exists content_schedule_rw on public.content_schedule;
create policy content_schedule_select on public.content_schedule for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_schedule_insert on public.content_schedule for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy content_schedule_update on public.content_schedule for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create index if not exists content_schedule_state_run_at_idx
  on public.content_schedule (state, run_at);

drop policy if exists asset_rw on public.asset;
create policy asset_select on public.asset for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy asset_insert on public.asset for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy asset_update on public.asset for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create index if not exists asset_r2_key_idx on public.asset (r2_key);

create or replace function public.content_schedule_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'content.scheduled',
    new.workspace_id,
    jsonb_build_object('id', new.content_item_id, 'schedule_id', new.id, 'action', new.action, 'run_at', new.run_at),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.content_schedule_emit_event() from public, anon, authenticated;

drop trigger if exists content_schedule_emit_event_tg on public.content_schedule;
create trigger content_schedule_emit_event_tg
  after insert on public.content_schedule
  for each row execute function public.content_schedule_emit_event();
