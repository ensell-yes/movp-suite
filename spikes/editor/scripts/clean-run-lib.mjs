import { writeJsonAtomic } from './lib/safe-io.mjs'
import { join } from 'node:path'

export function candidateSnapshotPath(spikeRoot, candidate) {
  return join(spikeRoot, '.report', `${candidate}.json`)
}

export function writeDecisionTransient(path, decision) {
  writeJsonAtomic(path, decision)
}

export function writeRunTransient(path, run) {
  writeJsonAtomic(path, run)
}
