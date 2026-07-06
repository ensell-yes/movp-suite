-- Domain Workflows Phase 7 - Part C: webhook subscription management.

alter table movp_internal.webhooks
  add column if not exists managed_by text;

create index if not exists webhooks_workflow_managed_idx
  on movp_internal.webhooks (workspace_id, event_type, url)
  where managed_by = 'workflow_subscription';

create unique index if not exists webhook_subscription_internal_unique
  on public.webhook_subscription (internal_webhook_id)
  where internal_webhook_id is not null;

drop policy if exists webhook_subscription_rw on public.webhook_subscription;
drop policy if exists webhook_subscription_select on public.webhook_subscription;
create policy webhook_subscription_select on public.webhook_subscription
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.webhook_subscription from authenticated;
grant select on public.webhook_subscription to authenticated;
grant select, insert, update, delete on public.webhook_subscription to service_role;

create or replace function public.register_webhook_subscription(ws uuid, event_key text, hook_url text, filter jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_internal_id uuid;
  v_subscription_id uuid;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  if filter is not null and jsonb_typeof(filter) <> 'object' then
    raise exception 'filter_invalid' using errcode = '22023';
  end if;

  if not exists (select 1 from public.event_type et where et.key = event_key and et.active) then
    raise exception 'event_type_not_found' using errcode = '22023';
  end if;

  perform public.register_webhook(ws, event_key, hook_url, v_secret);

  select w.id
    into v_internal_id
    from movp_internal.webhooks w
   where w.workspace_id = ws
     and w.event_type = event_key
     and w.url = hook_url
     and w.secret = v_secret
   order by w.created_at desc
   limit 1;

  if v_internal_id is null then
    raise exception 'internal_webhook_not_created' using errcode = 'P0001';
  end if;

  update movp_internal.webhooks
     set managed_by = 'workflow_subscription'
   where id = v_internal_id;

  insert into public.webhook_subscription
    (workspace_id, event_type_id, url, filter, active, secret_set, secret_last_rotated_at, internal_webhook_id)
  select ws, et.id, hook_url, filter, true, true, now(), v_internal_id
    from public.event_type et
   where et.key = event_key
  returning id into v_subscription_id;

  return jsonb_build_object('subscription_id', v_subscription_id, 'secret', v_secret);
end;
$$;

revoke all on function public.register_webhook_subscription(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_webhook_subscription(uuid, text, text, jsonb) to authenticated;

create or replace function public.rotate_webhook_secret(subscription_id uuid, ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.webhook_subscription%rowtype;
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  select *
    into v_sub
    from public.webhook_subscription s
   where s.id = subscription_id
     and s.workspace_id = ws;
  if not found then
    raise exception 'webhook_subscription_not_found' using errcode = '22023';
  end if;

  update movp_internal.webhooks w
     set secret = v_secret
   where w.id = v_sub.internal_webhook_id
     and w.workspace_id = ws
     and w.managed_by = 'workflow_subscription';
  if not found then
    raise exception 'internal_webhook_not_found' using errcode = 'P0001';
  end if;

  update public.webhook_subscription
     set secret_set = true,
         secret_last_rotated_at = now(),
         updated_at = now()
   where id = subscription_id;

  return jsonb_build_object('subscription_id', subscription_id, 'secret', v_secret);
end;
$$;

revoke all on function public.rotate_webhook_secret(uuid, uuid) from public, anon, authenticated;
grant execute on function public.rotate_webhook_secret(uuid, uuid) to authenticated;

create or replace function public.set_webhook_active(subscription_id uuid, ws uuid, active boolean)
returns public.webhook_subscription
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.webhook_subscription%rowtype;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  select *
    into v_sub
    from public.webhook_subscription s
   where s.id = subscription_id
     and s.workspace_id = ws;
  if not found then
    raise exception 'webhook_subscription_not_found' using errcode = '22023';
  end if;

  update movp_internal.webhooks w
     set active = set_webhook_active.active
   where w.id = v_sub.internal_webhook_id
     and w.workspace_id = ws
     and w.managed_by = 'workflow_subscription';
  if not found then
    raise exception 'internal_webhook_not_found' using errcode = 'P0001';
  end if;

  update public.webhook_subscription s
     set active = set_webhook_active.active,
         updated_at = now()
   where s.id = subscription_id
   returning * into v_sub;

  return v_sub;
end;
$$;

revoke all on function public.set_webhook_active(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_webhook_active(uuid, uuid, boolean) to authenticated;

create or replace function public.set_webhook_filter(subscription_id uuid, ws uuid, filter jsonb)
returns public.webhook_subscription
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.webhook_subscription%rowtype;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  if filter is not null and jsonb_typeof(filter) <> 'object' then
    raise exception 'filter_invalid' using errcode = '22023';
  end if;

  update public.webhook_subscription s
     set filter = set_webhook_filter.filter,
         updated_at = now()
   where s.id = subscription_id
     and s.workspace_id = ws
   returning * into v_sub;
  if not found then
    raise exception 'webhook_subscription_not_found' using errcode = '22023';
  end if;

  return v_sub;
end;
$$;

revoke all on function public.set_webhook_filter(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_webhook_filter(uuid, uuid, jsonb) to authenticated;

create or replace function public.webhook_subscription_pairing_drift()
returns table(drift_code text, subscription_id uuid, internal_webhook_id uuid)
language sql
security definer
set search_path = ''
as $$
  with managed as (
    select w.id, w.workspace_id, w.event_type, w.url, w.active
      from movp_internal.webhooks w
     where w.managed_by = 'workflow_subscription'
  ),
  public_pairs as (
    select s.id,
           s.workspace_id,
           et.key as event_type,
           s.url,
           s.active,
           s.internal_webhook_id
      from public.webhook_subscription s
      join public.event_type et on et.id = s.event_type_id
  ),
  duplicate_groups as (
    select workspace_id, event_type, url
      from managed
     group by workspace_id, event_type, url
    having count(*) > 1
  )
  select 'missing_internal'::text, p.id, p.internal_webhook_id
    from public_pairs p
    left join managed m on m.id = p.internal_webhook_id
   where m.id is null
  union all
  select 'orphan_internal'::text, null::uuid, m.id
    from managed m
    left join public_pairs p on p.internal_webhook_id = m.id
   where p.id is null
  union all
  select 'active_mismatch'::text, p.id, m.id
    from public_pairs p
    join managed m on m.id = p.internal_webhook_id
   where p.active is distinct from m.active
  union all
  select 'duplicate_internal'::text, p.id, m.id
    from managed m
    join duplicate_groups d
      on d.workspace_id = m.workspace_id
     and d.event_type = m.event_type
     and d.url = m.url
    left join public_pairs p on p.internal_webhook_id = m.id;
$$;

revoke all on function public.webhook_subscription_pairing_drift() from public, anon, authenticated;
grant execute on function public.webhook_subscription_pairing_drift() to service_role;
