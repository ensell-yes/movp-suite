import type { SupabaseClient } from '@supabase/supabase-js'

export interface MovpEvent {
  type: string
  workspaceId: string
  payload: Record<string, unknown>
  traceId: string
}

export async function emitEvent(db: SupabaseClient, e: MovpEvent): Promise<void> {
  const { error } = await db.rpc('emit_event', {
    ev_type: e.type,
    ws: e.workspaceId,
    payload: e.payload,
    trace: e.traceId,
  })
  if (error) throw new Error(`emit_event_failed:${error.code ?? 'unknown'}`)
}
