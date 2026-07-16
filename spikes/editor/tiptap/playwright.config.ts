import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  globalTimeout: 60_000,
  webServer: { command: 'vite --port 5312', port: 5312, reuseExistingServer: false },
  use: { baseURL: 'http://localhost:5312', channel: 'chrome' },
})
