-- Campaigns Phase 5 — Part B. Sorts AFTER Part A's 20260701000017_* campaign migration.
-- Hand-authored task-reuse bridge: DB triggers on Task's OWN tables recover the backing
-- deliverable by a REVERSE public.edges lookup (traverse_edges is forward-only) and emit
-- deliverable.* through public.emit_event. Plus scan_campaigns() (Task 2) and an optional
-- content-publish bridge (Task 3). There is NO event-subscription engine; nothing consumes
-- movp_internal.movp_events — all reuse is these triggers on task_assignment / task.

-- ── deliverable.assigned: task_assignment insert -> recover deliverable -> emit ─
-- REVERSE lookup: Task events carry only task_id (a dst); recover the deliverable (src)
-- directly. NEVER use traverse_edges (forward-only). Coexists with Task's own
-- task_assignment_emit_event_tg (which emits task.assigned) on the same table.
-- Single target = the inserted assignee; per-recipient key deliverable_id:assignee so a 2nd
-- assignee is not deduped. entity_id stays the bare deliverable for inbox/entity resolution.
create or replace function public.deliverable_assigned_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare deliv_id uuid;
begin
  select src_id into deliv_id from public.edges
   where workspace_id = new.workspace_id and dst_type = 'task' and dst_id = new.task_id
     and rel = 'implemented_by' and src_type = 'campaign_deliverable' limit 1;
  if deliv_id is not null then
    perform public.emit_event('deliverable.assigned', new.workspace_id,
      jsonb_build_object('id', deliv_id::text || ':' || new.assignee_user_id::text,
                         'entity_type','campaign_deliverable','entity_id', deliv_id,
                         'task_id', new.task_id,
                         'recipient_user_id', new.assignee_user_id),
      gen_random_uuid()::text);
  end if;
  return new;
end; $$;
revoke all on function public.deliverable_assigned_emit_event() from public, anon, authenticated;
drop trigger if exists deliverable_assigned_emit_event_tg on public.task_assignment;
create trigger deliverable_assigned_emit_event_tg after insert on public.task_assignment
  for each row execute function public.deliverable_assigned_emit_event();

-- ── deliverable.completed: backing task transitions INTO a done-category status ─
-- Mirrors Task's category-keyed transition. Coexists with Task's task_status_transition_tg
-- and task_status_recompute_dependents_tg (both after update of status_id on public.task);
-- all three fire, independent. Deliverable recipients = the BACKING TASK's notify set.
create or replace function public.deliverable_completed_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  from_cat text;
  to_cat   text;
  deliv_id uuid;
  r        record;
begin
  -- `after update of status_id` fires even when the value is unchanged; guard it.
  if new.status_id is not distinct from old.status_id then
    return new;
  end if;
  select category into from_cat from public.task_status_option where id = old.status_id;
  select category into to_cat   from public.task_status_option where id = new.status_id;
  if to_cat = 'done' and from_cat is distinct from 'done' then
    select src_id into deliv_id from public.edges
     where workspace_id = new.workspace_id and dst_type = 'task' and dst_id = new.id
       and rel = 'implemented_by' and src_type = 'campaign_deliverable' limit 1;
    if deliv_id is not null then
      -- AUDIT-ONLY companion: exactly ONE deliverable.completed per completion, emitted even when
      -- the backing task has zero recipients. Mirrors Task's task_status_transition, which emits an
      -- audit-only task.status_changed on every change (01b). No recipient_user_id/email in the
      -- payload -> emit_event records the event (+ webhook) but enqueues NO notify job. payload.id
      -- is the BARE deliverable id (no ':<recipient>' suffix), so it never collides with a
      -- per-recipient notify key. Without this, a completion whose task has no owner/observer would
      -- emit NOTHING -> the state change would be invisible to the events/audit layer.
      perform public.emit_event('deliverable.completed', new.workspace_id,
        jsonb_build_object('id', deliv_id::text,
                           'entity_type','campaign_deliverable','entity_id', deliv_id,
                           'task_id', new.id),
        gen_random_uuid()::text);
      -- per-recipient notify events: owner ∪ observer of the BACKING task.
      for r in select recipient from public.task_notify_recipients(new.id) loop
        perform public.emit_event('deliverable.completed', new.workspace_id,
          jsonb_build_object('id', deliv_id::text || ':' || r.recipient::text,
                             'entity_type','campaign_deliverable','entity_id', deliv_id,
                             'task_id', new.id,
                             'recipient_user_id', r.recipient),
          gen_random_uuid()::text);
      end loop;
    end if;
  end if;  -- no deliverable / not a done-transition -> no-op
  return new;
end; $$;
revoke all on function public.deliverable_completed_emit_event() from public, anon, authenticated;
drop trigger if exists deliverable_completed_emit_event_tg on public.task;
create trigger deliverable_completed_emit_event_tg after update of status_id on public.task
  for each row execute function public.deliverable_completed_emit_event();

-- ── scan_campaigns: date-driven lifecycle flips + deliverable.due_soon ────────
-- Called by a deploy-time cron (documented below, NOT committed); pgTAP/e2e call it directly.
create or replace function public.scan_campaigns()
returns void language plpgsql security definer set search_path = '' as $$
declare
  c record;
  d record;
  r record;
begin
  -- CATCH-UP semantics: this scan is a reconciler, not an event stream. Blocks (a) and (b) run in
  -- sequence, so a `scheduled` campaign whose ENTIRE window is already past flips scheduled->active
  -- in (a) and then active->completed in (b) within the SAME scan, emitting BOTH campaign.started
  -- and campaign.ended and landing in the terminal `completed` state in one pass. That double-flip
  -- is intended (a cron that missed the start_date still reconciles to the correct terminal state).
  -- (a) campaign.started: scheduled -> active once start_date has arrived. The UPDATE's
  -- predicate is falsified by the write, so a re-scan finds no rows -> idempotent, no stamp.
  for c in
    update public.campaign set status = 'active'
     where start_date <= current_date and status = 'scheduled'
    returning id, workspace_id
  loop
    perform public.emit_event('campaign.started', c.workspace_id,
      jsonb_build_object('id', c.id, 'entity_type','campaign','entity_id', c.id, 'status','active'),
      gen_random_uuid()::text);  -- audit-only: no recipient -> emit_event enqueues no notify job
  end loop;

  -- (b) campaign.ended: active -> completed once end_date has passed. Same idempotency.
  for c in
    update public.campaign set status = 'completed'
     where end_date < current_date and status = 'active'
    returning id, workspace_id
  loop
    perform public.emit_event('campaign.ended', c.workspace_id,
      jsonb_build_object('id', c.id, 'entity_type','campaign','entity_id', c.id, 'status','completed'),
      gen_random_uuid()::text);
  end loop;

  -- (c) deliverable.due_soon: each deliverable's implemented_by task due within one day and
  -- not done. REVERSE-join campaign_deliverable -> edges -> task. Fan out per recipient of the
  -- BACKING task's notify set. IDEMPOTENCY: the deliverable has no *_notified_at column, so a
  -- re-scan re-inserts the event but the DATE-keyed payload.id makes the notify idempotency_key
  -- identical -> movp_jobs unique(kind, idempotency_key) drops the duplicate job.
  -- RECIPIENT-GATED (deliberate, UNLIKE deliverable.completed): due_soon has NO audit-only
  -- companion. A reminder for a deliverable whose backing task has zero recipients has nobody to
  -- remind and carries no audit value, so it emits nothing. Completion, by contrast, is a state
  -- fact worth recording even with no recipients (hence its audit-only companion above).
  for d in
    select cd.id as deliverable_id, cd.workspace_id, tk.id as task_id, tk.due_date
      from public.campaign_deliverable cd
      join public.edges e
        on e.workspace_id = cd.workspace_id and e.src_type = 'campaign_deliverable'
       and e.src_id = cd.id and e.rel = 'implemented_by' and e.dst_type = 'task'
      join public.task tk on tk.id = e.dst_id
      join public.task_status_option so on so.id = tk.status_id
     where tk.due_date is not null and tk.due_date <= (current_date + 1) and so.category <> 'done'
  loop
    for r in select recipient from public.task_notify_recipients(d.task_id) loop
      perform public.emit_event('deliverable.due_soon', d.workspace_id,
        jsonb_build_object('id', d.deliverable_id::text || ':' || r.recipient::text || ':'
                                 || to_char(d.due_date,'YYYY-MM-DD'),
                           'entity_type','campaign_deliverable','entity_id', d.deliverable_id,
                           'task_id', d.task_id,
                           'recipient_user_id', r.recipient,
                           'due_date', to_char(d.due_date,'YYYY-MM-DD')),
        gen_random_uuid()::text);
    end loop;
  end loop;
end; $$;
revoke all on function public.scan_campaigns() from public, anon, authenticated;

-- ── DEPLOY-TIME CRON (documentation only — NOT applied by this migration) ────
-- Schedule out-of-band so `supabase db diff` stays empty and no secret is committed.
-- At deploy time (with any service key sourced from Vault, never a literal), run e.g.:
--   select cron.schedule('campaigns-scan', '*/15 * * * *', $cron$ select public.scan_campaigns(); $cron$);
-- scan_campaigns reads only local tables and fans out via emit_event -> movp_jobs, so it needs
-- no secret itself; the Vault key belongs to the notify worker that drains the jobs. Mirrors
-- Task's emit_due_soon cron doc. pgTAP/e2e call `select public.scan_campaigns();` directly.
