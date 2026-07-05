begin;
select plan(16);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','dddddddd-dddd-dddd-dddd-dddddddddddd','member');
-- NOTE: inserting the workspace fired Task Part A's AFTER-INSERT seed trigger, which already
-- created W1's default task status + priority options (each is_default=true). So these
-- fixed-id fixtures are is_default=FALSE — a 2nd is_default in the same workspace would
-- violate the one-default-per-workspace partial unique. Tasks below use these ids EXPLICITLY.
-- Labels intentionally != categories, so category-keyed logic is label-agnostic.
insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active) values
  ('0000000a-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','In Progress','active',1,false,true),
  ('0000000d-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Shipped','done',2,false,true);
-- priority is a REQUIRED relation on public.task (priority_id NOT NULL) — seed ONE option.
-- (task_priority_option orders by `rank`; it has NO sort_order column — that is on task_status_option.)
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active) values
  ('0000000e-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','Normal',5,false,true);
-- Task's task_status_transition writes task_status_history.changed_by = auth.uid(); set the
-- claim so that resolves to A when we move tA to done below (avoids a null changed_by).
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- host campaign c3 (active). Inserting it fires Part A's campaign.created trigger (harmless:
-- our assertions filter on campaign.started/ended/deliverable.* by type, never campaign.created).
insert into public.campaign (id, workspace_id, owner_id, name, start_date, end_date, status) values
  ('c3333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'C3', current_date - 30, current_date + 30, 'active');
-- deliverable d0. channel_id omitted (nullable). Inserting it fires Part A's deliverable.created
-- trigger (harmless — filtered out by type as above).
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('d0000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'c3333333-3333-3333-3333-333333333333','Launch Email','email');
-- backing task tA (active). implemented_by edge d0 -> tA. observer D on tA.
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('a0000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Backing Task A','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values
  ('11111111-1111-1111-1111-111111111111','campaign_deliverable','d0000000-0000-0000-0000-000000000000',
   'implemented_by','task','a0000000-0000-0000-0000-000000000000');
insert into public.task_observer (workspace_id, task_id, observer_user_id) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000000',
   'dddddddd-dddd-dddd-dddd-dddddddddddd');

-- ── Task 1: deliverable.assigned (task_assignment insert recovers the deliverable) ──
-- assigning A to tA fires Task's task.assigned AND our deliverable.assigned (edge exists).
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.assigned'
             and payload->>'entity_id'='d0000000-0000-0000-0000-000000000000'
             and payload->>'recipient_user_id'='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'assigning the backing task emits deliverable.assigned carrying entity_id=deliverable + recipient=the assignee');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify'
             and idempotency_key='deliverable.assigned:d0000000-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
          1, 'the deliverable.assigned notify job uses a per-recipient idempotency key (deliverable_id:assignee)');

-- negative: a task with NO implemented_by edge -> assignment fires the trigger but emits nothing.
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('000000ff-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Unbridged Task','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','000000ff-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.assigned' and payload->>'task_id'='000000ff-0000-0000-0000-000000000000'),
          0, 'a task with no implemented_by edge emits no deliverable.assigned (no-op)');

-- deliverable.completed: move backing task tA INTO a done-category status ('Shipped').
-- recipients = task_notify_recipients(tA) = owner A UNION observer D = 2, PLUS one audit-only
-- companion event (no recipient) emitted once per completion.
update public.task set status_id='0000000d-0000-0000-0000-000000000000'
  where id='a0000000-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.completed' and payload->>'entity_id'='d0000000-0000-0000-0000-000000000000'
             and payload ? 'recipient_user_id'),
          2, 'completing the backing task emits one deliverable.completed PER RECIPIENT (owner + observer)');
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.completed' and payload->>'entity_id'='d0000000-0000-0000-0000-000000000000'
             and not (payload ? 'recipient_user_id') and payload->>'id'='d0000000-0000-0000-0000-000000000000'),
          1, 'completing the backing task ALSO emits exactly one audit-only deliverable.completed (bare payload.id, no recipient)');

-- zero-recipient completion still records an audit event. dNR is backed by tNR, which has NO
-- owner/observer -> task_notify_recipients(tNR) is empty -> zero per-recipient events; the audit-only
-- companion guarantees the completion stays observable in the events/audit layer.
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('d00000ff-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'c3333333-3333-3333-3333-333333333333','No-Recipient Deliverable','email');
insert into public.task (id, workspace_id, title, status_id, priority_id) values
  ('a00000ff-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Backing Task NR','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000');
insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values
  ('11111111-1111-1111-1111-111111111111','campaign_deliverable','d00000ff-0000-0000-0000-000000000000',
   'implemented_by','task','a00000ff-0000-0000-0000-000000000000');
update public.task set status_id='0000000d-0000-0000-0000-000000000000'
  where id='a00000ff-0000-0000-0000-000000000000';
select is((select count(*)::int from movp_internal.movp_events
           where type='deliverable.completed' and payload->>'entity_id'='d00000ff-0000-0000-0000-000000000000'),
          1, 'completing a bridged task whose backing task has NO recipients still yields >=1 audit deliverable.completed (entity_id=deliverable)');

-- ── Task 2: scan_campaigns (started / ended / due_soon) ──────────────────────
insert into public.campaign (id, workspace_id, owner_id, name, start_date, end_date, status) values
  ('c1111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'C1', current_date, current_date + 30, 'scheduled'),
  ('c2222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'C2', current_date - 60, current_date - 1, 'active'),
-- c4: scheduled with its ENTIRE window already past -> exercises the catch-up double-flip
-- (scheduled -> active -> completed) in a single scan.
  ('c4444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'C4', current_date - 10, current_date - 5, 'scheduled');
-- due_soon fixture: deliverable dDue (on active c3) -> task tB due tomorrow, owner A only (1 recipient).
insert into public.campaign_deliverable (id, workspace_id, campaign_id, name, deliverable_type) values
  ('dddd0000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'c3333333-3333-3333-3333-333333333333','Due Soon Deliverable','email');
insert into public.task (id, workspace_id, title, status_id, priority_id, due_date) values
  ('b0000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   'Backing Task B','0000000a-0000-0000-0000-000000000000','0000000e-0000-0000-0000-000000000000', current_date + 1);
insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values
  ('11111111-1111-1111-1111-111111111111','campaign_deliverable','dddd0000-0000-0000-0000-000000000000',
   'implemented_by','task','b0000000-0000-0000-0000-000000000000');
insert into public.task_assignment (workspace_id, task_id, assignee_user_id, role) values
  ('11111111-1111-1111-1111-111111111111','b0000000-0000-0000-0000-000000000000',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');

select public.scan_campaigns();
select is((select status::text from public.campaign where id='c1111111-1111-1111-1111-111111111111'),
          'active', 'a scheduled campaign whose start_date has arrived becomes active');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.started' and payload->>'entity_id'='c1111111-1111-1111-1111-111111111111'),
          1, 'the scheduled->active flip emits exactly one campaign.started (audit-only)');
select is((select status::text from public.campaign where id='c2222222-2222-2222-2222-222222222222'),
          'completed', 'an active campaign past its end_date becomes completed');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.ended' and payload->>'entity_id'='c2222222-2222-2222-2222-222222222222'),
          1, 'the active->completed flip emits exactly one campaign.ended (audit-only)');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify'
             and idempotency_key='deliverable.due_soon:dddd0000-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:'
                                 || to_char(current_date + 1,'YYYY-MM-DD')),
          1, 'a deliverable whose backing task is due tomorrow enqueues one DATE-keyed due_soon notify job');

-- catch-up double-flip: c4's whole window is already past, so the SAME scan flips it
-- scheduled -> active -> completed and emits BOTH campaign.started and campaign.ended.
select is((select status::text from public.campaign where id='c4444444-4444-4444-4444-444444444444'),
          'completed', 'a scheduled campaign whose entire window is past reaches the terminal completed state in one scan (catch-up)');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.started' and payload->>'entity_id'='c4444444-4444-4444-4444-444444444444'),
          1, 'the catch-up double-flip still emits exactly one campaign.started for c4');
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.ended' and payload->>'entity_id'='c4444444-4444-4444-4444-444444444444'),
          1, 'the catch-up double-flip also emits exactly one campaign.ended for c4');

-- re-run the SAME day: campaign flips are falsified (idempotent); the due_soon date-key de-dups the job.
select public.scan_campaigns();
select is((select count(*)::int from movp_internal.movp_events
           where type='campaign.started' and payload->>'entity_id'='c1111111-1111-1111-1111-111111111111'),
          1, 're-scanning emits no further campaign.started (c1 is no longer scheduled)');
select is((select count(*)::int from movp_internal.movp_jobs
           where kind='notify'
             and idempotency_key='deliverable.due_soon:dddd0000-0000-0000-0000-000000000000:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:'
                                 || to_char(current_date + 1,'YYYY-MM-DD')),
          1, 're-scanning the same day enqueues no duplicate due_soon notify job (movp_jobs unique on the date key)');

select * from finish();
rollback;
