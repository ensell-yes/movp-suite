create or replace function public.search_fts(ws uuid, src_table text, q text, lim int default 10)
returns table(id uuid, title text, snippet text, score real)
language plpgsql
set search_path = ''
as $$
begin
  if src_table = 'note' then
    return query
    select n.id,
           n.title,
           ts_headline('english', coalesce(n.body, n.title), plainto_tsquery('english', q)) as snippet,
           ts_rank(n.search_vector, plainto_tsquery('english', q))::real as score
      from public.note n
     where n.workspace_id = ws
       and n.search_vector @@ plainto_tsquery('english', q)
     order by score desc
     limit least(greatest(lim, 1), 100);
  elsif src_table = 'tag' then
    return query
    select t.id,
           t.name as title,
           t.name as snippet,
           ts_rank(t.search_vector, plainto_tsquery('english', q))::real as score
      from public.tag t
     where t.workspace_id = ws
       and t.search_vector @@ plainto_tsquery('english', q)
     order by score desc
     limit least(greatest(lim, 1), 100);
  else
    raise exception 'unsupported search table';
  end if;
end;
$$;

revoke all on function public.search_fts(uuid,text,text,int) from public, anon;
grant execute on function public.search_fts(uuid,text,text,int) to authenticated;
