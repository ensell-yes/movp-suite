import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CommentRow,
  ContentApprovalRow,
  ContentItemRow,
  ContentRevisionRow,
  ContentScheduleRow,
  ContentTypeRow,
  NoteCreate,
  NoteRow,
  NoteUpdate,
  TagCreate,
  TagRow,
  TagUpdate,
  TaskPriorityOptionCreate,
  TaskPriorityOptionRow,
  TaskPriorityOptionUpdate,
  TaskRow,
  TaskStatusOptionCreate,
  TaskStatusOptionRow,
  TaskStatusOptionUpdate,
} from './generated/types.ts'

export interface DomainCtx {
  db: SupabaseClient
  userId: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface ListArgs {
  workspaceId: string
  first?: number
  after?: string | null
}

export interface SearchArgs {
  workspaceId: string
  query: string
  mode?: 'fts' | 'semantic' | 'hybrid'
  collection?: string
  limit?: number
}

export interface SearchHit {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

export interface CollectionService<Row, Create, Update> {
  create(input: Create): Promise<Row>
  get(id: string): Promise<Row | null>
  list(args: ListArgs): Promise<Page<Row>>
  update(id: string, patch: Update): Promise<Row>
  delete(id: string): Promise<void>
}

export interface GraphService {
  link(a: {
    workspaceId: string
    srcType: string
    srcId: string
    rel: string
    dstType: string
    dstId: string
  }): Promise<void>
  traverse(a: {
    workspaceId: string
    srcType: string
    srcId: string
    rel?: string
    depth?: number
  }): Promise<Array<{ type: string; id: string; depth: number }>>
}

export interface InboxItem {
  kind: string
  entity_type: string
  entity_id: string
  ref_id: string
  created_at: string
  payload: Record<string, unknown>
}

export interface CollabService {
  comment: {
    create(input: {
      entityType: string
      entityId: string
      body: string
      parentId?: string
      mentions?: string[]
    }): Promise<CommentRow>
    listByEntity(a: {
      workspaceId: string
      entityType: string
      entityId: string
      first?: number
      after?: string | null
    }): Promise<Page<CommentRow>>
  }
  react(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  unreact(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  save(i: { entityType: string; entityId: string }): Promise<void>
  unsave(i: { entityType: string; entityId: string }): Promise<void>
  createShareLink(i: { entityType: string; entityId: string; expiresInHours?: number }): Promise<{ token: string }>
  inbox(a: { workspaceId: string; tab: 'all' | 'mentions' | 'saved' | 'assigned'; first?: number }): Promise<InboxItem[]>
}

export interface TaskBoardColumn {
  status: TaskStatusOptionRow
  tasks: TaskRow[]
}

export interface TaskService {
  create(i: { workspaceId: string; title: string; description?: string; statusId?: string; priorityId?: string; parentId?: string; startDate?: string; dueDate?: string }): Promise<TaskRow>
  get(id: string): Promise<TaskRow | null>
  list(a: { workspaceId: string; statusId?: string; assigneeId?: string; parentId?: string | null; first?: number; after?: string | null }): Promise<Page<TaskRow>>
  board(a: { workspaceId: string }): Promise<TaskBoardColumn[]>
  updateDescription(id: string, body: string): Promise<TaskRow>
  assign(i: { taskId: string; userId: string }): Promise<void>
  unassign(i: { taskId: string; userId: string }): Promise<void>
  addObserver(i: { taskId: string; userId: string }): Promise<void>
  removeObserver(i: { taskId: string; userId: string }): Promise<void>
  transition(i: { taskId: string; statusId: string }): Promise<TaskRow>
  addDependency(i: { taskId: string; blockerId: string }): Promise<void>
  removeDependency(i: { taskId: string; blockerId: string }): Promise<void>
  attach(i: { taskId: string; r2Key: string; filename: string; contentType?: string; bytes?: number }): Promise<void>
}

export interface ContentService {
  createType(i: { workspaceId: string; key: string; label: string; fieldSchema: unknown; moderationPolicy?: string; approvalPolicy?: string }): Promise<ContentTypeRow>
  listTypes(a: { workspaceId: string; first?: number; after?: string | null }): Promise<Page<ContentTypeRow>>
  create(i: { workspaceId: string; contentTypeId: string; slug: string; data: Record<string, unknown> }): Promise<ContentItemRow>
  update(i: { itemId: string; data: Record<string, unknown> }): Promise<ContentItemRow>
  get(id: string): Promise<ContentItemRow | null>
  list(a: { workspaceId: string; contentTypeId?: string; status?: string; first?: number; after?: string | null }): Promise<Page<ContentItemRow>>
  listRevisions(a: { itemId: string; first?: number; after?: string | null }): Promise<Page<ContentRevisionRow>>
  submitForApproval(i: { itemId: string; policy?: 'single' | 'multi' | 'moderation'; approvalsRequired?: number }): Promise<ContentItemRow>
  decideApproval(i: { approvalId: string; vote: 'approve' | 'reject' }): Promise<ContentApprovalRow>
  publish(i: { itemId: string }): Promise<ContentItemRow>
  unpublish(i: { itemId: string }): Promise<ContentItemRow>
  getPublished(id: string): Promise<{ item: ContentItemRow; revision: ContentRevisionRow } | null>
  listApprovals(a: { workspaceId: string; itemId?: string; state?: 'pending' | 'approved' | 'rejected' | 'superseded'; first?: number; after?: string | null }): Promise<Page<ContentApprovalRow>>
  schedule(i: { itemId: string; action: 'publish' | 'unpublish'; revisionId: string; runAt: string }): Promise<ContentScheduleRow>
}

export interface Domain {
  note: CollectionService<NoteRow, NoteCreate, NoteUpdate>
  tag: CollectionService<TagRow, TagCreate, TagUpdate>
  task_status_option: CollectionService<TaskStatusOptionRow, TaskStatusOptionCreate, TaskStatusOptionUpdate>
  task_priority_option: CollectionService<TaskPriorityOptionRow, TaskPriorityOptionCreate, TaskPriorityOptionUpdate>
  task: TaskService
  content: ContentService
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
  collab: CollabService
}
