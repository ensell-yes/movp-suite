import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('refuses to write credentials THROUGH a symlink and leaves the target untouched (untrusted-io)', () => {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'original', 'utf8')
    symlinkSync(target, join(dir, 'credentials.json'))
    expect(() => fileStore('http://api', env).save({ pat: PAT })).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  it('quarantines a malformed credentials file to .corrupt and treats it as absent (untrusted-io)', () => {
    writeFileSync(join(dir, 'credentials.json'), '{ not valid json', 'utf8')
    expect(fileStore('http://api', env).load()).toEqual({})
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
    expect(existsSync(join(dir, 'credentials.json.corrupt'))).toBe(true)
  })

  it('quarantines an oversized credentials file without reading it (untrusted-io)', () => {
    // > MAX_PERSISTED_BYTES (64 KiB): rejected on size before any read/parse.
    writeFileSync(join(dir, 'credentials.json'), `{"pat":"${'x'.repeat(70 * 1024)}"}`, 'utf8')
    expect(fileStore('http://api', env).load()).toEqual({})
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
    expect(existsSync(join(dir, 'credentials.json.corrupt'))).toBe(true)
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
  it('supplies the secret via stdin (bare -w, never argv) and never logs the PAT', () => {
    const calls: Array<{ args: string[]; input?: string }> = []
    const kv: Record<string, string> = {}
    const run: KeychainRunner = (args, input) => {
      calls.push({ args, input })
      if (args[0] === 'add-generic-password') {
        // Real `security` prompts twice on a bare -w; the value is the first stdin line.
        kv[args[args.indexOf('-s') + 1]!] = (input ?? '').split('\n')[0]!
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
    const add = calls.find((c) => c.args[0] === 'add-generic-password')!
    expect(add.args).toContain('-U')
    expect(add.args[add.args.indexOf('-a') + 1]).toBe('tester')
    expect(add.args[add.args.indexOf('-s') + 1]).toMatch(/^movp:pat:[0-9a-f]{16}$/)
    // -w is the LAST arg (bare); the secret is NOT anywhere in argv, only in stdin, piped twice.
    expect(add.args[add.args.length - 1]).toBe('-w')
    expect(add.args).not.toContain(PAT)
    expect(add.input).toBe(`${PAT}\n${PAT}\n`)
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain(PAT)
  })

  it('throws (not silent success) when a keychain write fails, without exposing the PAT', () => {
    const run: KeychainRunner = () => ({ status: 51, stdout: '' }) // e.g. keychain locked / denied
    let message = ''
    try {
      keychainStore('http://api', { run, account: 'tester' }).save({ pat: PAT })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/keychain write failed/)
    expect(message).not.toContain(PAT)
  })

  it('throws when a keychain delete fails — logout must not report success', () => {
    const run: KeychainRunner = () => ({ status: 51, stdout: '' })
    expect(() => keychainStore('http://api', { run, account: 'tester' }).clear()).toThrow(/keychain delete failed/)
  })

  it('distinguishes a not-found item (44) from a keychain read failure', () => {
    const notFound: KeychainRunner = () => ({ status: 44, stdout: '' })
    expect(keychainStore('http://api', { run: notFound, account: 'tester' }).load()).toEqual({ pat: undefined, session: undefined })
    const failing: KeychainRunner = () => ({ status: 51, stdout: '' })
    expect(() => keychainStore('http://api', { run: failing, account: 'tester' }).load()).toThrow(/keychain read failed/)
  })
})
