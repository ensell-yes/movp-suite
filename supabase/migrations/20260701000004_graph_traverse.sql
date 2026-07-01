create or replace function public.traverse_edges(
  ws uuid,
  start_type text,
  start_id uuid,
  rel_filter text default null,
  max_depth int default 3
)
returns table(type text, id uuid, depth int)
language sql
set search_path = ''
as $$
  with recursive walk(type, id, depth, path) as (
    select start_type, start_id, 0, array[start_type || ':' || start_id::text]
    union all
    select e.dst_type, e.dst_id, w.depth + 1, path || (e.dst_type || ':' || e.dst_id::text)
      from walk w
      join public.edges e
        on e.workspace_id = ws
       and e.src_type = w.type
       and e.src_id = w.id
       and (rel_filter is null or e.rel = rel_filter)
     where w.depth < least(greatest(max_depth, 1), 10)
       and not (e.dst_type || ':' || e.dst_id::text = any(path))
  )
  select walk.type, walk.id, walk.depth from walk where walk.depth > 0;
$$;

revoke all on function public.traverse_edges(uuid,text,uuid,text,int) from public, anon;
grant execute on function public.traverse_edges(uuid,text,uuid,text,int) to authenticated;
