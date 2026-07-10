import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/index.ts'
import { fileStore } from '../src/secure-store.ts'

// Hybrid search bypasses the domain; only `task list` needs this minimal surface.
vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    task: { list: async () => ({ items: [{ id: 't1', title: 'Ship it' }], nextCursor: null }) },
  }),
}))

function makeJwt(sub: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub })}.sig`
}

const nowSec = () => Math.floor(Date.now() / 1000)

let dir: string
let prev: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'movp-e2e-'))
  prev = { ...process.env }
  process.env.MOVP_SECURE_STORE = 'file'
  process.env.MOVP_CONFIG = join(dir, 'config.json')
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_ANON_KEY
  delete process.env.MOVP_ACCESS_TOKEN
  delete process.env.MOVP_SERVICE_ROLE_KEY
  delete process.env.MOVP_PAT
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env = prev
  rmSync(dir, { recursive: true, force: true })
})

describe('CLI PAT lifecycle', () => {
  it('init -> login -> list -> hybrid -> revoke -> auth-fail (fails closed)', async () => {
    const out: string[] = []
    const run = (argv: string[]) => {
      const cmd = buildProgram({ out: (line) => out.push(line) })
      cmd.exitOverride()
      return cmd.parseAsync(['node', 'movp', ...argv])
    }
    const minted = makeJwt('user-1')

    await run(['init', '--api-url', 'http://api', '--anon-key', 'anon', '--workspace', 'w1'])
    expect(out.at(-1)).toContain('config.json')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: minted,
            expires_at: nowSec() + 3600,
            default_workspace_id: 'w1',
            user_id: 'user-1',
          }),
          { status: 200 },
        ),
      ),
    )
    await run(['login', '--token', 'movp_pat_live'])
    expect(out.at(-1)).toContain('user-1')
    expect(out.join('\n')).not.toContain('movp_pat_live')

    await run(['task', 'list', '--workspace', 'w1'])
    expect(out.at(-1)).toContain('t1')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: { search: [{ collection: 'note', id: 'n1', title: 'Hi', snippet: 'Hi', score: 1 }] },
          }),
          { status: 200 },
        ),
      ),
    )
    await run(['search', 'Hi', '--workspace', 'w1', '--mode', 'hybrid'])
    expect(out.at(-1)).toContain('n1')

    fileStore('http://api', process.env).save({
      pat: 'movp_pat_live',
      session: { access_token: minted, expires_at: nowSec() - 10 },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })),
    )

    await expect(run(['task', 'list', '--workspace', 'w1'])).rejects.toThrow(/invalid_token/)
  })
})
