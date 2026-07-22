-- User-managed agent access preferences with caller-bound and service-only evaluation seams.

create table movp_internal.user_agent_access (
  user_id uuid primary key,
  mcp_enabled boolean not null default true,
  cli_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table movp_internal.user_agent_access enable row level security;
revoke all on movp_internal.user_agent_access from public, anon, authenticated;
grant select, insert, update on movp_internal.user_agent_access to service_role;

create or replace function public.get_agent_access_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_mcp_enabled boolean;
  v_cli_enabled boolean;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select a.mcp_enabled, a.cli_enabled
    into v_mcp_enabled, v_cli_enabled
    from movp_internal.user_agent_access a
   where a.user_id = v_user;

  return jsonb_build_object(
    'mcp_enabled', coalesce(v_mcp_enabled, true),
    'cli_enabled', coalesce(v_cli_enabled, true));
end;
$$;

create or replace function public.update_agent_access_preferences(
  p_mcp_enabled boolean,
  p_cli_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_mcp_enabled is null or p_cli_enabled is null then
    raise exception 'agent_access_preferences_required' using errcode = '22023';
  end if;

  insert into movp_internal.user_agent_access (user_id, mcp_enabled, cli_enabled, updated_at)
  values (v_user, p_mcp_enabled, p_cli_enabled, now())
  on conflict (user_id) do update
    set mcp_enabled = excluded.mcp_enabled,
        cli_enabled = excluded.cli_enabled,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'mcp_enabled', p_mcp_enabled,
    'cli_enabled', p_cli_enabled);
end;
$$;

create or replace function public.evaluate_agent_access(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mcp_enabled boolean;
  v_cli_enabled boolean;
begin
  if p_user_id is null then
    raise exception 'agent_access_user_required' using errcode = '22023';
  end if;

  select a.mcp_enabled, a.cli_enabled
    into v_mcp_enabled, v_cli_enabled
    from movp_internal.user_agent_access a
   where a.user_id = p_user_id;

  return jsonb_build_object(
    'mcp_enabled', coalesce(v_mcp_enabled, true),
    'cli_enabled', coalesce(v_cli_enabled, true));
end;
$$;

-- PAT resolution carries the effective access snapshot so PAT hot paths need no second lookup.
create or replace function public.resolve_pat(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row movp_internal.personal_access_token;
  v_mcp_enabled boolean;
  v_cli_enabled boolean;
begin
  select *
    into v_row
    from movp_internal.personal_access_token
   where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.revoked_at is not null then return jsonb_build_object('status', 'revoked'); end if;
  if v_row.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;

  update movp_internal.personal_access_token
     set last_used_at = now()
   where token_hash = p_token_hash
     and (last_used_at is null or last_used_at < now() - interval '5 minutes');

  select a.mcp_enabled, a.cli_enabled
    into v_mcp_enabled, v_cli_enabled
    from movp_internal.user_agent_access a
   where a.user_id = v_row.user_id;

  return jsonb_build_object(
    'status', 'ok',
    'user_id', v_row.user_id,
    'default_workspace_id', v_row.default_workspace_id,
    'mcp_enabled', coalesce(v_mcp_enabled, true),
    'cli_enabled', coalesce(v_cli_enabled, true));
end;
$$;

revoke all on function public.get_agent_access_preferences() from public, anon;
revoke all on function public.update_agent_access_preferences(boolean, boolean) from public, anon;
revoke all on function public.evaluate_agent_access(uuid) from public, anon, authenticated;
revoke all on function public.resolve_pat(text) from public, anon, authenticated;

grant execute on function public.get_agent_access_preferences() to authenticated;
grant execute on function public.update_agent_access_preferences(boolean, boolean) to authenticated;
grant execute on function public.evaluate_agent_access(uuid) to service_role;
grant execute on function public.resolve_pat(text) to service_role;
