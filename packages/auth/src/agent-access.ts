import type { SupabaseClient } from '@supabase/supabase-js'

export interface AgentAccessPreferences {
  mcpEnabled: boolean
  cliEnabled: boolean
}

export type AgentAccessSurface = 'mcp' | 'cli'

export type AgentAccessDecision =
  | { ok: true }
  | { ok: false; code: 'mcp_access_disabled' | 'cli_access_disabled' | 'agent_access_check_failed' }

export interface AgentAccessEvaluation {
  decision: AgentAccessDecision
  attempt: 1 | 2
  latencyMs: number
}

type LookupResult =
  | { ok: true; preferences: AgentAccessPreferences }
  | { ok: false; retryable: boolean }

const RETRYABLE_STATUSES = new Set([502, 503, 504])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePreferences(value: unknown): AgentAccessPreferences | null {
  if (!isRecord(value)) return null
  if (typeof value.mcp_enabled !== 'boolean' || typeof value.cli_enabled !== 'boolean') return null
  return { mcpEnabled: value.mcp_enabled, cliEnabled: value.cli_enabled }
}

async function lookupPreferences(userId: string, admin: SupabaseClient): Promise<LookupResult> {
  let response: unknown
  try {
    response = await admin.rpc('evaluate_agent_access', { p_user_id: userId })
  } catch {
    return { ok: false, retryable: true }
  }
  if (!isRecord(response)) return { ok: false, retryable: false }
  const status = typeof response.status === 'number' ? response.status : 0
  if (response.error != null) return { ok: false, retryable: RETRYABLE_STATUSES.has(status) }
  const preferences = parsePreferences(response.data)
  return preferences ? { ok: true, preferences } : { ok: false, retryable: false }
}

export function decideAgentAccess(
  preferences: AgentAccessPreferences,
  surface: AgentAccessSurface,
): AgentAccessDecision {
  if (surface === 'mcp' && !preferences.mcpEnabled) return { ok: false, code: 'mcp_access_disabled' }
  if (surface === 'cli' && !preferences.cliEnabled) return { ok: false, code: 'cli_access_disabled' }
  return { ok: true }
}

export async function evaluateAgentAccess(
  userId: string,
  surface: AgentAccessSurface,
  admin: SupabaseClient,
): Promise<AgentAccessEvaluation> {
  const startedAt = Date.now()
  for (const attempt of [1, 2] as const) {
    const result = await lookupPreferences(userId, admin)
    if (result.ok) {
      return {
        decision: decideAgentAccess(result.preferences, surface),
        attempt,
        latencyMs: Math.max(0, Date.now() - startedAt),
      }
    }
    if (!result.retryable || attempt === 2) {
      return {
        decision: { ok: false, code: 'agent_access_check_failed' },
        attempt,
        latencyMs: Math.max(0, Date.now() - startedAt),
      }
    }
  }
  return {
    decision: { ok: false, code: 'agent_access_check_failed' },
    attempt: 2,
    latencyMs: Math.max(0, Date.now() - startedAt),
  }
}
