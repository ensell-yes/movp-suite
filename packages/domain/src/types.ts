import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CommentRow,
  NoteCreate,
  NoteRow,
  NoteUpdate,
  TagCreate,
  TagRow,
  TagUpdate,
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

export interface Domain {
  note: CollectionService<NoteRow, NoteCreate, NoteUpdate>
  tag: CollectionService<TagRow, TagCreate, TagUpdate>
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
  collab: CollabService
}
