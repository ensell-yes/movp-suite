import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs'

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
  // untrusted-io: refuse to write THROUGH a pre-planted symlink at the config path — it could
  // redirect the write to (or clobber) another user-writable file. Mirror the credential save
  // guard; a missing file (ENOENT) is the normal first write, so lstat failure falls through.
  let existing: Stats | null = null
  try {
    existing = lstatSync(p)
  } catch {
    existing = null
  }
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write config via symlink: ${p}`)
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  return p
}

// untrusted-io: a present-but-invalid persisted file (unparseable, or parseable-but-wrong-
// shape) is renamed to `<path>.corrupt` and treated as absent — preserved for debugging,
// never silently re-masked, never crashing downstream. Best-effort: a rename failure
// (read-only dir, concurrent process) must not break the load. Never logs file contents
// (config/credentials may hold a secret).
export function quarantineCorrupt(path: string): void {
  try {
    renameSync(path, `${path}.corrupt`)
  } catch {
    /* best-effort: leave the file in place if it can't be renamed */
  }
}

// untrusted-io: config/credentials are tiny JSON; cap the read so a huge (corrupt or hostile)
// file can't be buffered into memory. 64 KiB is generous headroom over any real config/creds file.
export const MAX_PERSISTED_BYTES = 64 * 1024

export type PersistedRead =
  | { ok: true; raw: string }
  | { ok: false; reason: 'absent' | 'quarantined' }

// Read a caller-controlled persisted file under the untrusted-io rules — shared by the config
// AND credential loaders so the policy lives in one place: lstat BEFORE any read (refuse a
// symlink — a MOVP_CONFIG / credentials path could redirect the read to ~/.ssh/id_rsa), then
// bound BEFORE buffering (quarantine an oversized file without reading its bytes). Never logs
// file contents. Throws on a symlink (loud refusal); returns a skip reason otherwise.
export function readPersisted(path: string): PersistedRead {
  let st: Stats
  try {
    st = lstatSync(path)
  } catch (err) {
    // Only a genuinely-missing file is "absent". A permission / ENOTDIR / I/O failure must fail
    // LOUD — silently treating it as unconfigured masks a real problem (untrusted-io / fail-hard).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'absent' }
    throw new Error(`persisted_state_unreadable: ${path}`, { cause: err })
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to read a symlinked file: ${path}`)
  // untrusted-io: only a regular file may be read. A FIFO would block readFileSync forever; a
  // char device (e.g. /dev/zero) reports a tiny st.size but streams unbounded bytes → OOM. Refuse
  // every non-regular file (FIFO, device, socket, directory) BEFORE the size check or read.
  if (!st.isFile()) throw new Error(`refusing to read a non-regular file: ${path}`)
  if (st.size > MAX_PERSISTED_BYTES) {
    quarantineCorrupt(path)
    return { ok: false, reason: 'quarantined' }
  }
  return { ok: true, raw: readFileSync(path, 'utf8') }
}

export function loadCliConfig(env: Record<string, string | undefined> = process.env): CliConfig | null {
  const p = configPath(env)
  const r = readPersisted(p) // lstat-before-read + bound-before-buffer (untrusted-io)
  if (!r.ok) return null
  try {
    const parsed: unknown = JSON.parse(r.raw)
    if (isCliConfig(parsed)) return parsed
  } catch {
    /* unparseable — fall through to quarantine */
  }
  quarantineCorrupt(p)
  return null
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
