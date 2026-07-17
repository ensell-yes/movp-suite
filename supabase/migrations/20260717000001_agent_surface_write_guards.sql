-- Agent write capabilities are enforced at the database boundary as well as in generated surfaces.

drop policy if exists campaign_metric_rw on public.campaign_metric;
drop policy if exists campaign_metric_select on public.campaign_metric;
drop policy if exists campaign_metric_insert on public.campaign_metric;
create policy campaign_metric_select on public.campaign_metric
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy campaign_metric_insert on public.campaign_metric
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
revoke update, delete on public.campaign_metric from authenticated;
grant select, insert on public.campaign_metric to authenticated;
grant select, insert, update, delete on public.campaign_metric to service_role;

drop policy if exists segment_membership_rw on public.segment_membership;
drop policy if exists segment_membership_select on public.segment_membership;
create policy segment_membership_select on public.segment_membership
  for select to authenticated using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.segment_membership from authenticated;
grant select on public.segment_membership to authenticated;
grant select, insert, update, delete on public.segment_membership to service_role;

drop policy if exists segment_snapshot_rw on public.segment_snapshot;
drop policy if exists segment_snapshot_select on public.segment_snapshot;
create policy segment_snapshot_select on public.segment_snapshot
  for select to authenticated using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.segment_snapshot from authenticated;
grant select on public.segment_snapshot to authenticated;
grant select, insert, update, delete on public.segment_snapshot to service_role;

drop policy if exists segment_recompute_run_rw on public.segment_recompute_run;
drop policy if exists segment_recompute_run_select on public.segment_recompute_run;
create policy segment_recompute_run_select on public.segment_recompute_run
  for select to authenticated using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.segment_recompute_run from authenticated;
grant select on public.segment_recompute_run to authenticated;
grant select, insert, update, delete on public.segment_recompute_run to service_role;
