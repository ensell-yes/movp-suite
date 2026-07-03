export type TaskRow = {
  id: string
  title: string
  status_id: string | null
  priority_id?: string | null
  parent_id?: string | null
  current_revision_id?: string | null
  description?: string | null
  due_date: string | null
  dependency_blocked?: boolean | null
  completed_at?: string | null
}

export type TaskPage = { items: TaskRow[]; nextCursor: string | null }
export type TaskStatus = { id: string; label: string; category: string; sort_order: string | number | null }
export type TaskBoardColumn = { status: TaskStatus; tasks: TaskRow[] }
export type CommentRow = { id: string; body: string | null; author_id: string | null; created_at: string }
export type InboxItem = { kind: string; entity_type: string; entity_id: string; ref_id: string; created_at: string }

export const TASKS_QUERY = /* GraphQL */ `
  query Tasks($workspaceId: ID!, $first: Int) {
    tasks(workspaceId: $workspaceId, first: $first) { items { id title status_id due_date } nextCursor }
  }`

export const TASK_BOARD_QUERY = /* GraphQL */ `
  query TaskBoard($workspaceId: ID!) {
    taskBoard(workspaceId: $workspaceId) { status { id label category sort_order } tasks { id title due_date } }
  }`

export const TASK_QUERY = /* GraphQL */ `
  query Task($id: ID!) {
    task(id: $id) { id title description status_id priority_id parent_id due_date dependency_blocked completed_at }
  }`

export const INBOX_QUERY = /* GraphQL */ `
  query Inbox($workspaceId: ID!, $tab: String!) {
    inbox(workspaceId: $workspaceId, tab: $tab) { kind entity_type entity_id ref_id created_at }
  }`

export const COMMENTS_QUERY = /* GraphQL */ `
  query Comments($workspaceId: ID!, $entityType: String!, $entityId: ID!) {
    comments(workspaceId: $workspaceId, entityType: $entityType, entityId: $entityId) { id body author_id created_at }
  }`

export const SUBTASKS_QUERY = /* GraphQL */ `
  query Subtasks($workspaceId: ID!, $parentId: ID!) {
    tasks(workspaceId: $workspaceId, parentId: $parentId) { items { id title status_id } nextCursor }
  }`
