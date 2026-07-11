-- C3a.2 Personal Access Tokens — user-scoped, hashed, revocable.
-- FORWARD-ONLY: this is a NEW timestamped migration; never edit a merged migration.

create table movp_internal.personal_access_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  default_workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index personal_access_token_user_idx
  on movp_internal.personal_access_token (user_id, created_at desc);

-- movp_internal posture: RLS on, NO policies, closed to anon/authenticated, service_role only.
alter table movp_internal.personal_access_token enable row level security;
revoke all on movp_internal.personal_access_token from anon, authenticated;
grant all on movp_internal.personal_access_token to service_role;

create or replace function public.create_personal_access_token(default_ws uuid, name text, ttl_days int default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_token text := 'movp_pat_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id    uuid;
begin
  if v_user is null or not public.is_workspace_member(default_ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  if length(btrim(coalesce(create_personal_access_token.name, ''))) = 0 then
    raise exception 'pat_name_required' using errcode = '22023';
  end if;

  insert into movp_internal.personal_access_token (user_id, default_workspace_id, name, token_hash, expires_at)
    values (
      v_user, default_ws, btrim(create_personal_access_token.name),
      encode(extensions.digest(v_token, 'sha256'), 'hex'),
      now() + make_interval(days => greatest(coalesce(ttl_days, 90), 1)))
    returning id into v_id;

  return jsonb_build_object('token_id', v_id, 'token', v_token);
end;
$$;

create or replace function public.list_personal_access_tokens()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- metadata only; token_hash is NEVER selected.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'default_workspace_id', p.default_workspace_id,
      'created_at', p.created_at, 'last_used_at', p.last_used_at,
      'expires_at', p.expires_at, 'revoked_at', p.revoked_at)
      order by p.created_at desc)
    from movp_internal.personal_access_token p
    where p.user_id = (select auth.uid())
  ), '[]'::jsonb);
end;
$$;

create or replace function public.revoke_personal_access_token(token_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update movp_internal.personal_access_token
     set revoked_at = now()
   where id = revoke_personal_access_token.token_id
     and user_id = (select auth.uid())
     and revoked_at is null;
  if not found then
    raise exception 'pat_not_found' using errcode = 'P0001';
  end if;
end;
$$;

-- resolve_pat is SERVICE-ROLE ONLY: the only path that reads a PAT's identity.
create or replace function public.resolve_pat(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row movp_internal.personal_access_token;
begin
  select * into v_row from movp_internal.personal_access_token where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.revoked_at is not null then return jsonb_build_object('status', 'revoked'); end if;
  if v_row.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;

  -- throttled last_used_at: at most once / 5 min per PAT (no write amplification on hot agents).
  update movp_internal.personal_access_token
     set last_used_at = now()
   where token_hash = p_token_hash
     and (last_used_at is null or last_used_at < now() - interval '5 minutes');

  return jsonb_build_object('status', 'ok', 'user_id', v_row.user_id, 'default_workspace_id', v_row.default_workspace_id);
end;
$$;

revoke all on function public.create_personal_access_token(uuid, text, int) from public, anon;
revoke all on function public.list_personal_access_tokens() from public, anon;
revoke all on function public.revoke_personal_access_token(uuid) from public, anon;
revoke all on function public.resolve_pat(text) from public, anon, authenticated;

grant execute on function public.create_personal_access_token(uuid, text, int) to authenticated;
grant execute on function public.list_personal_access_tokens() to authenticated;
grant execute on function public.revoke_personal_access_token(uuid) to authenticated;
grant execute on function public.resolve_pat(text) to service_role;
