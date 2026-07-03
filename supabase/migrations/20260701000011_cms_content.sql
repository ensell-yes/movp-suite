-- CMS Phase 4 - Part A. Sorts AFTER 20260701000010_task_rpcs.sql.
-- Hand-authored: circular content_item<->content_revision pointer FKs, uniques,
-- hot-path indexes, content_revision immutability, can_access_entity content arm,
-- and search_fts content_item arm.

alter table public.content_item
  add constraint content_item_current_revision_fk
  foreign key (current_revision_id) references public.content_revision(id) on delete set null;
alter table public.content_item
  add constraint content_item_approved_revision_fk
  foreign key (approved_revision_id) references public.content_revision(id) on delete set null;
alter table public.content_item
  add constraint content_item_published_revision_fk
  foreign key (published_revision_id) references public.content_revision(id) on delete set null;

alter table public.content_item
  add constraint content_item_type_slug_uniq unique (workspace_id, content_type_id, slug);
alter table public.content_revision
  add constraint content_revision_number_uniq unique (content_item_id, revision_number);
alter table public.content_revision
  add constraint content_revision_content_uniq unique (content_item_id, content_hash);

create index content_item_type_idx on public.content_item (workspace_id, content_type_id);
create index content_item_status_idx on public.content_item (workspace_id, status);
create index content_revision_item_idx on public.content_revision (content_item_id);

drop policy if exists content_revision_rw on public.content_revision;
create policy content_revision_select on public.content_revision for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_revision_insert on public.content_revision for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and author_id = (select auth.uid())
  );

create or replace function public.content_revision_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'content_revision is append-only and immutable (tamper-evidence)'
    using errcode = '2F004';
end;
$$;
revoke all on function public.content_revision_immutable() from public, anon, authenticated;

create trigger content_revision_no_mutate
  before update or delete on public.content_revision
  for each row execute function public.content_revision_immutable();

create or replace function public.can_access_entity(entity_type text, entity_id uuid, ws uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  if not public.is_workspace_member(ws) then
    return false;
  end if;

  case entity_type
    when 'note' then
      select exists (
        select 1 from public.note n
        where n.id = can_access_entity.entity_id
          and n.workspace_id = can_access_entity.ws
      ) into v_exists;
    when 'comment' then
      select exists (
        select 1 from public.comment c
        where c.id = can_access_entity.entity_id
          and c.workspace_id = can_access_entity.ws
      ) into v_exists;
    when 'task' then
      select exists (
        select 1 from public.task t
        where t.id = can_access_entity.entity_id
          and t.workspace_id = can_access_entity.ws
      ) into v_exists;
    when 'content_item' then
      select exists (
        select 1 from public.content_item ci
        where ci.id = can_access_entity.entity_id
          and ci.workspace_id = can_access_entity.ws
      ) into v_exists;
    else
      return false;
  end case;

  return v_exists;
end;
$$;
revoke all on function public.can_access_entity(text, uuid, uuid) from public, anon;
grant execute on function public.can_access_entity(text, uuid, uuid) to authenticated;

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
  elsif src_table = 'content_item' then
    return query
    select ci.id,
           ci.search_text as title,
           ts_headline('english', coalesce(ci.search_body, ci.search_text, ''), plainto_tsquery('english', q)) as snippet,
           ts_rank(ci.search_vector, plainto_tsquery('english', q))::real as score
      from public.content_item ci
     where ci.workspace_id = ws
       and ci.search_vector @@ plainto_tsquery('english', q)
     order by score desc
     limit least(greatest(lim, 1), 100);
  else
    raise exception 'unsupported search table';
  end if;
end;
$$;
revoke all on function public.search_fts(uuid,text,text,int) from public, anon;
grant execute on function public.search_fts(uuid,text,text,int) to authenticated;
