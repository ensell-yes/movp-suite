import { execFileSync } from 'node:child_process'

if (process.env.CI === 'true' && process.env.MOVP_RELEASE_PREFLIGHT !== '1') {
  console.log('release preflight skipped in CI')
  process.exit(0)
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim()
  } catch {
    console.error('release preflight failed: npm auth or movp org access unavailable')
    process.exit(1)
  }
}

run('npm', ['org', '--help'])
run('npm', ['whoami'])
run('npm', ['org', 'ls', 'movp'])
