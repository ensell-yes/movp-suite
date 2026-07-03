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

-- RLS overrides: tighten the internal task tables.
-- KEEP the generated task_rw is_workspace_member policy for public.task.

drop policy if exists task_revision_rw on public.task_revision;
create policy task_revision_select on public.task_revision for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_revision_insert on public.task_revision for insert to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists task_status_history_rw on public.task_status_history;
create policy task_status_history_select on public.task_status_history for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_status_history_insert on public.task_status_history for insert to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists task_assignment_rw on public.task_assignment;
create policy task_assignment_select on public.task_assignment for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_assignment_insert on public.task_assignment for insert to authenticated
  with check (
    public.is_workspace_member(task_assignment.workspace_id)
    and public.can_access_entity('task', task_assignment.task_id, task_assignment.workspace_id)
    and exists (
      select 1 from public.workspace_membership m
      where m.workspace_id = task_assignment.workspace_id
        and m.user_id = task_assignment.assignee_user_id
    )
  );
create policy task_assignment_delete on public.task_assignment for delete to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists task_observer_rw on public.task_observer;
create policy task_observer_select on public.task_observer for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_observer_insert on public.task_observer for insert to authenticated
  with check (
    public.is_workspace_member(task_observer.workspace_id)
    and public.can_access_entity('task', task_observer.task_id, task_observer.workspace_id)
    and exists (
      select 1 from public.workspace_membership m
      where m.workspace_id = task_observer.workspace_id
        and m.user_id = task_observer.observer_user_id
    )
  );
create policy task_observer_delete on public.task_observer for delete to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists task_dependency_rw on public.task_dependency;
create policy task_dependency_select on public.task_dependency for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_dependency_insert on public.task_dependency for insert to authenticated
  with check (
    public.is_workspace_member(task_dependency.workspace_id)
    and public.can_access_entity('task', task_dependency.task_id, task_dependency.workspace_id)
    and public.can_access_entity('task', task_dependency.blocker_id, task_dependency.workspace_id)
  );
create policy task_dependency_delete on public.task_dependency for delete to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists task_attachment_rw on public.task_attachment;
create policy task_attachment_select on public.task_attachment for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_attachment_insert on public.task_attachment for insert to authenticated
  with check (
    public.can_access_entity('task', task_attachment.task_id, task_attachment.workspace_id)
    and task_attachment.uploaded_by = (select auth.uid())
  );
create policy task_attachment_delete on public.task_attachment for delete to authenticated
  using (
    public.is_workspace_member(task_attachment.workspace_id)
    and task_attachment.uploaded_by = (select auth.uid())
  );

drop policy if exists task_status_option_rw on public.task_status_option;
create policy task_status_option_select on public.task_status_option for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_status_option_insert on public.task_status_option for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy task_status_option_update on public.task_status_option for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists task_priority_option_rw on public.task_priority_option;
create policy task_priority_option_select on public.task_priority_option for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy task_priority_option_insert on public.task_priority_option for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy task_priority_option_update on public.task_priority_option for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
