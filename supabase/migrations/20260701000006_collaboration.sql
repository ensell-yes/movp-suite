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
