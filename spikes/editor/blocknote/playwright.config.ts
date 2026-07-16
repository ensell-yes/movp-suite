import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  globalTimeout: 60_000,
  webServer: { command: 'vite --port 5311', port: 5311, reuseExistingServer: false },
  use: { baseURL: 'http://localhost:5311', channel: 'chrome' },
})
