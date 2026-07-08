import { spawnSync } from 'node:child_process'

function readSupabaseEnv() {
  const res = spawnSync('supabase', ['status', '-o', 'env'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (res.status !== 0) {
    console.error('failed to read local Supabase status; run pnpm bootstrap first')
    process.exit(res.status ?? 1)
  }
  const cleanValue = (value) => value.replace(/^"|"$/g, '')
  return Object.fromEntries(
    res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .map((line) => {
        const eq = line.indexOf('=')
        return [line.slice(0, eq), cleanValue(line.slice(eq + 1))]
      }),
  )
}

const env = readSupabaseEnv()
const required = ['API_URL', 'ANON_KEY', 'MAILPIT_URL']
const missing = required.filter((name) => !env[name])
if (missing.length) {
  console.error(`missing local Supabase env: ${missing.join(', ')}`)
  process.exit(1)
}

const runEnv = {
  ...process.env,
  MOVP_GOTRUE_APP_PORT: process.env.MOVP_GOTRUE_APP_PORT ?? '8788',
  SUPABASE_URL: env.API_URL,
  SUPABASE_ANON_KEY: env.ANON_KEY,
  MAILPIT_URL: env.MAILPIT_URL,
  WORKSPACE_ID: '33333333-3333-3333-3333-333333333333',
}

const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.gotrue.config.ts'], {
  cwd: new URL('..', import.meta.url),
  env: runEnv,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
