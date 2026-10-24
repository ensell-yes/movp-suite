import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
  },
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
})
