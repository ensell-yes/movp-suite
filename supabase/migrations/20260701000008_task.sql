-- Task Management Phase 3 - Part A. Sorts AFTER 20260701000007_collaboration_rpcs.sql.
-- Hand-authored: the circular task<->task_revision back-FK, uniques/guards + hot-path
-- indexes codegen cannot emit, the can_access_entity 'task' arm, hardened RLS overrides,
-- and the per-workspace default-option seeding trigger.

-- back-FK codegen cannot inline (task <-> task_revision is circular)
alter table public.task
  add constraint task_current_revision_fk
  foreign key (current_revision_id) references public.task_revision(id) on delete set null;

-- composite uniques + guards codegen cannot emit
alter table public.task_assignment
  add constraint task_assignment_uniq unique (task_id, assignee_user_id);
alter table public.task_observer
  add constraint task_observer_uniq unique (task_id, observer_user_id);
alter table public.task_dependency
  add constraint task_dependency_uniq unique (task_id, blocker_id);
alter table public.task_dependency
  add constraint task_dependency_no_self check (task_id <> blocker_id);
alter table public.task_revision
  add constraint task_revision_content_uniq unique (task_id, content_hash);

-- One default status option and one default priority option per workspace.
create unique index task_status_option_default_uniq
  on public.task_status_option (workspace_id) where is_default;
create unique index task_priority_option_default_uniq
  on public.task_priority_option (workspace_id) where is_default;

-- hot-path indexes
create index task_ws_status_idx           on public.task            (workspace_id, status_id);
create index task_parent_idx              on public.task            (parent_id);
create index task_due_open_idx            on public.task            (due_date) where completed_at is null;
create index task_assignment_assignee_idx on public.task_assignment (assignee_user_id);
create index task_dependency_blocker_idx  on public.task_dependency (blocker_id);

-- can_access_entity: add the 'task' arm (re-declares the full function).
-- Verbatim copy of the 20260701000006 body with a 'task' branch added before the
-- else. SECURITY DEFINER so the existence probe bypasses RLS; empty search_path;
-- params qualified with the function name to avoid collisions with same-named columns.
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
    when 'task' then
      select exists (
        select 1 from public.task t
        where t.id = can_access_entity.entity_id
          and t.workspace_id = can_access_entity.ws
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
