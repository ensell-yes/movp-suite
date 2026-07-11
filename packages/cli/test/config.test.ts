import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('returns null for an absent config, and quarantines a malformed one to .corrupt', () => {
    // Absent → null, nothing to quarantine.
    expect(loadCliConfig({ MOVP_CONFIG: join(dir, 'missing.json') })).toBeNull()
    // Present but wrong-shape (parseable JSON, apiUrl is a number) → null + quarantine.
    writeFileSync(join(dir, 'bad.json'), '{"apiUrl":123}')
    expect(loadCliConfig({ MOVP_CONFIG: join(dir, 'bad.json') })).toBeNull()
    expect(existsSync(join(dir, 'bad.json'))).toBe(false)
    expect(existsSync(join(dir, 'bad.json.corrupt'))).toBe(true)
  })

  it('refuses to read a symlinked config file (untrusted-io)', () => {
    symlinkSync('/etc/hosts', join(dir, 'linked.json'))
    expect(() => loadCliConfig({ MOVP_CONFIG: join(dir, 'linked.json') })).toThrow(/symlink/)
  })

  it('quarantines an oversized config without reading it (untrusted-io)', () => {
    const big = join(dir, 'big.json')
    // > MAX_PERSISTED_BYTES (64 KiB): valid-shaped but padded — rejected on size, before parse.
    writeFileSync(big, `{"apiUrl":"${'x'.repeat(70 * 1024)}","anonKey":"anon"}`)
    expect(loadCliConfig({ MOVP_CONFIG: big })).toBeNull()
    expect(existsSync(big)).toBe(false)
    expect(existsSync(`${big}.corrupt`)).toBe(true)
  })

  it('refuses to write config THROUGH a symlink and leaves the target untouched (untrusted-io)', () => {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'original', 'utf8')
    symlinkSync(target, join(dir, 'config.json'))
    expect(() => writeCliConfig({ apiUrl: 'http://api', anonKey: 'anon' }, { MOVP_CONFIG: join(dir, 'config.json') })).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  it('refuses a non-regular file at the config path (FIFO/device/dir — untrusted-io)', () => {
    // A directory exercises the same `!st.isFile()` guard that refuses FIFOs and devices.
    mkdirSync(join(dir, 'adir'))
    expect(() => loadCliConfig({ MOVP_CONFIG: join(dir, 'adir') })).toThrow(/non-regular file/)
  })

  it('fails loud (not "absent") when the config path is unreadable (untrusted-io)', () => {
    // A regular file where a parent directory is expected → ENOTDIR, not ENOENT.
    writeFileSync(join(dir, 'afile'), 'x')
    expect(() => loadCliConfig({ MOVP_CONFIG: join(dir, 'afile', 'config.json') })).toThrow(/persisted_state_unreadable/)
  })
})
