-- Bootstrap tenancy: workspaces, memberships, and the RLS membership helper.

create table public.workspace (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.workspace_membership (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_membership_user_idx on public.workspace_membership (user_id);

grant select on public.workspace to authenticated;
grant select on public.workspace_membership to authenticated;
grant select, insert, update, delete on public.workspace to service_role;
grant select, insert, update, delete on public.workspace_membership to service_role;

-- Hardened SECURITY DEFINER: pinned empty search_path, fully schema-qualified,
-- least-privilege execute grant.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_membership m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;

alter table public.workspace enable row level security;
alter table public.workspace_membership enable row level security;

create policy workspace_read on public.workspace
  for select to authenticated
  using (public.is_workspace_member(id));

create policy membership_read on public.workspace_membership
  for select to authenticated
  using (public.is_workspace_member(workspace_id));
