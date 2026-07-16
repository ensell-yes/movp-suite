import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
})
