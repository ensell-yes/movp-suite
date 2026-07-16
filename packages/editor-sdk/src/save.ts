// CLIENT-SAFE. Recognizes the domain conflict by string shape ONLY — never import
// @movp/domain, @movp/graphql, or @supabase. Non-conflict failures normalize to a fixed
// classifier; the raw error text (which may carry endpoint/host/token) is dropped.

/** The result the host's SaveHandler resolves to. Discriminated union — no sentinels. */
export type SaveResult =
  | { status: 'saved'; revisionId: string }
  | { status: 'conflict' }
  | { status: 'error'; code: 'save_failed' }

/** The host implements this (server-side, via content.update); the SDK only calls it. */
export type SaveHandler = (body: string) => Promise<SaveResult>

const hasConflictCode = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const ext = (value as { extensions?: unknown }).extensions
  return typeof ext === 'object' && ext !== null && (ext as { code?: unknown }).code === 'CONFLICT'
}

/** Map a caught save error to a SaveResult. Conflict is retryable via refresh; everything else is terminal. */
export function classifySaveOutcome(err: unknown): SaveResult {
  const message = err instanceof Error ? err.message : ''
  if (message.includes('content_update_conflict') || hasConflictCode(err)) {
    return { status: 'conflict' }
  }
  return { status: 'error', code: 'save_failed' }
}
