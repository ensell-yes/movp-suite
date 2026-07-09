create or replace function public.workspace_settings(ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not a workspace member' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'workspace_id', ws,
    'name', (select w.name from public.workspace w where w.id = ws),
    'member_count', (
      select count(*)
      from public.workspace_membership m
      where m.workspace_id = ws
    )
  );
end;
$$;

revoke all on function public.workspace_settings(uuid) from public, anon;
grant execute on function public.workspace_settings(uuid) to authenticated;
