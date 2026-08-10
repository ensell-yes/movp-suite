import { env } from 'cloudflare:workers'

export type ServerEnv = {
  graphqlEndpoint: string
  publicSiteUrl: string
  workspaceId: string
  supabaseUrl: string
  supabaseAnonKey: string
}

type DeliveryAssignmentEnv = Readonly<{
  DELIVERY_ASSIGNMENT_SIGNING_KEY?: string
}>

const deliveryAssignmentEnv: DeliveryAssignmentEnv = env

const encoder = new TextEncoder()

export function readServerEnv(): ServerEnv {
  const graphqlEndpoint = env.GRAPHQL_ENDPOINT
  const publicSiteUrl = env.PUBLIC_SITE_URL
  const workspaceId = env.WORKSPACE_ID
  const supabaseUrl = env.SUPABASE_URL
  const supabaseAnonKey = env.SUPABASE_ANON_KEY
  if (!graphqlEndpoint || !publicSiteUrl || !workspaceId || !supabaseUrl || !supabaseAnonKey) {
    throw new Error('env_misconfigured: GRAPHQL_ENDPOINT, PUBLIC_SITE_URL, WORKSPACE_ID, SUPABASE_URL, or SUPABASE_ANON_KEY is not set')
  }
  return { graphqlEndpoint, publicSiteUrl, workspaceId, supabaseUrl, supabaseAnonKey }
}

export function readDeliveryAssignmentSigningKey(): string | null {
  const signingKey = deliveryAssignmentEnv.DELIVERY_ASSIGNMENT_SIGNING_KEY
  if (
    typeof signingKey !== 'string'
    || encoder.encode(signingKey).byteLength < 32
    || encoder.encode(signingKey).byteLength > 512
  ) {
    return null
  }
  return signingKey
}
