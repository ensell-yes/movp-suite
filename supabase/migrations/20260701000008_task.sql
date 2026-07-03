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
