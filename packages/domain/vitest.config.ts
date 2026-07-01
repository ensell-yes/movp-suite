import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

function stackEnv(): Record<string, string> {
  let out: string
  try {
    out = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8' })
  } catch {
    throw new Error('`supabase status` failed - run `supabase start` before `pnpm --filter @movp/domain test`')
  }
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)
    if (m) map.set(m[1], m[2])
  }
  const url = map.get('API_URL')
  const anon = map.get('ANON_KEY')
  const service = map.get('SERVICE_ROLE_KEY')
  if (!url || !anon || !service) {
    throw new Error(`supabase status missing API_URL/ANON_KEY/SERVICE_ROLE_KEY; found: ${[...map.keys()].join(', ')}`)
  }
  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service }
}

export default defineConfig({
  test: {
    environment: 'node',
    env: stackEnv(),
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
})
