import { lstatSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  candidateSnapshotPath,
  writeDecisionTransient,
  writeRunTransient,
} from '../clean-run-lib.mjs'

describe('clean-run transient state', () => {
  it('reads aggregate candidate snapshots from the workspace report root', () => {
    expect(candidateSnapshotPath('/spike', 'blocknote')).toBe('/spike/.report/blocknote.json')
    expect(candidateSnapshotPath('/spike', 'tiptap')).toBe('/spike/.report/tiptap.json')
  })

  it('writes the operator decision as owner-only JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-clean-'))
    const path = join(root, 'decision.json')
    writeDecisionTransient(path, {
      licenseDecision: { kind: 'permissive_only' },
      selectedCandidate: 'tiptap',
    })
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      licenseDecision: { kind: 'permissive_only' },
      selectedCandidate: 'tiptap',
    })
  })

  it('writes measured run state as owner-only JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'spk-clean-'))
    const path = join(root, 'run.json')
    writeRunTransient(path, { schemaVersion: 1, commands: [] })
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  })
})
