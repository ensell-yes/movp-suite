-- External BI seam. Shipped inert and granted to no reader by default.
-- The generated reporting_bi views bypass RLS and expose all workspaces, but project
-- only the explicit columns already selected by the reporting views.
create or replace function reporting.setup_bi_mirror()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  view record;
  created_count int := 0;
begin
  if (select auth.role()) is distinct from 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'reserved_for_operator' using errcode = '42501';
  end if;

  execute 'create schema if not exists reporting_bi';
  execute 'revoke all on schema reporting_bi from public';

  for view in
    select c.relname as viewname, pg_catalog.pg_get_viewdef(c.oid, true) as definition
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'reporting'
       and c.relkind = 'v'
  loop
    execute pg_catalog.format(
      'create or replace view reporting_bi.%I as %s',
      view.viewname,
      view.definition
    );
    created_count := created_count + 1;
  end loop;
  return created_count;
end;
$$;
revoke all on function reporting.setup_bi_mirror() from public, anon, authenticated;
grant execute on function reporting.setup_bi_mirror() to service_role;
