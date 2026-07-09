-- C2.2 workspace member administration.

create table movp_internal.workspace_invite (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by uuid not null,
  accepted_by uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create index workspace_invite_workspace_idx on movp_internal.workspace_invite (workspace_id, status, created_at desc);

grant select, insert, update, delete on movp_internal.workspace_invite to service_role;

create or replace function public.create_workspace(p_name text)
returns public.workspace
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_workspace public.workspace;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'workspace_name_required' using errcode = '22023';
  end if;

  insert into public.workspace (name)
    values (btrim(p_name))
    returning * into v_workspace;

  insert into public.workspace_membership (workspace_id, user_id, role)
    values (v_workspace.id, v_user, 'owner');

  return v_workspace;
end;
$$;

create or replace function public.invite_member(ws uuid, invite_email text, invite_role text default 'member')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text := lower(btrim(coalesce(invite_email, '')));
  v_role text := coalesce(invite_role, 'member');
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_invite_id uuid;
begin
  if v_user is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invite_email_invalid' using errcode = '22023';
  end if;
  if v_role not in ('admin', 'member') then
    raise exception 'invite_role_invalid' using errcode = '22023';
  end if;

  insert into movp_internal.workspace_invite (workspace_id, email, role, token_hash, invited_by)
    values (ws, v_email, v_role, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_user)
    returning id into v_invite_id;

  return jsonb_build_object('invite_id', v_invite_id, 'token', v_token);
end;
$$;

create or replace function public.accept_invite(invite_token text)
returns public.workspace_membership
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_invite movp_internal.workspace_invite;
  v_membership public.workspace_membership;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select *
    into v_invite
    from movp_internal.workspace_invite
   where token_hash = encode(extensions.digest(coalesce(invite_token, ''), 'sha256'), 'hex')
     and status = 'pending'
   for update;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0001';
  end if;
  if v_email = '' or v_email <> v_invite.email then
    raise exception 'invite_email_mismatch' using errcode = '42501';
  end if;

  insert into public.workspace_membership (workspace_id, user_id, role)
    values (v_invite.workspace_id, v_user, v_invite.role)
    on conflict (workspace_id, user_id) do update set role = excluded.role
    returning * into v_membership;

  update movp_internal.workspace_invite
     set status = 'accepted', accepted_by = v_user, accepted_at = now()
   where id = v_invite.id;

  return v_membership;
end;
$$;

create or replace function public.set_member_role(ws uuid, target_user uuid, new_role text)
returns public.workspace_membership
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_role text;
  v_membership public.workspace_membership;
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;
  if new_role not in ('owner', 'admin', 'member') then
    raise exception 'member_role_invalid' using errcode = '22023';
  end if;

  select role into v_old_role
    from public.workspace_membership
   where workspace_id = ws and user_id = target_user
   for update;

  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;
  if v_old_role = 'owner' and new_role <> 'owner' and (
    select count(*) from public.workspace_membership where workspace_id = ws and role = 'owner'
  ) <= 1 then
    raise exception 'last_owner_guard' using errcode = 'P0001';
  end if;

  update public.workspace_membership
     set role = new_role
   where workspace_id = ws and user_id = target_user
   returning * into v_membership;

  return v_membership;
end;
$$;

create or replace function public.remove_member(ws uuid, target_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_role text;
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;

  select role into v_old_role
    from public.workspace_membership
   where workspace_id = ws and user_id = target_user
   for update;

  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;
  if v_old_role = 'owner' and (
    select count(*) from public.workspace_membership where workspace_id = ws and role = 'owner'
  ) <= 1 then
    raise exception 'last_owner_guard' using errcode = 'P0001';
  end if;

  delete from public.workspace_membership
   where workspace_id = ws and user_id = target_user;
end;
$$;

create or replace function public.list_workspace_members(ws uuid)
returns setof public.workspace_membership
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;

  return query
    select *
      from public.workspace_membership
     where workspace_id = ws
     order by role = 'owner' desc, created_at asc, user_id asc;
end;
$$;

revoke all on function public.create_workspace(text) from public, anon, authenticated;
revoke all on function public.invite_member(uuid, text, text) from public, anon, authenticated;
revoke all on function public.accept_invite(text) from public, anon, authenticated;
revoke all on function public.set_member_role(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.remove_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_workspace_members(uuid) from public, anon, authenticated;

grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.invite_member(uuid, text, text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.list_workspace_members(uuid) to authenticated;
