begin;
select plan(8);

-- ── seed (as table owner; RLS bypassed) ─────────────────────────────────────
insert into public.workspace (id, name)
  values ('cccccccc-0000-0000-0000-000000000001', 'RepWs')
  on conflict (id) do nothing;

-- Campaign A: status 'active', one 'email' channel.
insert into public.campaign (id, workspace_id, name, status)
  values ('cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-000000000001', 'A', 'active');
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name)
  values ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-0000000000a1', 'email', 'Email');

-- Campaign B: status 'scheduled', one 'paid' channel.
insert into public.campaign (id, workspace_id, name, status)
  values ('cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-000000000001', 'B', 'scheduled');
insert into public.campaign_channel (id, workspace_id, campaign_id, channel_type, name)
  values ('cccccccc-0000-0000-0000-0000000000c2', 'cccccccc-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-0000000000b1', 'paid', 'Paid');

-- Fact rows: A gets 30+70=100 (email/active), B gets 25 (paid/scheduled).
insert into public.campaign_metric (workspace_id, campaign_id, channel_id, metric_key, value, measured_at) values
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-0000000000c1', 'clicks', 30, current_date),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000a1', 'cccccccc-0000-0000-0000-0000000000c1', 'clicks', 70, current_date),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000b1', 'cccccccc-0000-0000-0000-0000000000c2', 'clicks', 25, current_date);

-- ── fact rollup: sum(value) by channel_type + status (the star-schema query) ─
select is(
  (select sum(m.value)::int
     from public.campaign_metric m
     join public.campaign c on c.id = m.campaign_id
     join public.campaign_channel cc on cc.id = m.channel_id
    where cc.channel_type = 'email' and c.status = 'active'),
  100, 'email/active fact rollup = 100');
select is(
  (select sum(m.value)::int
     from public.campaign_metric m
     join public.campaign c on c.id = m.campaign_id
     join public.campaign_channel cc on cc.id = m.channel_id
    where cc.channel_type = 'paid' and c.status = 'scheduled'),
  25, 'paid/scheduled fact rollup = 25');
select is(
  (select count(*)::int from (
     select cc.channel_type, c.status
       from public.campaign_metric m
       join public.campaign c on c.id = m.campaign_id
       join public.campaign_channel cc on cc.id = m.channel_id
      group by cc.channel_type, c.status) g),
  2, 'group by channel_type,status yields 2 fact groups');

-- ── metadata registry: reporting roles (measure vs dimension) ───────────────
select is((select reporting_role from public.movp_fields where collection_name = 'campaign_metric' and name = 'value'),
          'measure', 'campaign_metric.value is a measure');
select is((select reporting_role from public.movp_fields where collection_name = 'campaign_metric' and name = 'measured_at'),
          'dimension', 'campaign_metric.measured_at is a dimension');
select is((select reporting_role from public.movp_fields where collection_name = 'campaign_channel' and name = 'channel_type'),
          'dimension', 'campaign_channel.channel_type is a dimension');
select is((select reporting_role from public.movp_fields where collection_name = 'campaign' and name = 'status'),
          'dimension', 'campaign.status is a dimension');
select is((select reporting_role from public.movp_fields where collection_name = 'campaign' and name = 'priority'),
          'dimension', 'campaign.priority is a dimension');

select * from finish();
rollback;
