-- Support-desk demo seed. Every referenced row is created here, so db reset is self-contained.
insert into public.workspace (id, name)
  values ('__WORKSPACE_ID__', 'Support Demo')
  on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('__WORKSPACE_ID__', 'b0000000-0000-0000-0000-0000000000aa', 'owner')
  on conflict (workspace_id, user_id) do nothing;

insert into public.task_status_option (id, workspace_id, label, category, sort_order, is_default, is_active)
  values ('b1000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Open', 'active', 1, true, true)
  on conflict (id) do nothing;
insert into public.task_priority_option (id, workspace_id, label, rank, is_default, is_active)
  values ('b1000000-0000-0000-0000-000000000002', '__WORKSPACE_ID__', 'Normal', 100, true, true)
  on conflict (id) do nothing;
insert into public.task (id, workspace_id, title, status_id, priority_id, due_date)
  values ('b2000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Login button is broken',
          'b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', current_date + 1)
  on conflict (id) do nothing;

insert into public.sla_policy (id, workspace_id, name, first_response_minutes, resolution_minutes)
  values ('b3000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Standard', 60, 1440)
  on conflict (id) do nothing;
insert into public.support_ticket (id, workspace_id, subject, requester_email, channel, sla_due_at, task_id, policy_id)
  values ('b4000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Login button is broken',
          'user@example.com', 'email', now() + interval '1 day',
          'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001')
  on conflict (id) do nothing;

insert into public.automation_rule
  (id, workspace_id, trigger_event_type_id, condition, action_type, action_config, enabled, priority)
  values ('b5000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          (select id from public.event_type where key = 'task.due_soon' limit 1),
          '{}'::jsonb, 'notify', '{"channel":"support_inbox"}'::jsonb, true, 100)
  on conflict (id) do nothing;
