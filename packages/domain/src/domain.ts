import type {
  NoteCreate,
  NoteRow,
  NoteUpdate,
  TagCreate,
  TagRow,
  TagUpdate,
  TaskPriorityOptionCreate,
  TaskPriorityOptionRow,
  TaskPriorityOptionUpdate,
  TaskStatusOptionCreate,
  TaskStatusOptionRow,
  TaskStatusOptionUpdate,
} from './generated/types.ts'
import { makeCollabService } from './collab.ts'
import { makeCollectionService } from './collection.ts'
import { makeGraphService } from './graph.ts'
import { runSearch } from './search.ts'
import { makeTaskService } from './task.ts'
import type { Domain, DomainCtx, EmbeddingProvider } from './types.ts'

export function createDomain(ctx: DomainCtx, opts: { embedder?: EmbeddingProvider } = {}): Domain {
  return {
    note: makeCollectionService<NoteRow, NoteCreate, NoteUpdate>(ctx, { table: 'note' }),
    tag: makeCollectionService<TagRow, TagCreate, TagUpdate>(ctx, { table: 'tag' }),
    task_status_option: makeCollectionService<TaskStatusOptionRow, TaskStatusOptionCreate, TaskStatusOptionUpdate>(ctx, { table: 'task_status_option' }),
    task_priority_option: makeCollectionService<TaskPriorityOptionRow, TaskPriorityOptionCreate, TaskPriorityOptionUpdate>(ctx, { table: 'task_priority_option' }),
    task: makeTaskService(ctx),
    search: (args) => runSearch(ctx, opts.embedder, args),
    graph: makeGraphService(ctx),
    collab: makeCollabService(ctx),
  }
}
