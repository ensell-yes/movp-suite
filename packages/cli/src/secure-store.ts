import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { credentialsPath, quarantineCorrupt, readPersisted } from './config.ts'

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
      // untrusted-io: lstat-before-read (refuse symlinks) + bound-before-buffer (quarantine
      // oversized) live in the shared readPersisted() (config.ts), so config and credentials
      // enforce one identical read policy.
      const r = readPersisted(path)
      if (!r.ok) return {}
      try {
        const parsed: unknown = JSON.parse(r.raw)
        if (isCredentials(parsed)) return parsed
      } catch {
        /* unparseable — fall through to quarantine */
      }
      // Present but unparseable or wrong-shape → quarantine to `<path>.corrupt` and treat as
      // absent — preserved for debugging, never silently re-masked, never `as`-cast.
      quarantineCorrupt(path)
      return {}
    },
    save(next: Credentials): void {
      mkdirSync(dirname(path), { recursive: true })
      // untrusted-io: refuse to write secrets THROUGH a symlink. A pre-planted
      // credentials.json -> <attacker path> would otherwise redirect the PAT/session to a
      // location the attacker chose (or clobber a sensitive target). Mirror load()'s lstat
      // guard on the write path — a missing file is the normal first write, so lstat failure
      // falls through to the write.
      let existing: Stats | null = null
      try {
        existing = lstatSync(path)
      } catch {
        existing = null
      }
      if (existing?.isSymbolicLink()) throw new Error(`refusing to write credentials via symlink: ${path}`)
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
export type KeychainRunner = (args: string[], input?: string) => { status: number | null; stdout: string; error?: Error }

const defaultRunner: KeychainRunner = (args, input) => {
  // `input` is piped to the child's stdin — the write path uses it to pass the secret to a bare
  // `-w` prompt instead of putting it in argv.
  const r = spawnSync('security', args, { encoding: 'utf8', input })
  return { status: r.status, stdout: r.stdout ?? '', error: r.error ?? undefined }
}

export function keychainStore(apiUrl: string, opts: { run?: KeychainRunner; account?: string } = {}): SecureStore {
  const run = opts.run ?? defaultRunner
  const account = opts.account ?? process.env.USER ?? 'movp'
  const h = instanceHash(apiUrl)
  const patSvc = `movp:pat:${h}`
  const sessSvc = `movp:session:${h}`
  // `security` exits 44 (errSecItemNotFound) when an item is absent; any OTHER nonzero/null
  // status is an OPERATIONAL failure (locked keychain, denied, spawn error) and must NOT be
  // swallowed as "absent"/"ok". Error messages are content-free — the status number only,
  // never the PAT/value.
  const NOT_FOUND = 44
  const find = (svc: string): string | undefined => {
    const r = run(['find-generic-password', '-a', account, '-s', svc, '-w'])
    if (r.status === 0) return r.stdout.replace(/\n$/, '')
    if (r.status === NOT_FOUND) return undefined
    throw new Error(`keychain read failed (status ${r.status ?? 'null'})`)
  }
  const put = (svc: string, value: string): void => {
    // Secret via STDIN, never argv (argv is world-visible in `ps`; `add-generic-password -h`
    // flags `-w <value>` as insecure). Bare `-w` MUST be last and prompts twice (enter + retype),
    // so pipe the value TWICE — a single line silently stores an EMPTY password while `add` still
    // exits 0. -U updates in place, preserving an already-stored PAT when only the session changes.
    const r = run(['add-generic-password', '-U', '-a', account, '-s', svc, '-w'], `${value}\n${value}\n`)
    if (r.status !== 0) throw new Error(`keychain write failed (status ${r.status ?? 'null'})`)
  }
  const remove = (svc: string): void => {
    // 0 = deleted, 44 = already absent; anything else is a real failure — logout must not
    // report success while the PAT is still stored.
    const r = run(['delete-generic-password', '-a', account, '-s', svc])
    if (r.status !== 0 && r.status !== NOT_FOUND) throw new Error(`keychain delete failed (status ${r.status ?? 'null'})`)
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
      if (next.pat !== undefined) put(patSvc, next.pat)
      if (next.session !== undefined) put(sessSvc, JSON.stringify(next.session))
    },
    clear(): void {
      remove(patSvc)
      remove(sessSvc)
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
