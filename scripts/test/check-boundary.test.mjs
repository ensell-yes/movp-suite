import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-boundary.sh')
const fixtures = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'movp-boundary-'))
  fixtures.push(root)
  mkdirSync(join(root, 'templates', 'example'), { recursive: true })
  return root
}

const write = (root, relativePath, source) => {
  const path = join(root, 'templates', 'example', relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

const check = (root) => spawnSync('bash', [SCRIPT], {
  encoding: 'utf8',
  env: { ...process.env, MOVP_BOUNDARY_ROOT: root },
})

test('allows service-role access in template Supabase Edge Functions', () => {
  const root = fixture()
  write(
    root,
    'supabase/functions/graphql/index.ts',
    "const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')\n",
  )

  const result = check(root)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /boundary: clean/)
})

test('rejects server-only imports from client-importable template files', () => {
  const root = fixture()
  write(root, 'src/pages/index.astro', "---\nimport { resolvePrincipal } from '@movp/auth'\n---\n")

  const result = check(root)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /BOUNDARY VIOLATION/)
  assert.match(result.stdout, /src\/pages\/index\.astro/)
})
