import { env } from 'cloudflare:workers'

export type ServerEnv = {
  graphqlEndpoint: string
  workspaceId: string
  supabaseUrl: string
  supabaseAnonKey: string
  movpE2eTestAuth?: string
}

export function readServerEnv(): ServerEnv {
  const graphqlEndpoint = env.GRAPHQL_ENDPOINT
  const workspaceId = env.WORKSPACE_ID
  const supabaseUrl = env.SUPABASE_URL
  const supabaseAnonKey = env.SUPABASE_ANON_KEY
  if (!graphqlEndpoint || !workspaceId || !supabaseUrl || !supabaseAnonKey) {
    throw new Error('env_misconfigured: GRAPHQL_ENDPOINT, WORKSPACE_ID, SUPABASE_URL, or SUPABASE_ANON_KEY is not set')
  }
  return { graphqlEndpoint, workspaceId, supabaseUrl, supabaseAnonKey, movpE2eTestAuth: env.MOVP_E2E_TEST_AUTH }
}
