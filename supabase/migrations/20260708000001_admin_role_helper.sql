-- C2.1 admin role helper. workspace_membership.role already exists (owner/admin/member).
create or replace function public.is_workspace_admin(ws uuid)
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
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.is_workspace_admin(uuid) to authenticated;
