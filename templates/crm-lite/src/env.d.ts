/// <reference types="astro/client" />

type CfEnv = {
  GRAPHQL_ENDPOINT: string
  WORKSPACE_ID: string
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  MEDIA_BUCKET: R2Bucket
  ASSETS: Fetcher
}

declare module 'cloudflare:workers' {
  export const env: CfEnv
}

