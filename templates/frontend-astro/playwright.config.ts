import { defineConfig, devices } from '@playwright/test'

const APP_PORT = 8788
const MOCK_PORT = 4322

export default defineConfig({
  testDir: './tests/e2e',
  // The mock GraphQL server keeps one process-wide scenario; parallel workers race that state.
  workers: 1,
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
        `--var GRAPHQL_ENDPOINT:http://127.0.0.1:${MOCK_PORT}/graphql --var WORKSPACE_ID:w`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
