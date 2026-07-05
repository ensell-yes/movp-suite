-- Segmentation Phase 6 — Part A. Numbered to sort AFTER all prior phase migrations
-- (20260701000001 .. 000018); the only FUNCTIONAL prerequisite is Core's movp_events + emit_event
-- (F7). Hand-authored: the two platform_event reporting indexes, the append-only guards (a 2F004
-- immutability trigger on platform_event; RLS-only SELECT+INSERT on segment_snapshot_member — no
-- trigger, so a parent cascade delete is not aborted, F3), the segment_membership uniqueness
-- constraint, and the guarded internal event bridge that mirrors allow-listed
-- movp_internal.movp_events rows into public.platform_event without aborting the caller (F1).

create index if not exists platform_event_subject_idx
  on public.platform_event (workspace_id, subject_ref, event_type, occurred_at);
create index if not exists platform_event_type_time_idx
  on public.platform_event (workspace_id, event_type, occurred_at);

drop policy if exists platform_event_rw on public.platform_event;
create policy platform_event_select on public.platform_event
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy platform_event_insert on public.platform_event
  for insert to authenticated with check (public.is_workspace_member(workspace_id));

create or replace function public.platform_event_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'platform_event is append-only and immutable' using errcode = '2F004';
end;
$$;
revoke all on function public.platform_event_immutable() from public, anon, authenticated;
drop trigger if exists platform_event_no_mutate on public.platform_event;
create trigger platform_event_no_mutate
  before update or delete on public.platform_event
  for each row execute function public.platform_event_immutable();

drop policy if exists segment_snapshot_member_rw on public.segment_snapshot_member;
create policy segment_snapshot_member_select on public.segment_snapshot_member
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy segment_snapshot_member_insert on public.segment_snapshot_member
  for insert to authenticated with check (public.is_workspace_member(workspace_id));

alter table public.segment_membership
  drop constraint if exists segment_membership_segment_subject_key;
alter table public.segment_membership
  add constraint segment_membership_segment_subject_key unique (segment_id, subject_ref);

create table if not exists movp_internal.segmentation_bridged_type (
  event_type text primary key
);
alter table movp_internal.segmentation_bridged_type enable row level security;
revoke all on movp_internal.segmentation_bridged_type from anon, authenticated;
grant all on movp_internal.segmentation_bridged_type to service_role;
insert into movp_internal.segmentation_bridged_type (event_type) values
  ('account.created'), ('registration.completed'), ('onboarding.completed')
  on conflict (event_type) do nothing;

-- CONTENT DISCIPLINE (allow-listing a type is a data-exposure decision): the bridge copies the
-- WHOLE internal event payload into public.platform_event.properties, which is MEMBER-READABLE.
-- Allow-listed lifecycle payloads must therefore stay ids/classifiers only (no emails, no free
-- text) — enforce that at the emitter before adding a type to segmentation_bridged_type.
create or replace function movp_internal.bridge_event_to_platform()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_subject_ref text := coalesce(new.payload->>'subject_ref', new.payload->>'id');
begin
  if new.workspace_id is not null
     and v_subject_ref is not null
     and exists (
       select 1 from movp_internal.segmentation_bridged_type t
       where t.event_type = new.type
     )
  then
    -- DEFENSE-IN-DEPTH: the mirror insert must NEVER abort the emitting business write. Today no
    -- payload value can make it raise (subject_type/subject_ref/actor_ref are unconstrained text;
    -- source is hardcoded to the valid 'internal'), but a FUTURE check/not-null/FK added to
    -- platform_event would otherwise become a dormant abort bomb inside every allow-listed
    -- emitter's transaction. Narrowed to data-shape errors (the schema-drift vectors) — a
    -- genuinely unexpected fault still surfaces; the mirror is best-effort by design
    -- (platform_event is at-least-once and dedup-safe downstream, 04a F6).
    begin
      insert into public.platform_event (
        workspace_id, event_type, subject_type, subject_ref, actor_ref,
        source, properties, occurred_at, ingested_at
      ) values (
        new.workspace_id,
        new.type,
        coalesce(new.payload->>'subject_type', new.payload->>'entity_type', 'user'),
        v_subject_ref,
        new.payload->>'actor_ref',
        'internal',
        new.payload,
        new.created_at,
        now()
      );
    exception
      when check_violation or not_null_violation or foreign_key_violation
        or string_data_right_truncation or invalid_text_representation then
        -- names/codes only — never payload values.
        raise warning 'segmentation bridge skipped event type % (sqlstate %)', new.type, sqlstate;
    end;
  end if;
  return new;
end;
$$;
revoke all on function movp_internal.bridge_event_to_platform() from public, anon, authenticated;
drop trigger if exists bridge_event_to_platform_tg on movp_internal.movp_events;
create trigger bridge_event_to_platform_tg
  after insert on movp_internal.movp_events
  for each row execute function movp_internal.bridge_event_to_platform();
