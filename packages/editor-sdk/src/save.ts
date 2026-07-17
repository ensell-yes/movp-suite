// CLIENT-SAFE. Recognizes the domain conflict by string shape ONLY — never import
// @movp/domain, @movp/graphql, or @supabase. Non-conflict failures normalize to a fixed
// classifier; the raw error text (which may carry endpoint/host/token) is dropped.

/** The result the host's SaveHandler resolves to. Discriminated union — no sentinels. */
export type SaveResult =
  | { status: 'saved'; revisionId: string }
  | { status: 'conflict' }
  | { status: 'error'; code: 'save_failed' }

/**
 * The host implements this via content.update. It must translate transport-specific conflicts into
 * `{ status: 'conflict' }`; transport errors are deliberately not inferred by this client package.
 */
export type SaveHandler = (body: string) => Promise<SaveResult>

/** Map a caught save error to a SaveResult. Conflict is retryable via refresh; everything else is terminal. */
export function classifySaveOutcome(err: unknown): SaveResult {
  const message = err instanceof Error ? err.message : ''
  if (message.includes('content_update_conflict')) {
    return { status: 'conflict' }
  }
  return { status: 'error', code: 'save_failed' }
}
