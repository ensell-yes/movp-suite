import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--')
const args = new Set(rawArgs)

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function runWithRetry(cmd, cmdArgs, { attempts = 2, delayMs = 5000, ...opts } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts })
    if (res.status === 0) return
    if (attempt === attempts) process.exit(res.status ?? 1)
    console.warn(`${cmd} ${cmdArgs.join(' ')} failed; retrying in ${Math.round(delayMs / 1000)}s`)
    sleep(delayMs)
  }
}

for (const cmd of ['node', 'pnpm', 'supabase']) {
  run(cmd, ['--version'], { stdio: 'ignore' })
}

if (!args.has('--skip-start')) run('supabase', ['start'])
runWithRetry('supabase', ['db', 'reset'])
run('pnpm', ['seed:demo'])
run('node', ['scripts/check-supabase-port-strategy.mjs'])

if (!args.has('--skip-functions') && !args.has('--ci')) {
  console.log('Start functions separately with: supabase functions serve graphql mcp index-embeddings flows ingest')
}

if (!args.has('--skip-frontend') && !args.has('--ci')) {
  console.log('Start frontend separately with: pnpm --filter @movp/frontend-astro dev')
}

if (!args.has('--ci')) {
  console.log('MOVP local stack ready')
  console.log('API: http://127.0.0.1:64321')
  console.log('Studio: http://127.0.0.1:64323')
  console.log('Login: http://127.0.0.1:4321/login with demo-owner@example.test')
}
