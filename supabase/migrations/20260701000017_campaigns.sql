-- Campaigns Phase 5 — Part A. Sorts AFTER all Core/Collaboration/Task/CMS migrations
-- (20260701000001 .. 000016). Hand-authored: the two audit-only lifecycle triggers, then
-- the owner-restricted edit-gating RLS overrides on campaign/marketing_plan.

-- ── audit-only lifecycle events ──────────────────────────────────────────────
-- Mirrors public.note_created_emit_event (20260701000005): hardened SECURITY DEFINER,
-- pinned empty search_path, fully schema-qualified. Payload carries IDS/CLASSIFIERS ONLY
-- and NO recipient_user_id/email, so the guarded public.emit_event (Task phase, 000009)
-- records the row in movp_internal.movp_events and fans out any webhook, but enqueues NO
-- 'notify' job. Do NOT re-declare emit_event here.
create or replace function public.campaign_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'campaign.created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type', 'campaign', 'entity_id', new.id, 'status', new.status, 'marketing_plan_id', new.marketing_plan_id),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
drop trigger if exists campaign_created_emit_event_tg on public.campaign;
create trigger campaign_created_emit_event_tg
  after insert on public.campaign
  for each row execute function public.campaign_created_emit_event();
revoke all on function public.campaign_created_emit_event() from public, anon, authenticated;

create or replace function public.campaign_deliverable_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'deliverable.created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'entity_type', 'campaign_deliverable', 'entity_id', new.id, 'campaign_id', new.campaign_id, 'deliverable_type', new.deliverable_type),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
drop trigger if exists campaign_deliverable_created_emit_event_tg on public.campaign_deliverable;
create trigger campaign_deliverable_created_emit_event_tg
  after insert on public.campaign_deliverable
  for each row execute function public.campaign_deliverable_created_emit_event();
revoke all on function public.campaign_deliverable_created_emit_event() from public, anon, authenticated;

-- ── edit-gating RLS overrides (owner-restricted writes) ──────────────────────
-- The five other campaign tables KEEP their generated blanket <name>_rw
-- (is_workspace_member) policy — only campaign and marketing_plan are owner-gated.
-- All members SELECT/INSERT; UPDATE/DELETE restricted to the row's owner. Uses the
-- network-verified principal via (select auth.uid()); is_workspace_member is the base gate.
-- Policy predicates qualify columns with the table name to avoid ambiguity with the
-- correlated marketing_plan subquery.

drop policy if exists campaign_rw on public.campaign;
create policy campaign_select on public.campaign for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy campaign_insert on public.campaign for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy campaign_update on public.campaign for update to authenticated
  using (
    public.is_workspace_member(campaign.workspace_id)
    and (
      campaign.owner_id = (select auth.uid())
      or exists (
        select 1 from public.marketing_plan mp
        where mp.id = campaign.marketing_plan_id
          and mp.owner_id = (select auth.uid())
      )
    )
  )
  with check (
    public.is_workspace_member(campaign.workspace_id)
    and (
      campaign.owner_id = (select auth.uid())
      or exists (
        select 1 from public.marketing_plan mp
        where mp.id = campaign.marketing_plan_id
          and mp.owner_id = (select auth.uid())
      )
    )
  );
create policy campaign_delete on public.campaign for delete to authenticated
  using (
    public.is_workspace_member(campaign.workspace_id)
    and (
      campaign.owner_id = (select auth.uid())
      or exists (
        select 1 from public.marketing_plan mp
        where mp.id = campaign.marketing_plan_id
          and mp.owner_id = (select auth.uid())
      )
    )
  );

drop policy if exists marketing_plan_rw on public.marketing_plan;
create policy marketing_plan_select on public.marketing_plan for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy marketing_plan_insert on public.marketing_plan for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy marketing_plan_update on public.marketing_plan for update to authenticated
  using (
    public.is_workspace_member(marketing_plan.workspace_id)
    and marketing_plan.owner_id = (select auth.uid())
  )
  with check (
    public.is_workspace_member(marketing_plan.workspace_id)
    and marketing_plan.owner_id = (select auth.uid())
  );
create policy marketing_plan_delete on public.marketing_plan for delete to authenticated
  using (
    public.is_workspace_member(marketing_plan.workspace_id)
    and marketing_plan.owner_id = (select auth.uid())
  );

-- ── F1: same-workspace FK integrity on campaign children ─────────────────────
-- Postgres FKs are workspace-blind, and the five child tables keep the blanket
-- is_workspace_member(workspace_id) write policy, so a member of workspace B could insert a
-- B-child (workspace_id=B) that references a parent (campaign/channel/deliverable) living in
-- workspace A. These hardened BEFORE INSERT OR UPDATE guards reject any child whose referenced
-- parent is not in the child's OWN workspace. SECURITY DEFINER so the check is authoritative
-- regardless of the caller's RLS visibility (a service-role insert is validated too).
create or replace function public.enforce_campaign_child_ws()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.campaign c
                 where c.id = new.campaign_id and c.workspace_id = new.workspace_id) then
    raise exception 'campaign_id must reference a campaign in the same workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke all on function public.enforce_campaign_child_ws() from public, anon, authenticated;
drop trigger if exists campaign_channel_ws_tg on public.campaign_channel;
create trigger campaign_channel_ws_tg before insert or update on public.campaign_channel
  for each row execute function public.enforce_campaign_child_ws();
drop trigger if exists campaign_calendar_event_ws_tg on public.campaign_calendar_event;
create trigger campaign_calendar_event_ws_tg before insert or update on public.campaign_calendar_event
  for each row execute function public.enforce_campaign_child_ws();
drop trigger if exists campaign_segment_ws_tg on public.campaign_segment;
create trigger campaign_segment_ws_tg before insert or update on public.campaign_segment
  for each row execute function public.enforce_campaign_child_ws();

-- deliverable also carries an optional channel_id — validate it too.
create or replace function public.enforce_deliverable_ws()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.campaign c
                 where c.id = new.campaign_id and c.workspace_id = new.workspace_id) then
    raise exception 'campaign_id must reference a campaign in the same workspace' using errcode = '23514';
  end if;
  if new.channel_id is not null and not exists (
       select 1 from public.campaign_channel ch
       where ch.id = new.channel_id and ch.workspace_id = new.workspace_id) then
    raise exception 'channel_id must reference a channel in the same workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke all on function public.enforce_deliverable_ws() from public, anon, authenticated;
drop trigger if exists campaign_deliverable_ws_tg on public.campaign_deliverable;
create trigger campaign_deliverable_ws_tg before insert or update on public.campaign_deliverable
  for each row execute function public.enforce_deliverable_ws();

-- metric carries optional deliverable_id AND channel_id — validate all three FKs.
create or replace function public.enforce_metric_ws()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.campaign c
                 where c.id = new.campaign_id and c.workspace_id = new.workspace_id) then
    raise exception 'campaign_id must reference a campaign in the same workspace' using errcode = '23514';
  end if;
  if new.deliverable_id is not null and not exists (
       select 1 from public.campaign_deliverable d
       where d.id = new.deliverable_id and d.workspace_id = new.workspace_id) then
    raise exception 'deliverable_id must reference a deliverable in the same workspace' using errcode = '23514';
  end if;
  if new.channel_id is not null and not exists (
       select 1 from public.campaign_channel ch
       where ch.id = new.channel_id and ch.workspace_id = new.workspace_id) then
    raise exception 'channel_id must reference a channel in the same workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke all on function public.enforce_metric_ws() from public, anon, authenticated;
drop trigger if exists campaign_metric_ws_tg on public.campaign_metric;
create trigger campaign_metric_ws_tg before insert or update on public.campaign_metric
  for each row execute function public.enforce_metric_ws();

-- campaign itself carries an optional marketing_plan_id FK — same guard, on the PARENT side.
-- Without it a W1 member could point a W1 campaign at a W2 marketing_plan; that also contaminates
-- the plan-owner OR branch of the campaign UPDATE/DELETE policy above (a foreign plan owner could
-- then edit the campaign). BEFORE INSERT OR UPDATE, so both create and re-parent are covered.
create or replace function public.enforce_campaign_ws()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- `exists(... in a DIFFERENT workspace)` (not `not exists(same ws)`): a DANGLING id (plan does
  -- not exist) falls through to the FK constraint's 23503; only a plan that genuinely lives in
  -- another workspace raises 23514 here. This preserves the dangling-FK test's 23503 expectation.
  if new.marketing_plan_id is not null and exists (
       select 1 from public.marketing_plan mp
       where mp.id = new.marketing_plan_id and mp.workspace_id <> new.workspace_id) then
    raise exception 'marketing_plan_id must reference a marketing_plan in the same workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke all on function public.enforce_campaign_ws() from public, anon, authenticated;
drop trigger if exists campaign_ws_tg on public.campaign;
create trigger campaign_ws_tg before insert or update on public.campaign
  for each row execute function public.enforce_campaign_ws();
