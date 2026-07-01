\set ON_ERROR_STOP on

drop index if exists public.search_chunk_hnsw;

do $$
declare n bigint;
begin
  select count(*) into n from public.search_chunk;
  if n < 500000 then
    insert into public.workspace (id, name)
      select gen_random_uuid(), 'vs-ws-' || g from generate_series(1,10) g;

    insert into public.search_chunk
      (workspace_id, source_table, source_id, field, chunk_index, content, embedding, content_hash)
    select w.id, 'note', gen_random_uuid(), 'body', 0, 'chunk',
           (select ('[' || string_agg('0.001', ',') || ']')::extensions.vector(384) from generate_series(1,384)),
           md5(w.id::text || ':' || s::text)
      from (select id from public.workspace where name like 'vs-ws-%' limit 10) w,
           generate_series(1,50000) s;
  end if;
end $$;

create index if not exists search_chunk_hnsw on public.search_chunk using hnsw (embedding extensions.vector_cosine_ops);
analyze public.search_chunk;
set hnsw.iterative_scan = strict_order;

select id as ws from public.workspace where name like 'vs-ws-%' order by name limit 1 \gset
select embedding as qvec from public.search_chunk where workspace_id = :'ws' limit 1 \gset

\echo === EXPLAIN BEGIN ===
explain (format text)
select c.source_id, (c.embedding <=> :'qvec') as distance
from public.search_chunk c
where c.workspace_id = :'ws'
order by c.embedding <=> :'qvec'
limit 10;
\echo === EXPLAIN END ===

\echo === CROSSTENANT BEGIN ===
select count(*) as foreign_rows
from public.match_chunks(:'qvec', :'ws', null, 10) m
join public.search_chunk c
  on c.source_id = m.source_id and c.field = m.field and c.chunk_index = m.chunk_index
where c.workspace_id <> :'ws';
\echo === CROSSTENANT END ===
