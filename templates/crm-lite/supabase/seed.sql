-- CRM-lite demo seed. Workspace + membership are created by the Verdaccio gate (it mints a real
-- gotrue user and inserts membership); this file seeds the CRM domain rows only, idempotently.
insert into public.company (id, workspace_id, name, domain, tier) values
  ('c0000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Acme Corp', 'acme.test', 'enterprise'),
  ('c0000000-0000-0000-0000-000000000002', '__WORKSPACE_ID__', 'Globex', 'globex.test', 'mid_market')
on conflict (id) do nothing;

insert into public.contact (id, workspace_id, full_name, email, title, company) values
  ('a0000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Ada Lovelace', 'ada@acme.test', 'CTO', 'c0000000-0000-0000-0000-000000000001')
on conflict (id) do nothing;

insert into public.deal (id, workspace_id, name, amount, stage, company, primary_contact) values
  ('d0000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Acme platform rollout', 50000, 'proposal',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001')
on conflict (id) do nothing;

-- C5 showcase: a segment + an automation over platform collections.
insert into public.segment (id, workspace_id, name, active, mode) values
  ('50000000-0000-0000-0000-0000000000d1', '__WORKSPACE_ID__', 'Enterprise deals', true, 'dynamic')
on conflict (id) do nothing;
