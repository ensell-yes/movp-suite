import { env } from 'cloudflare:workers'

export type ServerEnv = { graphqlEndpoint: string; workspaceId: string }

export function readServerEnv(): ServerEnv {
  const graphqlEndpoint = env.GRAPHQL_ENDPOINT
  const workspaceId = env.WORKSPACE_ID
  if (!graphqlEndpoint || !workspaceId) {
    throw new Error('env_misconfigured: GRAPHQL_ENDPOINT or WORKSPACE_ID is not set')
  }
  return { graphqlEndpoint, workspaceId }
}
