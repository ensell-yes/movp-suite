import { describe, expect, it } from 'vitest'
import {
  AGENT_ACCESS_PREFERENCES_QUERY,
  UPDATE_AGENT_ACCESS_PREFERENCES_MUTATION,
} from '../src/lib/agent-access-queries.ts'

describe('agent access GraphQL documents', () => {
  it('reads both preferences in one named query', () => {
    expect(AGENT_ACCESS_PREFERENCES_QUERY).toContain('query AgentAccessPreferences')
    expect(AGENT_ACCESS_PREFERENCES_QUERY).toMatch(/agentAccessPreferences\s*{[^}]*mcpEnabled[^}]*cliEnabled/s)
  })

  it('updates both preferences with required Boolean variables', () => {
    expect(UPDATE_AGENT_ACCESS_PREFERENCES_MUTATION).toContain(
      'mutation UpdateAgentAccessPreferences($mcpEnabled: Boolean!, $cliEnabled: Boolean!)',
    )
  })

  it('returns both authoritative values after an update', () => {
    expect(UPDATE_AGENT_ACCESS_PREFERENCES_MUTATION).toMatch(
      /updateAgentAccessPreferences\([^)]*\)\s*{[^}]*mcpEnabled[^}]*cliEnabled/s,
    )
  })

  it('never accepts a caller-supplied user id', () => {
    expect(`${AGENT_ACCESS_PREFERENCES_QUERY}\n${UPDATE_AGENT_ACCESS_PREFERENCES_MUTATION}`).not.toMatch(/userId|user_id/)
  })
})
