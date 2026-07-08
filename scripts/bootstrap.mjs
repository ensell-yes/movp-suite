import { spawnSync } from 'node:child_process'

const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--')
const args = new Set(rawArgs)

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

for (const cmd of ['node', 'pnpm', 'supabase']) {
  run(cmd, ['--version'], { stdio: 'ignore' })
}

if (!args.has('--skip-start')) run('supabase', ['start'])
run('supabase', ['db', 'reset'])
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
