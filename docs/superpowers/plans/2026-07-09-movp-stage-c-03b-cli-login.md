# MOVP Stage C3b — CLI Login / Init / Search Parity (PAT credential mode)

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. **Transcribe the code samples verbatim** — they are grounded in the real
> committed code (`packages/cli/src/{client,program,bin,index}.ts`, line-verified 2026-07-09)
> and in the **C3 FROZEN CONTRACTS** (the `auth-exchange` endpoint I/O, `PatExchange`, error
> codes). This is bite-sized TDD, expanded from
> `docs/superpowers/specs/2026-07-09-movp-stage-c-03-agent-connectivity-design.md` (§6, §8, §9).
>
> **PRECONDITION — C3a MERGED.** C3b **consumes** artifacts C3a delivers and does **not**
> build them: the `supabase/functions/auth-exchange` edge endpoint
> (`POST … Authorization: Bearer movp_pat_…` → `{ access_token, expires_at,
> default_workspace_id, user_id }`, `401 { error: <code> }`), the `resolve_pat` /
> `create/list/revoke_personal_access_token` RPCs, and the stable error codes
> `invalid_token` / `expired_token`. If C3a is not merged, **stop** — every task's exchange
> gate will fail against a missing endpoint. (The C3b vitest suite mocks the network, so it is
> green without a live endpoint; the live proof is the C3d `[agents]` slice.)

**Goal:** a user (or headless agent) can `movp init` an instance, `movp login` with a pasted
Personal Access Token (PAT), and then run every existing `movp` command — including
`movp search --mode hybrid` — with the PAT transparently exchanged into a short-lived GoTrue
session. The PAT and the exchanged session are stored in the macOS Keychain (or a `0600` file
fallback), never printed, never logged. Revoking the PAT makes the next command fail closed
with a stable auth code and a non-zero exit.

**Architecture:** C3b adds to `@movp/cli` only — (1) a config module (`config.ts`) that
`movp init` writes to `${XDG_CONFIG_HOME:-~/.config}/movp/config.json` (or `$MOVP_CONFIG`); (2)
a secure-store module (`secure-store.ts`) with a macOS-Keychain backend and a symlink-safe
`0600` file fallback; (3) a **PAT mode** in `resolveCliCtx` sitting between the unchanged
`MOVP_ACCESS_TOKEN` (raw JWT) and `MOVP_SERVICE_ROLE_KEY` modes — it POSTs the stored/`MOVP_PAT`
token to C3a's `auth-exchange`, caches the returned session, and re-exchanges only on expiry;
(4) `movp init` / `movp login` / `movp logout` commands; (5) a tiny authenticated GraphQL
client (`graphql-client.ts`) so `movp search --mode semantic|hybrid` routes through the
GraphQL edge (`--mode fts` stays on the direct-PG path, byte-identical). No new package, **no
new dependency** (node builtins `fs`/`os`/`path`/`crypto`/`child_process` + the existing
`@supabase/supabase-js` and `commander`). No migration, no schema, no edge, no frontend change.

**Tech stack:** Node 20 + `tsx` (the CLI runs via `#!/usr/bin/env -S npx tsx`), `commander` 12,
`@supabase/supabase-js` 2, **vitest 3** (`environment: node`; `tsconfig.base` includes the
`DOM` lib so global `fetch`/`Response`/`Headers` typecheck). The CLI is a single package
`@movp/cli` (`packages/cli`).

---

## Global Constraints (every task inherits these)

- **TDD, failing test first.** Each task adds its failing test/gate and proves the expected
  failure *before* implementation, then proves the pass with an **exact test count**.
- **Baselines on this branch (verified 2026-07-09):** `@movp/cli` vitest suite = **16 tests**
  (all in `packages/cli/test/program.test.ts`); workspace `pnpm typecheck` = **12/12 packages**.
  C3b adds no package, so `pnpm typecheck` **stays 12/12**. The CLI suite grows
  16 → 21 → 27 → 33 → 35 → 35 → 36 across the six tasks.
- **No new dependency.** Everything is a node builtin or an existing dep. Do **not** add a
  keytar/keychain npm package — shell out to `security` (macOS) per the global keychain rule.
- **Never print or log the PAT or the session.** `movp login` prints only non-secret metadata
  (`user_id`, `default_workspace_id`); the secure store and the exchange helper never touch
  `console`. The thrown auth error carries **only the stable code**, never the token bytes.
  Gate (every relevant task): `grep -rnE "console\.[a-z]+\([^)]*(pat|session|token|secret)" packages/cli/src`
  must be **empty**; `secure-store.ts` / `config.ts` / `graphql-client.ts` contain **no**
  `console.*` at all; `client.ts` keeps exactly its one pre-existing service-role WARNING.
- **Untrusted-io on the file store.** The fallback credentials file is written with
  `{ mode: 0o600 }` **and** an explicit `chmodSync(path, 0o600)` (umask masks the create-mode);
  reads `lstatSync` the path and **refuse a symlink before any `readFileSync`** (a symlink
  could redirect the read to `~/.ssh/id_rsa`). This gotcha is commented **at the read site**.
- **Precedence is load-bearing and must not change for the two existing modes.**
  `MOVP_ACCESS_TOKEN` (raw JWT) **>** `MOVP_PAT` env / stored PAT (exchange) **>**
  `MOVP_SERVICE_ROLE_KEY` + `MOVP_USER_ID`. The `MOVP_ACCESS_TOKEN` and service-role branches
  keep **byte-identical client construction** (same `createClient(...)` call); env still wins
  over config, so their behaviour with env set is unchanged. A test pins each.
- **`resolveCliCtx` becomes `async`.** PAT mode must be able to re-exchange (a network call).
  `resolveCliCtx` returns `Promise<CliCtx>`; `program.ts`'s `resolveCtx` type widens to
  `() => CliCtx | Promise<CliCtx>` and every call site is `await`ed. The existing tests inject a
  **sync** `resolveCtx: () => ({ db, userId })`, which still satisfies the union and still
  passes (all 16 stay green).
- **Session caching lives in the SAME secure store as the PAT** (spec §Efficiency): the CLI
  caches `{ access_token, expires_at }` at rest and re-exchanges only when expired
  (60s skew). This is the CLI layer only; it does not contradict the edge's no-persist rule.
- **Consumed C3a contract (frozen — use verbatim):**
  `POST ${apiUrl}/functions/v1/auth-exchange`, header `Authorization: Bearer movp_pat_…` (+
  `apikey: <anonKey>` for the Functions gateway) → `200 { access_token, expires_at,
  default_workspace_id, user_id }`; failure → `401 { error: 'invalid_token' | 'expired_token' }`.
  GraphQL edge: `POST ${apiUrl}/functions/v1/graphql`, `Authorization: Bearer <session
  access_token>`, body `{ query, variables }`, response `{ data: { search: [...] } }` (401/403
  on a rejected token). `expires_at` is **unix seconds** (GoTrue convention); the code tolerates
  a millisecond value defensively.
- **Per-task gate + one commit per task.** A task is done only when its gate passes.
  Phase C3b done only when C3b.1–C3b.6 all land and the CLI suite is 36 green, typecheck 12/12.

## File Structure

```text
packages/cli/src/
  config.ts            # NEW  C3b.1  CliConfig + configDir/configPath/credentialsPath/write/load
  secure-store.ts      # NEW  C3b.2  fileStore (0600, symlink-safe) + keychainStore + selectSecureStore
  client.ts            # MODIFY C3b.3 resolveCliCtx → async PAT mode; + exchangePat/ExchangeResult
  program.ts           # MODIFY C3b.1/.3/.4/.5 init/login/logout commands; await resolveCtx; hybrid search
  graphql-client.ts    # NEW  C3b.5  searchViaGraphql (authenticated GraphQL client)
  index.ts             # MODIFY  re-export the new public helpers
packages/cli/test/
  config.test.ts       # NEW  C3b.1  (4 tests)
  secure-store.test.ts # NEW  C3b.2  (6 tests)
  client.test.ts       # NEW  C3b.3  (6 tests)
  program.test.ts      # MODIFY C3b.1/.4/.5  (+init, +login, +logout, hybrid replaces reject)
  integration.test.ts  # NEW  C3b.6  (1 test: init→login→list→hybrid→revoke→auth-fail)
```

---

## Task C3b.1: CLI config file + `movp init`

**Files**
- Create: `packages/cli/src/config.ts`, `packages/cli/test/config.test.ts`
- Modify: `packages/cli/src/program.ts` (add `init` command + import), `packages/cli/src/index.ts`
  (re-export config helpers), `packages/cli/test/program.test.ts` (add the `init` command test)

**Interfaces**
- **Consumes from C3a contracts:** none in this task (config is client-local). The written
  `apiUrl` = the instance `SUPABASE_URL`; `anonKey` = the public anon/publishable key (a public
  value — config is not a secret file).
- **Produces (exact signatures — later tasks import these):**
  ```ts
  export interface CliConfig { apiUrl: string; anonKey: string; defaultWorkspaceId?: string }
  export function configDir(env?: Record<string, string | undefined>): string
  export function configPath(env?: Record<string, string | undefined>): string
  export function credentialsPath(env?: Record<string, string | undefined>): string
  export function writeCliConfig(cfg: CliConfig, env?: Record<string, string | undefined>): string
  export function loadCliConfig(env?: Record<string, string | undefined>): CliConfig | null
  ```

**TDD steps**

- [ ] **Step 1 — failing test** `packages/cli/test/config.test.ts` (REAL, complete — 4 tests):

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDir, configPath, loadCliConfig, writeCliConfig } from '../src/config.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'movp-cfg-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cli config', () => {
  it('writes and reads back a config at $MOVP_CONFIG', () => {
    const env = { MOVP_CONFIG: join(dir, 'config.json') }
    const p = writeCliConfig({ apiUrl: 'http://api', anonKey: 'anon', defaultWorkspaceId: 'w1' }, env)
    expect(p).toBe(join(dir, 'config.json'))
    expect(loadCliConfig(env)).toEqual({ apiUrl: 'http://api', anonKey: 'anon', defaultWorkspaceId: 'w1' })
  })

  it('honors XDG_CONFIG_HOME for the default config dir', () => {
    expect(configDir({ XDG_CONFIG_HOME: dir })).toBe(join(dir, 'movp'))
    expect(configPath({ XDG_CONFIG_HOME: dir })).toBe(join(dir, 'movp', 'config.json'))
  })

  it('falls back to ~/.config/movp when XDG_CONFIG_HOME is unset', () => {
    expect(configDir({}).endsWith(join('.config', 'movp'))).toBe(true)
  })

  it('returns null for a malformed or absent config', () => {
    expect(loadCliConfig({ MOVP_CONFIG: join(dir, 'missing.json') })).toBeNull()
    writeFileSync(join(dir, 'bad.json'), '{"apiUrl":123}')
    expect(loadCliConfig({ MOVP_CONFIG: join(dir, 'bad.json') })).toBeNull()
  })
})
```

- [ ] **Step 2 — run it, expect FAIL** (module missing):
  Run: `pnpm --filter @movp/cli exec vitest run config`
  Expected: FAIL — `Failed to resolve import "../src/config.ts"` (Cannot find module `./config.ts`).

- [ ] **Step 3 — implement** `packages/cli/src/config.ts` (REAL, complete):

```ts
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export interface CliConfig {
  apiUrl: string
  anonKey: string
  defaultWorkspaceId?: string
}

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(homedir(), '.config')
  return join(base, 'movp')
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.MOVP_CONFIG && env.MOVP_CONFIG.length > 0 ? env.MOVP_CONFIG : join(configDir(env), 'config.json')
}

// The credentials file (PAT + cached session) lives next to the config file.
export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(configPath(env)), 'credentials.json')
}

export function writeCliConfig(cfg: CliConfig, env: Record<string, string | undefined> = process.env): string {
  const p = configPath(env)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  return p
}

export function loadCliConfig(env: Record<string, string | undefined> = process.env): CliConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(env), 'utf8'))
    return isCliConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Structurally validate persisted state before use (untrusted-io); a parseable-but-wrong
// file is treated as absent, never `as`-cast into the config shape.
function isCliConfig(v: unknown): v is CliConfig {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.apiUrl === 'string' &&
    typeof o.anonKey === 'string' &&
    (o.defaultWorkspaceId === undefined || typeof o.defaultWorkspaceId === 'string')
  )
}
```

- [ ] **Step 4 — run it, expect PASS** (4 tests):
  Run: `pnpm --filter @movp/cli exec vitest run config`
  Expected: PASS — `config.test.ts (4 tests)`.

- [ ] **Step 5 — add the `movp init` command.** In `packages/cli/src/program.ts` add the import
  near the top (after the `./client.ts` import on line 5):

```ts
import { writeCliConfig } from './config.ts'
```

  Then register `init` immediately **before** `program.command('codegen')` (currently line 551),
  inside `buildProgram` so `out` is in scope:

```ts
  program
    .command('init')
    .description('Write the CLI config (instance URL, anon key, default workspace)')
    .requiredOption('--api-url <url>', 'instance API URL (SUPABASE_URL)')
    .requiredOption('--anon-key <key>', 'anon/publishable key')
    .option('--workspace <id>', 'default workspace id')
    .action((o: { apiUrl: string; anonKey: string; workspace?: string }) => {
      const path = writeCliConfig({ apiUrl: o.apiUrl, anonKey: o.anonKey, defaultWorkspaceId: o.workspace })
      out(JSON.stringify({ ok: true, config: path }))
    })
```

  And re-export from `packages/cli/src/index.ts` (append):

```ts
export { writeCliConfig, loadCliConfig, configDir, configPath, credentialsPath, type CliConfig } from './config.ts'
```

- [ ] **Step 6 — add the `init` command test** to `packages/cli/test/program.test.ts`. First add
  these imports at the top of the file (after the existing `import` lines 1–3):

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCliConfig } from '../src/config.ts'
```

  Then add this `it` **inside** the `describe('movp CLI', …)` block (e.g. after the
  `creates a note …` test):

```ts
  it('init writes the CLI config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'movp-init-'))
    const prev = process.env.MOVP_CONFIG
    process.env.MOVP_CONFIG = join(dir, 'config.json')
    try {
      const { cmd, out } = program()
      await cmd.parseAsync(['node', 'movp', 'init', '--api-url', 'http://api', '--anon-key', 'anon', '--workspace', 'w1'])
      expect(out[0]).toContain(join(dir, 'config.json'))
      expect(loadCliConfig({ MOVP_CONFIG: join(dir, 'config.json') })).toEqual({ apiUrl: 'http://api', anonKey: 'anon', defaultWorkspaceId: 'w1' })
    } finally {
      if (prev === undefined) delete process.env.MOVP_CONFIG
      else process.env.MOVP_CONFIG = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 7 — run the full CLI suite, expect PASS = 21:**
  Run: `pnpm --filter @movp/cli test`
  Expected: PASS — **21 tests** (program.test.ts 17 + config.test.ts 4).

- [ ] **Step 8 — gate + commit.**
  Run: `pnpm --filter @movp/cli typecheck` (Expected: clean) and
  `grep -n "console" packages/cli/src/config.ts` (Expected: **empty** — config never logs).

```bash
git add packages/cli/src/config.ts packages/cli/src/index.ts packages/cli/src/program.ts packages/cli/test/config.test.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): movp init writes ~/.config/movp/config.json + config-load helper"
```

---

## Task C3b.2: Secure credential store (Keychain + `0600` file fallback)

**Files**
- Create: `packages/cli/src/secure-store.ts`, `packages/cli/test/secure-store.test.ts`
- Modify: `packages/cli/src/index.ts` (re-export the store)

**Interfaces**
- **Consumes:** `credentialsPath(env)` from `./config.ts` (C3b.1) for the fallback file path.
- **Produces:**
  ```ts
  export interface StoredSession { access_token: string; expires_at: number }
  export interface Credentials { pat?: string; session?: StoredSession }
  export interface SecureStore { load(): Credentials; save(next: Credentials): void; clear(): void }
  export type KeychainRunner = (args: string[]) => { status: number | null; stdout: string; error?: Error }
  export function fileStore(apiUrl: string, env?: Record<string, string | undefined>): SecureStore
  export function keychainStore(apiUrl: string, opts?: { run?: KeychainRunner; account?: string }): SecureStore
  export function selectSecureStore(apiUrl: string, env?: Record<string, string | undefined>): SecureStore
  ```
- **Backend selection (frozen contract §8):** macOS Keychain via
  `security add/find/delete-generic-password -s "movp:pat:<apiUrlHash>"` when
  `process.platform === 'darwin'` **and** `security` is on PATH; else the `0600` file. The env
  override `MOVP_SECURE_STORE=file` forces the file backend (deterministic tests + headless/CI).
  `keychainStore` takes an injectable `run` so unit tests assert the exact `security` argv
  **without mutating the developer's real Keychain**; the real call site (`selectSecureStore`)
  uses the default `spawnSync` runner.

**TDD steps**

- [ ] **Step 1 — failing test** `packages/cli/test/secure-store.test.ts` (REAL, complete — 6 tests):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStore, keychainStore, type KeychainRunner } from '../src/secure-store.ts'

const PAT = 'movp_pat_deadbeef'
let dir: string
let env: Record<string, string | undefined>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'movp-store-'))
  env = { MOVP_CONFIG: join(dir, 'config.json') }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('file secure store', () => {
  it('writes credentials.json at mode 0o600', () => {
    fileStore('http://api', env).save({ pat: PAT })
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
  })

  it('round-trips saved credentials and clears them', () => {
    const store = fileStore('http://api', env)
    store.save({ pat: PAT, session: { access_token: 'jwt', expires_at: 123 } })
    expect(store.load()).toEqual({ pat: PAT, session: { access_token: 'jwt', expires_at: 123 } })
    store.clear()
    expect(store.load()).toEqual({})
  })

  it('returns {} when the credentials file is absent', () => {
    expect(fileStore('http://api', env).load()).toEqual({})
  })

  it('refuses to read a symlinked credentials file (untrusted-io)', () => {
    symlinkSync('/etc/hosts', join(dir, 'credentials.json'))
    expect(() => fileStore('http://api', env).load()).toThrow(/symlink/)
  })

  it('never writes the secret to the console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    fileStore('http://api', env).save({ pat: PAT })
    fileStore('http://api', env).load()
    for (const call of [...log.mock.calls, ...err.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(PAT)
    }
  })
})

describe('keychain secure store', () => {
  it('issues the exact security argv and never logs the PAT', () => {
    const calls: string[][] = []
    const kv: Record<string, string> = {}
    const run: KeychainRunner = (args) => {
      calls.push(args)
      if (args[0] === 'add-generic-password') {
        kv[args[args.indexOf('-s') + 1]!] = args[args.indexOf('-w') + 1]!
        return { status: 0, stdout: '' }
      }
      if (args[0] === 'find-generic-password') {
        const s = args[args.indexOf('-s') + 1]!
        return s in kv ? { status: 0, stdout: `${kv[s]}\n` } : { status: 44, stdout: '' }
      }
      return { status: 0, stdout: '' }
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const kc = keychainStore('http://api', { run, account: 'tester' })
    kc.save({ pat: PAT })
    expect(kc.load().pat).toBe(PAT)
    const add = calls.find((c) => c[0] === 'add-generic-password')!
    expect(add).toContain('-U')
    expect(add[add.indexOf('-a') + 1]).toBe('tester')
    expect(add[add.indexOf('-s') + 1]).toMatch(/^movp:pat:[0-9a-f]{16}$/)
    expect(add[add.indexOf('-w') + 1]).toBe(PAT)
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain(PAT)
  })
})
```

- [ ] **Step 2 — run it, expect FAIL** (module missing):
  Run: `pnpm --filter @movp/cli exec vitest run secure-store`
  Expected: FAIL — `Failed to resolve import "../src/secure-store.ts"`.

- [ ] **Step 3 — implement** `packages/cli/src/secure-store.ts` (REAL, complete):

```ts
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { credentialsPath } from './config.ts'

export interface StoredSession {
  access_token: string
  expires_at: number
}
export interface Credentials {
  pat?: string
  session?: StoredSession
}
export interface SecureStore {
  load(): Credentials
  save(next: Credentials): void
  clear(): void
}

function instanceHash(apiUrl: string): string {
  return createHash('sha256').update(apiUrl).digest('hex').slice(0, 16)
}

// Validate parsed persisted state structurally before use (untrusted-io); a
// parseable-but-wrong file is treated as absent, never `as`-cast into the shape.
function isSession(v: unknown): v is StoredSession {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return typeof s.access_token === 'string' && typeof s.expires_at === 'number'
}
function isCredentials(v: unknown): v is Credentials {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (o.pat !== undefined && typeof o.pat !== 'string') return false
  if (o.session !== undefined && !isSession(o.session)) return false
  return true
}

// ---- file backend (0600, symlink-safe) ----
export function fileStore(apiUrl: string, env: Record<string, string | undefined> = process.env): SecureStore {
  const path = credentialsPath(env)
  return {
    load(): Credentials {
      let st: Stats
      try {
        st = lstatSync(path)
      } catch {
        return {}
      }
      // untrusted-io: lstat BEFORE any read. A symlink here could redirect the read to a
      // file outside the config dir (e.g. ~/.ssh/id_rsa); refuse rather than follow it.
      if (st.isSymbolicLink()) throw new Error(`refusing to read credentials via symlink: ${path}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return {}
      }
      return isCredentials(parsed) ? parsed : {}
    },
    save(next: Credentials): void {
      mkdirSync(dirname(path), { recursive: true })
      // 0600: the PAT + session are user secrets; never group/world readable.
      writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 })
      // writeFileSync's create-mode is masked by umask; force 0600 explicitly.
      chmodSync(path, 0o600)
    },
    clear(): void {
      rmSync(path, { force: true })
    },
  }
}

// ---- keychain backend (macOS) ----
export type KeychainRunner = (args: string[]) => { status: number | null; stdout: string; error?: Error }

const defaultRunner: KeychainRunner = (args) => {
  const r = spawnSync('security', args, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', error: r.error ?? undefined }
}

export function keychainStore(apiUrl: string, opts: { run?: KeychainRunner; account?: string } = {}): SecureStore {
  const run = opts.run ?? defaultRunner
  const account = opts.account ?? process.env.USER ?? 'movp'
  const h = instanceHash(apiUrl)
  const patSvc = `movp:pat:${h}`
  const sessSvc = `movp:session:${h}`
  const find = (svc: string): string | undefined => {
    const r = run(['find-generic-password', '-a', account, '-s', svc, '-w'])
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : undefined
  }
  return {
    load(): Credentials {
      const pat = find(patSvc)
      const raw = find(sessSvc)
      let session: StoredSession | undefined
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (isSession(parsed)) session = parsed
        } catch {
          session = undefined
        }
      }
      return { pat, session }
    },
    save(next: Credentials): void {
      // -U updates an existing item; -w passes the value. Only fields present are written,
      // so `save({ ...creds, session })` preserves an already-stored PAT.
      if (next.pat !== undefined) run(['add-generic-password', '-U', '-a', account, '-s', patSvc, '-w', next.pat])
      if (next.session !== undefined)
        run(['add-generic-password', '-U', '-a', account, '-s', sessSvc, '-w', JSON.stringify(next.session)])
    },
    clear(): void {
      run(['delete-generic-password', '-a', account, '-s', patSvc])
      run(['delete-generic-password', '-a', account, '-s', sessSvc])
    },
  }
}

function hasSecurity(): boolean {
  try {
    return !spawnSync('security', ['-h'], { encoding: 'utf8' }).error
  } catch {
    return false
  }
}

export function selectSecureStore(apiUrl: string, env: Record<string, string | undefined> = process.env): SecureStore {
  if (env.MOVP_SECURE_STORE === 'file') return fileStore(apiUrl, env)
  if (process.platform === 'darwin' && hasSecurity()) return keychainStore(apiUrl)
  return fileStore(apiUrl, env)
}
```

  ⚠ Residual (LOW, documented): `security add-generic-password -w <pat>` places the PAT in the
  process argv, briefly visible in `ps`. This is the standard `security` write pattern (the
  global keychain rule uses `-w`); the file fallback avoids it. Do **not** switch to a shell
  string — that reintroduces injection risk.

- [ ] **Step 4 — run it, expect PASS** (6 tests):
  Run: `pnpm --filter @movp/cli exec vitest run secure-store`
  Expected: PASS — `secure-store.test.ts (6 tests)`.

- [ ] **Step 5 — re-export** from `packages/cli/src/index.ts` (append):

```ts
export { selectSecureStore, fileStore, keychainStore, type SecureStore, type Credentials, type StoredSession } from './secure-store.ts'
```

- [ ] **Step 6 — run the full CLI suite, expect PASS = 27:**
  Run: `pnpm --filter @movp/cli test`  → Expected: **27 tests** (21 + 6).

- [ ] **Step 7 — gate + commit.**
  Run: `pnpm --filter @movp/cli typecheck` (clean) and
  `grep -n "console" packages/cli/src/secure-store.ts` (Expected: **empty**).

```bash
git add packages/cli/src/secure-store.ts packages/cli/src/index.ts packages/cli/test/secure-store.test.ts
git commit -m "feat(cli): secure PAT/session store (Keychain + 0600 symlink-safe file fallback)"
```

---

## Task C3b.3: `resolveCliCtx` PAT mode (precedence, session cache, re-exchange)

**Files**
- Modify: `packages/cli/src/client.ts` (async `resolveCliCtx` + `exchangePat` + private
  `resolvePatSession`), `packages/cli/src/program.ts` (widen `resolveCtx` type + `await` all
  call sites), `packages/cli/src/index.ts` (re-export `exchangePat`)
- Create: `packages/cli/test/client.test.ts`

**Interfaces**
- **Consumes from C3a contracts:** `POST ${apiUrl}/functions/v1/auth-exchange`
  (`Authorization: Bearer movp_pat_…`, `apikey: <anonKey>`) → `200 { access_token, expires_at,
  default_workspace_id, user_id }`; `401 { error: 'invalid_token' | 'expired_token' }`. The two
  reject codes are the stable agent-facing codes — surfaced unchanged (no remap).
- **Produces:**
  ```ts
  export interface ExchangeResult { access_token: string; expires_at: number; default_workspace_id: string; user_id: string }
  export async function exchangePat(pat: string, apiUrl: string, anonKey: string, fetchImpl?: typeof fetch): Promise<ExchangeResult>
  export async function resolveCliCtx(env?: Record<string, string | undefined>): Promise<CliCtx>  // now async
  ```
- **Invariant (precedence, byte-identical modes):** `MOVP_ACCESS_TOKEN` **>**
  `MOVP_PAT`/stored PAT **>** `MOVP_SERVICE_ROLE_KEY`+`MOVP_USER_ID`. The `MOVP_ACCESS_TOKEN`
  and service-role branches keep the **exact** `createClient(...)` calls from the committed
  `client.ts`. `userId` in PAT mode = `decodeSub(session access_token)`. Session cached in the
  secure store; re-exchange only when `expires_at` is within 60s of now.

**TDD steps**

- [ ] **Step 1 — failing test** `packages/cli/test/client.test.ts` (REAL, complete — 6 tests):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliCtx } from '../src/client.ts'
import { fileStore } from '../src/secure-store.ts'

function makeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub })}.sig`
}
const nowSec = () => Math.floor(Date.now() / 1000)

let dir: string
let base: Record<string, string | undefined>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'movp-ctx-'))
  base = {
    SUPABASE_URL: 'http://api',
    SUPABASE_ANON_KEY: 'anon',
    MOVP_SECURE_STORE: 'file',
    MOVP_CONFIG: join(dir, 'config.json'),
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveCliCtx precedence', () => {
  it('MOVP_ACCESS_TOKEN takes precedence and is unchanged (no exchange)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const jwt = makeJwt('user-access')
    const ctx = await resolveCliCtx({ ...base, MOVP_ACCESS_TOKEN: jwt })
    expect(ctx.accessToken).toBe(jwt)
    expect(ctx.userId).toBe('user-access')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('MOVP_PAT env is exchanged into a session access_token', async () => {
    const minted = makeJwt('user-pat')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: minted, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'user-pat' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_abc' })
    expect(ctx.accessToken).toBe(minted)
    expect(ctx.userId).toBe('user-pat')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/functions/v1/auth-exchange')
  })

  it('reuses a cached non-expired session without re-exchanging', async () => {
    fileStore('http://api', base).save({ pat: 'movp_pat_abc', session: { access_token: makeJwt('cached'), expires_at: nowSec() + 3600 } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_abc' })
    expect(ctx.userId).toBe('cached')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('re-exchanges when the cached session is expired', async () => {
    fileStore('http://api', base).save({ pat: 'movp_pat_abc', session: { access_token: makeJwt('stale'), expires_at: nowSec() - 10 } })
    const fresh = makeJwt('fresh')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: fresh, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'fresh' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_abc' })
    expect(ctx.accessToken).toBe(fresh)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a revoked PAT (exchange 401) throws the auth code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })))
    await expect(resolveCliCtx({ ...base, MOVP_PAT: 'movp_pat_revoked' })).rejects.toThrow(/invalid_token/)
  })

  it('service-role mode is unchanged', async () => {
    const ctx = await resolveCliCtx({ ...base, MOVP_SERVICE_ROLE_KEY: 'srv', MOVP_USER_ID: 'admin' })
    expect(ctx.userId).toBe('admin')
    expect(ctx.accessToken).toBeUndefined()
  })
})
```

- [ ] **Step 2 — run it, expect FAIL:**
  Run: `pnpm --filter @movp/cli exec vitest run client`
  Expected: FAIL — the PAT-mode tests reject with `No credential` (current `resolveCliCtx` has
  no PAT branch and, being sync, `await` still resolves but PAT env is ignored → falls through
  to the `No credential` throw for `MOVP_PAT`-only envs).

- [ ] **Step 3 — rewrite** `packages/cli/src/client.ts` (REAL, complete — replaces the whole
  file; the `MOVP_ACCESS_TOKEN` and service-role `createClient` blocks are byte-identical to the
  committed version):

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadCliConfig } from './config.ts'
import { selectSecureStore } from './secure-store.ts'

export interface CliCtx {
  db: SupabaseClient
  userId: string
  accessToken?: string
  assetsFnUrl?: string
}

export interface ExchangeResult {
  access_token: string
  expires_at: number
  default_workspace_id: string
  user_id: string
}

export function decodeSub(jwt: string): string {
  const parts = jwt.split('.')
  if (parts.length !== 3) throw new Error('malformed JWT in MOVP_ACCESS_TOKEN')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('JWT missing sub')
  return payload.sub
}

// POST the PAT to the C3a auth-exchange endpoint. Consumes C3a's frozen I/O:
//   200 → { access_token, expires_at, default_workspace_id, user_id }
//   4xx → { error: 'invalid_token' | 'expired_token' }
// NEVER log the pat or the returned tokens — the thrown Error carries only the stable code.
// GOTCHA: send `apikey: <anonKey>` too — the Supabase Functions gateway requires it even
// though the fn is verify_jwt=false (the Bearer is a movp_pat_, not a JWT).
export async function exchangePat(
  pat: string,
  apiUrl: string,
  anonKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const res = await fetchImpl(`${apiUrl}/functions/v1/auth-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${pat}` },
  })
  if (!res.ok) {
    let code = 'invalid_token'
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string') code = body.error
    } catch {
      /* keep the default code */
    }
    throw new Error(code)
  }
  return (await res.json()) as ExchangeResult
}

function expiresAtMs(expiresAt: number): number {
  // GoTrue session.expires_at is unix SECONDS; tolerate a millisecond value defensively.
  return expiresAt > 1e12 ? expiresAt : expiresAt * 1000
}

// PAT → session access_token, cached in the SAME secure store; re-exchange only when expired.
async function resolvePatSession(
  pat: string,
  apiUrl: string,
  anonKey: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const store = selectSecureStore(apiUrl, env)
  const creds = store.load()
  const cached = creds.session
  if (cached && expiresAtMs(cached.expires_at) > Date.now() + 60_000) return cached.access_token
  const ex = await exchangePat(pat, apiUrl, anonKey)
  // Preserve an already-stored PAT; update only the cached session.
  store.save({ ...creds, session: { access_token: ex.access_token, expires_at: ex.expires_at } })
  return ex.access_token
}

export async function resolveCliCtx(env: Record<string, string | undefined> = process.env): Promise<CliCtx> {
  const cfg = loadCliConfig(env)
  const url = env.SUPABASE_URL ?? cfg?.apiUrl
  if (!url) throw new Error('SUPABASE_URL is required (run `movp init` or set SUPABASE_URL)')
  const anonKey = env.SUPABASE_ANON_KEY ?? cfg?.anonKey
  const assetsFnUrl = `${url}/functions/v1/content-assets`

  // 1. MOVP_ACCESS_TOKEN (raw JWT) — UNCHANGED, byte-identical client construction.
  const accessToken = env.MOVP_ACCESS_TOKEN
  if (accessToken) {
    if (!anonKey) throw new Error('SUPABASE_ANON_KEY is required alongside MOVP_ACCESS_TOKEN')
    const db = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    })
    return { db, userId: decodeSub(accessToken), accessToken, assetsFnUrl }
  }

  // 2. PAT mode: MOVP_PAT env or stored PAT → exchange → session access_token.
  const pat = env.MOVP_PAT ?? selectSecureStore(url, env).load().pat
  if (pat) {
    if (!anonKey) throw new Error('anon key required for PAT mode (run `movp init` or set SUPABASE_ANON_KEY)')
    const sessionToken = await resolvePatSession(pat, url, anonKey, env)
    const db = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${sessionToken}` } },
      auth: { persistSession: false },
    })
    return { db, userId: decodeSub(sessionToken), accessToken: sessionToken, assetsFnUrl }
  }

  // 3. MOVP_SERVICE_ROLE_KEY + MOVP_USER_ID — UNCHANGED.
  const serviceRole = env.MOVP_SERVICE_ROLE_KEY
  if (serviceRole) {
    const userId = env.MOVP_USER_ID
    if (!userId) throw new Error('MOVP_USER_ID is required in service-role mode')
    console.error('[movp] WARNING: service-role mode: RLS is BYPASSED. Local admin only.')
    const db = createClient(url, serviceRole, { auth: { persistSession: false } })
    return { db, userId, assetsFnUrl }
  }

  throw new Error(
    'No credential: set MOVP_ACCESS_TOKEN (preferred), MOVP_PAT / `movp login` (PAT), or MOVP_SERVICE_ROLE_KEY + MOVP_USER_ID (local admin).',
  )
}
```

- [ ] **Step 4 — run it, expect PASS** (6 tests):
  Run: `pnpm --filter @movp/cli exec vitest run client`  → Expected: `client.test.ts (6 tests)`.

- [ ] **Step 5 — widen `program.ts`'s `resolveCtx` to async and `await` every call site.**
  Edit `packages/cli/src/program.ts`:
  1. Line ~14, in `BuildProgramOpts`, change:
     ```ts
       resolveCtx?: () => CliCtx
     ```
     to:
     ```ts
       resolveCtx?: () => CliCtx | Promise<CliCtx>
     ```
     (The default `const resolveCtx = opts.resolveCtx ?? (() => resolveCliCtx())` on line 39 needs
     **no** change — `resolveCliCtx` now returns `Promise<CliCtx>`, which satisfies the union.)
  2. Replace **all 38** occurrences of `createDomain(resolveCtx())` with
     `createDomain(await resolveCtx())`.
  3. Replace **both** occurrences of `resolveCtx().db` with `(await resolveCtx()).db`
     (the two `jobs` defaults, lines 60 and 64).

  Every call site is already inside an `async` action/handler, so `await` is valid.

- [ ] **Step 6 — re-export** from `packages/cli/src/index.ts` (append):

```ts
export { exchangePat, type ExchangeResult } from './client.ts'
```

- [ ] **Step 7 — run the full CLI suite, expect PASS = 33:**
  Run: `pnpm --filter @movp/cli test`  → Expected: **33 tests** (27 + client 6). All prior tests
  stay green — the sync `resolveCtx` injection in `program.test.ts` still satisfies the union.

- [ ] **Step 8 — gates + commit.**
  Run each; each must hold:
  - `pnpm --filter @movp/cli typecheck` → clean.
  - `grep -Fc 'createDomain(resolveCtx())' packages/cli/src/program.ts` → **0** (all awaited).
  - `grep -Fc 'createDomain(await resolveCtx())' packages/cli/src/program.ts` → **38**.
  - `grep -rnE "console\.[a-z]+\([^)]*(pat|session|token|secret)" packages/cli/src` → **empty**.
  - `grep -n "console" packages/cli/src/client.ts` → exactly the one service-role WARNING line.

```bash
git add packages/cli/src/client.ts packages/cli/src/program.ts packages/cli/src/index.ts packages/cli/test/client.test.ts
git commit -m "feat(cli): PAT credential mode in resolveCliCtx (exchange + session cache + re-exchange)"
```

---

## Task C3b.4: `movp login` / `movp logout`

**Files**
- Modify: `packages/cli/src/program.ts` (imports + `readTokenFromStdin` helper + `login`/`logout`
  commands), `packages/cli/test/program.test.ts` (add 2 tests + a `fileStore` import)

**Interfaces**
- **Consumes:** `exchangePat` (C3b.3, which consumes the C3a `auth-exchange` endpoint),
  `selectSecureStore` (C3b.2), `loadCliConfig` (C3b.1).
- **Produces (CLI surface):**
  - `movp login [--token <pat>]` — takes a pasted PAT (`--token`, else read from stdin),
    validates it via `exchangePat` (throws the stable code on reject), stores `{ pat, session }`.
    Prints only `{ ok, user_id, default_workspace_id }` — **never** the PAT or the session.
  - `movp logout` — clears the store for the configured instance.
- **Invariant:** login **must** validate before storing (a bad PAT is never persisted); the
  printed output contains no secret.

**TDD steps**

- [ ] **Step 1 — failing tests.** Add to the top of `packages/cli/test/program.test.ts` (with the
  C3b.1 fs/os/path imports already present) this import:

```ts
import { fileStore } from '../src/secure-store.ts'
```

  Then add these two `it`s inside `describe('movp CLI', …)`:

```ts
  it('login validates the PAT via exchange and stores it (never printing it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'movp-login-'))
    const prev = { ...process.env }
    try {
      process.env.SUPABASE_URL = 'http://api'
      process.env.SUPABASE_ANON_KEY = 'anon'
      process.env.MOVP_SECURE_STORE = 'file'
      process.env.MOVP_CONFIG = join(dir, 'config.json')
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'jwt', expires_at: Math.floor(Date.now() / 1000) + 3600, default_workspace_id: 'w1', user_id: 'u1' }), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchSpy)
      const { cmd, out } = program()
      await cmd.parseAsync(['node', 'movp', 'login', '--token', 'movp_pat_secret'])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(out.join('\n')).toContain('u1')
      expect(out.join('\n')).not.toContain('movp_pat_secret')
      expect(fileStore('http://api', process.env).load().pat).toBe('movp_pat_secret')
    } finally {
      vi.unstubAllGlobals()
      process.env = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logout clears the stored credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'movp-logout-'))
    const prev = { ...process.env }
    try {
      process.env.SUPABASE_URL = 'http://api'
      process.env.MOVP_SECURE_STORE = 'file'
      process.env.MOVP_CONFIG = join(dir, 'config.json')
      fileStore('http://api', process.env).save({ pat: 'movp_pat_secret' })
      const { cmd, out } = program()
      await cmd.parseAsync(['node', 'movp', 'logout'])
      expect(out.join('\n')).toContain('ok')
      expect(fileStore('http://api', process.env).load()).toEqual({})
    } finally {
      process.env = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2 — run, expect FAIL:**
  Run: `pnpm --filter @movp/cli exec vitest run program`
  Expected: FAIL — commander rejects `unknown command 'login'` / `'logout'`.

- [ ] **Step 3 — implement.** In `packages/cli/src/program.ts` extend the imports:

```ts
import { resolveCliCtx, exchangePat, type CliCtx } from './client.ts'
import { writeCliConfig, loadCliConfig } from './config.ts'
import { selectSecureStore } from './secure-store.ts'
```

  (The `writeCliConfig` import was added in C3b.1; merge these three lines so `client.ts` /
  `config.ts` / `secure-store.ts` are each imported once.)

  Add a module-level helper **above** `export function buildProgram`:

```ts
async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}
```

  Register `login` and `logout` next to `init` (before `program.command('codegen')`), inside
  `buildProgram`:

```ts
  program
    .command('login')
    .description('Validate a Personal Access Token via the exchange endpoint and store it securely')
    .option('--token <pat>', 'PAT (movp_pat_…); read from stdin when omitted')
    .action(async (o: { token?: string }) => {
      const pat = (o.token ?? (await readTokenFromStdin())).trim()
      if (!pat.startsWith('movp_pat_')) throw new Error('a movp_pat_… token is required')
      const cfg = loadCliConfig()
      const apiUrl = process.env.SUPABASE_URL ?? cfg?.apiUrl
      const anonKey = process.env.SUPABASE_ANON_KEY ?? cfg?.anonKey
      if (!apiUrl || !anonKey) throw new Error('run `movp init` first (apiUrl/anonKey missing)')
      // exchangePat throws the stable code ('invalid_token'|'expired_token') on reject, so a
      // bad PAT is never stored. NEVER print `pat` — only the non-secret metadata below.
      const ex = await exchangePat(pat, apiUrl, anonKey)
      selectSecureStore(apiUrl).save({ pat, session: { access_token: ex.access_token, expires_at: ex.expires_at } })
      out(JSON.stringify({ ok: true, user_id: ex.user_id, default_workspace_id: ex.default_workspace_id }))
    })

  program
    .command('logout')
    .description('Clear the stored PAT and cached session')
    .action(() => {
      const cfg = loadCliConfig()
      const apiUrl = process.env.SUPABASE_URL ?? cfg?.apiUrl
      if (!apiUrl) throw new Error('run `movp init` first (apiUrl missing)')
      selectSecureStore(apiUrl).clear()
      out(JSON.stringify({ ok: true }))
    })
```

- [ ] **Step 4 — run, expect PASS = 35:**
  Run: `pnpm --filter @movp/cli test`  → Expected: **35 tests** (33 + login + logout).

- [ ] **Step 5 — gate + commit.**
  Run: `pnpm --filter @movp/cli typecheck` (clean) and
  `grep -rnE "console\.[a-z]+\([^)]*(pat|session|token|secret)" packages/cli/src` (**empty**).

```bash
git add packages/cli/src/program.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): movp login (validate + store PAT) and movp logout (clear store)"
```

---

## Task C3b.5: `movp search --mode semantic|hybrid` via the GraphQL edge

**Files**
- Create: `packages/cli/src/graphql-client.ts`
- Modify: `packages/cli/src/program.ts` (rewrite the `search` action + import),
  `packages/cli/src/index.ts` (re-export), `packages/cli/test/program.test.ts` (replace the
  "search rejects semantic and hybrid" test with a hybrid-hit test)

**Interfaces**
- **Consumes from C3a contracts:** the GraphQL edge `POST ${apiUrl}/functions/v1/graphql`,
  `Authorization: Bearer <session access_token>` (the token minted by the C3a exchange and
  cached in C3b.3). Body `{ query, variables }`; response `{ data: { search: [...] } }`;
  `401/403` → stable `invalid_token`.
- **Produces:**
  ```ts
  export interface GraphqlSearchHit { collection: string; id: string; title: string; snippet: string; score: number }
  export async function searchViaGraphql(
    args: { apiUrl: string; accessToken: string; workspaceId: string; query: string; mode: 'semantic' | 'hybrid'; collection?: string; limit?: number },
    fetchImpl?: typeof fetch,
  ): Promise<GraphqlSearchHit[]>
  ```
- **Invariant:** `--mode fts` (and no `--mode`) stays on the **direct-PG** `domain.search({… mode:
  'fts' …})` path, byte-identical to today. Only `semantic`/`hybrid` route through the edge.

**TDD steps**

- [ ] **Step 1 — replace the failing test.** In `packages/cli/test/program.test.ts` **delete** the
  existing test `it('search rejects semantic and hybrid modes in the direct Node CLI', …)`
  (lines ~159–164 — its premise, "the CLI cannot do semantic/hybrid", is exactly what this task
  removes) and **replace** it in place with:

```ts
  it('search --mode hybrid routes to the GraphQL edge and returns hits', async () => {
    const prev = process.env.SUPABASE_URL
    process.env.SUPABASE_URL = 'http://api'
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ data: { search: [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 0.9 }] } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const { cmd, out } = program({ resolveCtx: () => ({ db: {} as never, userId: 'u', accessToken: 'session-jwt' }) })
    await cmd.parseAsync(['node', 'movp', 'search', 'Hello', '--workspace', 'w', '--mode', 'hybrid'])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/functions/v1/graphql')
    expect(out.at(-1)).toContain('n1')
    vi.unstubAllGlobals()
    if (prev === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = prev
  })
```

  (Keep the `it('search uses fts mode in the direct Node CLI', …)` test unchanged — it pins the
  fts branch.) Net count change: **0** (one test replaced by one).

- [ ] **Step 2 — run, expect FAIL:**
  Run: `pnpm --filter @movp/cli exec vitest run program`
  Expected: FAIL — the new hybrid test errors because the `search` action still throws
  `CLI search supports fts only…` for `--mode hybrid`, so `fetch` is never called.

- [ ] **Step 3 — implement** `packages/cli/src/graphql-client.ts` (REAL, complete):

```ts
export interface GraphqlSearchHit {
  collection: string
  id: string
  title: string
  snippet: string
  score: number
}

const SEARCH_QUERY = `query Search($workspaceId: ID!, $query: String!, $mode: String, $collection: String, $limit: Int) {
  search(workspaceId: $workspaceId, query: $query, mode: $mode, collection: $collection, limit: $limit) {
    collection id title snippet score
  }
}`

// Authenticated GraphQL client for semantic/hybrid search. Consumes the C3a-minted session
// access_token (Bearer). fts stays on the direct-PG domain path (see program.ts search action).
export async function searchViaGraphql(
  args: {
    apiUrl: string
    accessToken: string
    workspaceId: string
    query: string
    mode: 'semantic' | 'hybrid'
    collection?: string
    limit?: number
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GraphqlSearchHit[]> {
  const res = await fetchImpl(`${args.apiUrl}/functions/v1/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: {
        workspaceId: args.workspaceId,
        query: args.query,
        mode: args.mode,
        collection: args.collection ?? null,
        limit: args.limit ?? null,
      },
    }),
  })
  if (res.status === 401 || res.status === 403) throw new Error('invalid_token')
  if (!res.ok) throw new Error(`graphql_http_${res.status}`)
  const json = (await res.json()) as { data?: { search?: GraphqlSearchHit[] }; errors?: Array<{ message?: unknown }> }
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join('; ') || 'graphql_error')
  }
  return json.data?.search ?? []
}
```

- [ ] **Step 4 — rewrite the `search` action** in `packages/cli/src/program.ts`. Add the import:

```ts
import { searchViaGraphql } from './graphql-client.ts'
```

  Replace the entire `program.command('search <query>') … .action(…)` block (currently lines
  527–549, already `await`-converted in C3b.3) with:

```ts
  program
    .command('search <query>')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--mode <mode>', 'fts (direct PG) | semantic | hybrid (via the GraphQL edge)')
    .option('--collection <name>', 'restrict to a collection')
    .option('--limit <n>', 'max hits', (v) => parseInt(v, 10))
    .action(async (query: string, o: { workspace: string; mode?: string; collection?: string; limit?: number }) => {
      const ctx = await resolveCtx()
      if (o.mode === 'semantic' || o.mode === 'hybrid') {
        const cfg = loadCliConfig()
        const apiUrl = process.env.SUPABASE_URL ?? cfg?.apiUrl
        if (!apiUrl) throw new Error('SUPABASE_URL is required for semantic/hybrid search (run `movp init`)')
        if (!ctx.accessToken) throw new Error('semantic/hybrid search needs a session token (login with a PAT or set MOVP_ACCESS_TOKEN)')
        out(
          JSON.stringify(
            await searchViaGraphql({
              apiUrl,
              accessToken: ctx.accessToken,
              workspaceId: o.workspace,
              query,
              mode: o.mode,
              collection: o.collection,
              limit: o.limit,
            }),
          ),
        )
        return
      }
      if (o.mode && o.mode !== 'fts') throw new Error(`unknown search mode: ${o.mode}`)
      out(
        JSON.stringify(
          await createDomain(ctx).search({
            workspaceId: o.workspace,
            query,
            mode: 'fts',
            collection: o.collection,
            limit: o.limit,
          }),
        ),
      )
    })
```

- [ ] **Step 5 — re-export** from `packages/cli/src/index.ts` (append):

```ts
export { searchViaGraphql, type GraphqlSearchHit } from './graphql-client.ts'
```

- [ ] **Step 6 — run the full CLI suite, expect PASS = 35:**
  Run: `pnpm --filter @movp/cli test`  → Expected: **35 tests** (unchanged count — one test
  replaced). The `search uses fts mode` test still passes (fts → `domain.search`).

- [ ] **Step 7 — gate + commit.**
  Run: `pnpm --filter @movp/cli typecheck` (clean),
  `grep -n "console" packages/cli/src/graphql-client.ts` (**empty**), and
  `grep -Fc "CLI search supports fts only" packages/cli/src/program.ts` (**0** — the old throw is
  gone).

```bash
git add packages/cli/src/graphql-client.ts packages/cli/src/program.ts packages/cli/src/index.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): movp search --mode semantic|hybrid via the authenticated GraphQL edge"
```

---

## Task C3b.6: CLI integration test (init → login → list → hybrid → revoke → auth-fail)

**Files**
- Create: `packages/cli/test/integration.test.ts`

**Interfaces**
- **Consumes:** the whole C3b surface end-to-end through `buildProgram`'s **real** default
  `resolveCtx` (no injection) — PAT mode, session cache, secure store, GraphQL edge — plus a
  minimal `@movp/domain` mock (only `task.list`, since hybrid search bypasses the domain). The
  network (`auth-exchange`, `graphql`) is stubbed; the live proof is the C3d `[agents]` slice.
- **Invariant proven:** revoking the PAT (cached session expired **and** exchange now `401`)
  makes the next command **fail closed** with the stable code `invalid_token`; `bin.ts`'s
  existing catch maps that to `process.exit(1)`.

**TDD steps**

- [ ] **Step 1 — failing test** `packages/cli/test/integration.test.ts` (REAL, complete — 1 test):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/index.ts'
import { fileStore } from '../src/secure-store.ts'

// hybrid search bypasses the domain; only `task list` needs it. The vi.mock factory is not
// constrained to the full Domain type, so a minimal mock compiles and suffices.
vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    task: { list: async () => ({ items: [{ id: 't1', title: 'Ship it' }], nextCursor: null }) },
  }),
}))

function makeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
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
  it('init → login → list → hybrid → revoke → auth-fail (fails closed)', async () => {
    const out: string[] = []
    const run = (argv: string[]) => {
      const cmd = buildProgram({ out: (l) => out.push(l) })
      cmd.exitOverride()
      return cmd.parseAsync(['node', 'movp', ...argv])
    }
    const minted = makeJwt('user-1')

    // 1. init — writes config (no credential yet)
    await run(['init', '--api-url', 'http://api', '--anon-key', 'anon', '--workspace', 'w1'])
    expect(out.at(-1)).toContain('config.json')

    // 2. login — exchange returns a session; PAT + session are stored
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ access_token: minted, expires_at: nowSec() + 3600, default_workspace_id: 'w1', user_id: 'user-1' }), { status: 200 }),
    ))
    await run(['login', '--token', 'movp_pat_live'])
    expect(out.at(-1)).toContain('user-1')
    expect(out.join('\n')).not.toContain('movp_pat_live')

    // 3. list tasks — resolves via the cached session (no re-exchange)
    await run(['task', 'list', '--workspace', 'w1'])
    expect(out.at(-1)).toContain('t1')

    // 4. hybrid search — routes to the GraphQL edge with the session token
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: { search: [{ collection: 'note', id: 'n1', title: 'Hi', snippet: 'Hi', score: 1 }] } }), { status: 200 }),
    ))
    await run(['search', 'Hi', '--workspace', 'w1', '--mode', 'hybrid'])
    expect(out.at(-1)).toContain('n1')

    // 5. revoke — the cached session is now expired AND the PAT is rejected at the exchange
    fileStore('http://api', process.env).save({ pat: 'movp_pat_live', session: { access_token: minted, expires_at: nowSec() - 10 } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 })))

    // 6. next command fails closed with the stable auth code (bin.ts → exit 1)
    await expect(run(['task', 'list', '--workspace', 'w1'])).rejects.toThrow(/invalid_token/)
  })
})
```

- [ ] **Step 2 — run, expect FAIL first, then PASS.** With C3b.1–C3b.5 already implemented, this
  test **passes immediately** — so to honor fail-first, run it **once against the current tree
  BEFORE writing the implementation of any earlier task is not possible here** (C3b.6 has no new
  production code). Instead, prove the assertion bites by temporarily breaking step 6's contract:
  run `pnpm --filter @movp/cli exec vitest run integration` after commenting out the
  `if (res.status === 401 …) throw new Error('invalid_token')` line in `exchangePat`
  (`packages/cli/src/client.ts`) →
  Expected: FAIL — the final `rejects.toThrow(/invalid_token/)` does not throw. **Restore the
  line** and re-run.
  Run (restored): `pnpm --filter @movp/cli exec vitest run integration`
  Expected: PASS — `integration.test.ts (1 test)`.

- [ ] **Step 3 — run the full CLI suite, expect PASS = 36:**
  Run: `pnpm --filter @movp/cli test`  → Expected: **36 tests** across 5 files
  (program 19 + config 4 + secure-store 6 + client 6 + integration 1).

- [ ] **Step 4 — full C3b gate.** All must hold:
  - `pnpm --filter @movp/cli test` → **36 passed**.
  - `pnpm typecheck` → **12/12** packages clean (C3b added no package).
  - `grep -rnE "console\.[a-z]+\([^)]*(pat|session|token|secret)" packages/cli/src` → **empty**.
  - `grep -rn "console" packages/cli/src/secure-store.ts packages/cli/src/config.ts packages/cli/src/graphql-client.ts` → **empty**.

- [ ] **Step 5 — commit.**

```bash
git add packages/cli/test/integration.test.ts
git commit -m "test(cli): PAT lifecycle integration (init→login→list→hybrid→revoke→auth-fail)"
```

- [ ] **Step 6 — update the Stage C status.** In `docs/superpowers/plans/README.md`, mark C3b as
  landed in the **Stage B/C EXECUTION STATUS** table (per repo CLAUDE.md "Phase Completion
  Signal") in the same commit that lands this task or the merge commit. C3 phase stays open
  until C3c + C3d land; do **not** mark the C3 phase done from C3b alone.

---

## Cross-cutting acceptance criteria (verify before requesting review)

- **Correctness:** precedence is `MOVP_ACCESS_TOKEN > MOVP_PAT/stored PAT > service-role`, pinned
  by `client.test.ts`; the two existing modes keep byte-identical `createClient(...)` calls;
  `--mode fts` unchanged (direct PG), `semantic|hybrid` via the edge. spec §6/§8/§9 ↔ code ↔
  tests agree.
- **Safety:** PAT + session at rest only in the Keychain or a **`0600`** file; file reads are
  **symlink-refused before read** (untrusted-io); the PAT/session are **never** printed or
  logged (grep gate empty; login prints only `user_id`/`default_workspace_id`); a bad PAT is
  validated-then-rejected and never stored. Config holds only public values (apiUrl, anon key).
- **Reliability:** cached session re-exchanged only on expiry (60s skew, ms-tolerant);
  revoked/expired PAT → the next command **fails closed** with `invalid_token`/`expired_token`
  and (via `bin.ts`) a non-zero exit — pinned by `integration.test.ts` and the
  revoked-PAT `client.test.ts` case.
- **Observability:** exchange/GraphQL rejects surface the **stable** codes unchanged; `bin.ts`'s
  existing `@movp/obs` catch-all emits CLI failures (no new per-op instrumentation added); no
  secret ever reaches a log.
- **Efficiency/Performance:** the session is exchanged once per instance and cached; hot
  commands reuse the cached token (no exchange round-trip) until expiry. hybrid search is a
  single POST; fts adds no round-trip.
- **Simplicity:** no new package, **no new dependency**; the store shells out to `security`
  rather than pulling a keychain lib; `resolveCtx` is the single credential seam.
- **Usability:** `movp init` removes the SUPABASE_URL-env requirement; `movp login` accepts a
  pasted `--token` or stdin; errors are actionable ("run `movp init` first"); secrets never
  echo to the terminal.

## Self-check (author, satisfied)
1. Every task has exact file paths, exact commands, and an **expected test count**
   (16→21→27→33→35→35→36) + typecheck 12/12. ✅
2. Every code sample is copy-paste-correct and consistent with the prose (async `resolveCtx`,
   `await` at 38+2 sites, byte-identical ACCESS_TOKEN/service-role blocks). ✅
3. Platform gotchas commented **at the trigger site**: `0o600`+`chmod` and `lstat`-symlink-refuse
   in `fileStore`; `apikey` header + "never log the token" in `exchangePat`; ms-tolerant
   `expires_at`. ✅
4. Cross-part dependency stated: C3a delivers `auth-exchange` + PAT RPCs; C3b consumes the
   endpoint I/O + codes; **precondition C3a merged**. ✅
5. Every task ends with a machine-checkable gate (named vitest run + count, `pnpm typecheck`, a
   grep-for-secret-logging that must be empty). ✅
6. No task relies on a fact available only in the authoring conversation. ✅
</content>
</invoke>
