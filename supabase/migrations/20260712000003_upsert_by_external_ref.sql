-- C5a.4 member-gated idempotent external-record upsert. INVOKER preserves RLS and triggers.
create or replace function public.upsert_by_external_ref(ws uuid, source text, external_id text, payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  result public.external_record;
begin
  if (select auth.uid()) is null or not public.is_workspace_member($1) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;

  insert into public.external_record (workspace_id, source, external_id, payload)
  values ($1, $2, $3, coalesce($4, '{}'::jsonb))
  on conflict (workspace_id, source, external_id) do update
    set payload = excluded.payload, updated_at = now()
    where public.external_record.payload is distinct from excluded.payload
  returning * into result;

  if result.id is null then
    select * into result
     from public.external_record
     where workspace_id = $1
       and source = $2
       and external_id = $3;
  end if;

  return to_jsonb(result);
end;
$$;

revoke all on function public.upsert_by_external_ref(uuid, text, text, jsonb) from public, anon;
grant execute on function public.upsert_by_external_ref(uuid, text, text, jsonb) to authenticated;
