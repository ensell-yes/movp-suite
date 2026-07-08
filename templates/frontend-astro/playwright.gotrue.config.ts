import { defineConfig, devices } from '@playwright/test'

const APP_PORT = Number(process.env.MOVP_GOTRUE_APP_PORT ?? 8790)
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.API_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT ?? `${SUPABASE_URL}/functions/v1/graphql`
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? '33333333-3333-3333-3333-333333333333'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('missing_env: SUPABASE_URL/API_URL and SUPABASE_ANON_KEY/ANON_KEY are required')
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /gotrue-auth\.spec\.ts/,
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command:
      `pnpm build && pnpm exec wrangler dev --port ${APP_PORT} ` +
      `--var GRAPHQL_ENDPOINT:${GRAPHQL_ENDPOINT} --var WORKSPACE_ID:${WORKSPACE_ID} ` +
      `--var SUPABASE_URL:${SUPABASE_URL} --var SUPABASE_ANON_KEY:${SUPABASE_ANON_KEY}`,
    url: `http://127.0.0.1:${APP_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
