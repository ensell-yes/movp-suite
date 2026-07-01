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
