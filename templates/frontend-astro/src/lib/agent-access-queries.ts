export type AgentAccessPreferences = {
  mcpEnabled: boolean
  cliEnabled: boolean
}

export const AGENT_ACCESS_PREFERENCES_QUERY = /* GraphQL */ `
  query AgentAccessPreferences {
    agentAccessPreferences { mcpEnabled cliEnabled }
  }
`

export const UPDATE_AGENT_ACCESS_PREFERENCES_MUTATION = /* GraphQL */ `
  mutation UpdateAgentAccessPreferences($mcpEnabled: Boolean!, $cliEnabled: Boolean!) {
    updateAgentAccessPreferences(mcpEnabled: $mcpEnabled, cliEnabled: $cliEnabled) {
      mcpEnabled
      cliEnabled
    }
  }
`
