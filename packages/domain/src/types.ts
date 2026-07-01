import type { SupabaseClient } from '@supabase/supabase-js'
import type { NoteCreate, NoteRow, NoteUpdate, TagCreate, TagRow, TagUpdate } from './generated/types.ts'

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

export interface Domain {
  note: CollectionService<NoteRow, NoteCreate, NoteUpdate>
  tag: CollectionService<TagRow, TagCreate, TagUpdate>
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
}
