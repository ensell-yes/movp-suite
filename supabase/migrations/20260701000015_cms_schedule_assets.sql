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

create or replace function public.claim_due_schedules(lim int default 50)
returns setof public.content_schedule
language sql
security definer
set search_path = ''
as $$
  update public.content_schedule
     set state = 'fired'
   where id in (
     select id from public.content_schedule
      where state = 'scheduled'
        and run_at <= now()
      order by run_at
      for update skip locked
      limit lim
   )
  returning *;
$$;
revoke all on function public.claim_due_schedules(int) from public, anon, authenticated;

create or replace function public.run_scheduled_publish(schedule_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.content_schedule;
  v_hash text;
begin
  select * into s from public.content_schedule where id = schedule_id for update;
  if not found or s.state <> 'fired' then
    return;
  end if;

  select cr.content_hash into v_hash from public.content_revision cr where cr.id = s.revision_id;
  if v_hash is null then
    raise exception 'content_revision_not_found' using errcode = 'P0002';
  end if;

  insert into public.content_publish_event
    (workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values (s.workspace_id, s.content_item_id, s.action, s.revision_id, v_hash, s.scheduled_by);

  if s.action = 'publish' then
    update public.content_item
       set status = 'published',
           published_revision_id = s.revision_id
     where id = s.content_item_id;
  else
    update public.content_item
       set status = 'archived',
           published_revision_id = null
     where id = s.content_item_id;
  end if;
end;
$$;
revoke all on function public.run_scheduled_publish(uuid) from public, anon, authenticated;
