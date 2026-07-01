export type Surface = 'graphql' | 'mcp' | 'cli' | 'flows' | 'embed'

export interface ObsEvent {
  trace_id: string
  request_id: string
  workspace_id_hash?: string
  actor_id?: string
  actor_email_hash?: string
  surface: Surface
  operation: string
  collection?: string
  error_code: string
  latency_ms?: number
  attempt?: number
  redaction_version: number
}

export const REDACTION_VERSION = 1
