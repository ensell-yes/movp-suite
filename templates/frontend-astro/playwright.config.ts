import { defineConfig, devices } from '@playwright/test'

const APP_PORT = 8788
const MOCK_PORT = 4322

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: /gotrue-auth\.spec\.ts/,
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: `node tests/mock/graphql-mock.mjs ${MOCK_PORT}`,
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        `pnpm build && pnpm exec wrangler dev --port ${APP_PORT} ` +
        `--var GRAPHQL_ENDPOINT:http://127.0.0.1:${MOCK_PORT}/graphql ` +
        `--var PUBLIC_SITE_URL:http://127.0.0.1:${APP_PORT} ` +
        `--var WORKSPACE_ID:33333333-3333-4333-8333-333333333333 ` +
        `--var SUPABASE_URL:http://127.0.0.1:${MOCK_PORT} --var SUPABASE_ANON_KEY:test-anon-key`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
