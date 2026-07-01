-- Collaboration Phase 2 - Part A. Sorts AFTER 20260701000005_async_rpcs.sql.
-- Hand-authored: composite uniques + entity indexes codegen cannot emit,
-- can_access_entity(), fine-grained RLS overrides, and lifecycle triggers.

-- Composite uniques + entity indexes (codegen cannot emit these).
alter table public.reaction
  add constraint reaction_uniq unique (workspace_id, user_id, entity_type, entity_id, kind);
alter table public.saved_item
  add constraint saved_item_uniq unique (workspace_id, user_id, entity_type, entity_id);
alter table public.share_link
  add constraint share_link_token_uniq unique (workspace_id, token_hash);

create index comment_entity_idx    on public.comment    (entity_type, entity_id);
create index reaction_entity_idx   on public.reaction   (entity_type, entity_id);
create index saved_item_entity_idx on public.saved_item (entity_type, entity_id);
create index mention_entity_idx    on public.mention    (entity_type, entity_id);

-- can_access_entity: authoritative entity-visibility gate.
-- SECURITY DEFINER so the existence probe bypasses RLS; hardened with an empty
-- search_path and fully schema-qualified names. Parameters are qualified with the
-- function name to avoid collisions with same-named table columns.
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
  -- Base gate: the caller must be a member of the workspace.
  if not public.is_workspace_member(ws) then
    return false;
  end if;

  -- Per-entity_type dispatch. Extension seam: future app phases add explicit
  -- arms before their collaboration surfaces go live.
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
    else
      -- Unknown entity_type: fail closed.
      return false;
  end case;

  return v_exists;
end;
$$;

revoke all on function public.can_access_entity(text, uuid, uuid) from public, anon;
grant execute on function public.can_access_entity(text, uuid, uuid) to authenticated;

-- Fine-grained RLS: replace the generated <name>_rw blanket policies.
-- comment: readable by anyone who can access the entity; writable only by its author.
drop policy if exists comment_rw on public.comment;
create policy comment_select on public.comment for select to authenticated
  using (public.can_access_entity(entity_type, entity_id, workspace_id));
create policy comment_insert on public.comment for insert to authenticated
  with check (author_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
create policy comment_update on public.comment for update to authenticated
  using (author_id = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id))
  with check (author_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
create policy comment_delete on public.comment for delete to authenticated
  using (author_id = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id));

-- reaction: readable by anyone who can access the entity; each user owns theirs.
drop policy if exists reaction_rw on public.reaction;
create policy reaction_select on public.reaction for select to authenticated
  using (public.can_access_entity(entity_type, entity_id, workspace_id));
create policy reaction_insert on public.reaction for insert to authenticated
  with check (user_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));
create policy reaction_delete on public.reaction for delete to authenticated
  using (user_id = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id));

-- saved_item: strictly owner-only (private bookmarks).
drop policy if exists saved_item_rw on public.saved_item;
create policy saved_item_all on public.saved_item for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));

-- mention: visible to anyone who can access the entity, or to a mentioned member.
drop policy if exists mention_rw on public.mention;
create policy mention_select on public.mention for select to authenticated
  using (
    public.can_access_entity(entity_type, entity_id, workspace_id)
    or (mentioned_user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  );
-- mention_insert: only the referenced comment's author can mint mentions, and
-- recipients must be workspace members.
create policy mention_insert on public.mention for insert to authenticated
  with check (
    public.can_access_entity(mention.entity_type, mention.entity_id, mention.workspace_id)
    and exists (
      select 1 from public.comment c
      where c.id = mention.comment_id
        and c.workspace_id = mention.workspace_id
        and c.entity_type  = mention.entity_type
        and c.entity_id    = mention.entity_id
        and c.author_id    = (select auth.uid())
    )
    and exists (
      select 1 from public.workspace_membership m
      where m.workspace_id = mention.workspace_id
        and m.user_id      = mention.mentioned_user_id
    )
  );

-- share_link: managed only by its creator, who must be able to access the entity.
drop policy if exists share_link_rw on public.share_link;
create policy share_link_all on public.share_link for all to authenticated
  using (created_by = (select auth.uid())
         and public.can_access_entity(entity_type, entity_id, workspace_id))
  with check (created_by = (select auth.uid())
              and public.can_access_entity(entity_type, entity_id, workspace_id));

-- Lifecycle triggers: fan out through public.emit_event (from 000005).
create or replace function public.comment_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    case when new.parent_id is not null then 'comment.replied' else 'comment.added' end,
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'author_id', new.author_id,
      'parent_id', new.parent_id
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.comment_emit_event() from public, anon, authenticated;

drop trigger if exists comment_emit_event_tg on public.comment;
create trigger comment_emit_event_tg
  after insert on public.comment
  for each row execute function public.comment_emit_event();

create or replace function public.mention_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'user.mentioned',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'comment_id', new.comment_id,
      'mentioned_user_id', new.mentioned_user_id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'recipient_user_id', new.mentioned_user_id
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.mention_emit_event() from public, anon, authenticated;

drop trigger if exists mention_emit_event_tg on public.mention;
create trigger mention_emit_event_tg
  after insert on public.mention
  for each row execute function public.mention_emit_event();

create or replace function public.reaction_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    case when new.kind = 'like' then 'item.liked' else 'item.disliked' end,
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'user_id', new.user_id,
      'kind', new.kind
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.reaction_emit_event() from public, anon, authenticated;

drop trigger if exists reaction_emit_event_tg on public.reaction;
create trigger reaction_emit_event_tg
  after insert on public.reaction
  for each row execute function public.reaction_emit_event();

create or replace function public.saved_item_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'item.saved',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'user_id', new.user_id
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.saved_item_emit_event() from public, anon, authenticated;

drop trigger if exists saved_item_emit_event_tg on public.saved_item;
create trigger saved_item_emit_event_tg
  after insert on public.saved_item
  for each row execute function public.saved_item_emit_event();

create or replace function public.share_link_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'item.shared',
    new.workspace_id,
    jsonb_build_object(
      'id', new.id,
      'entity_type', new.entity_type,
      'entity_id', new.entity_id,
      'created_by', new.created_by,
      'scope', new.scope
    ),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.share_link_emit_event() from public, anon, authenticated;

drop trigger if exists share_link_emit_event_tg on public.share_link;
create trigger share_link_emit_event_tg
  after insert on public.share_link
  for each row execute function public.share_link_emit_event();
