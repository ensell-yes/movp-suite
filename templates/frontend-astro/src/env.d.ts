/// <reference types="astro/client" />

type CfEnv = {
  GRAPHQL_ENDPOINT: string
  WORKSPACE_ID: string
  MEDIA_BUCKET: R2Bucket
  ASSETS: Fetcher
}

declare module 'cloudflare:workers' {
  export const env: CfEnv
}
