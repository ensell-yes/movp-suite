-- Domain Workflows Phase 7 - Part B: automation engine.

create or replace function public.get_event(ev_id uuid, ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event movp_internal.movp_events%rowtype;
begin
  if not public.is_workspace_member(ws) then
    return null;
  end if;

  select *
    into v_event
    from movp_internal.movp_events
   where id = ev_id
     and workspace_id = ws;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_event.id,
    'type', v_event.type,
    'workspace_id', v_event.workspace_id,
    'payload', v_event.payload,
    'trace_id', v_event.trace_id,
    'created_at', v_event.created_at
  );
end;
$$;

revoke all on function public.get_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_event(uuid, uuid) to authenticated, service_role;
