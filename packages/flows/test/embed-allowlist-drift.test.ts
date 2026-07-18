import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EMBEDDABLE_FIELDS } from '../src/embed-worker.ts'

const MAX_MIGRATION_BYTES = 5 * 1024 * 1024
const MAX_MIGRATION_FILES = 256
const MAX_TOTAL_MIGRATION_BYTES = 64 * 1024 * 1024
const ENQUEUE_PAIR_PATTERN = /jsonb_build_object\(\s*'source_table',\s*'([a-z_]+)',\s*'source_id',\s*new\.id,\s*'field',\s*'([a-z_]+)'/g
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))

function allowedEmbedPairs(): string[] {
  return Object.entries(EMBEDDABLE_FIELDS)
    .flatMap(([sourceTable, fields]) => fields.map((field) => `${sourceTable}.${field}`))
    .sort()
}

async function readEmbedEnqueuePairs(migrationsDirectory: string): Promise<string[]> {
  const directoryInfo = await lstat(migrationsDirectory)
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error('migrations_directory_not_regular')
  }
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  if (migrationFiles.length === 0) throw new Error('migration_files_missing')
  if (migrationFiles.length > MAX_MIGRATION_FILES) throw new Error('migration_file_count_exceeded')

  let totalBytes = 0
  const pairs = new Set<string>()
  for (const migrationFile of migrationFiles) {
    const path = join(migrationsDirectory, migrationFile)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('migration_not_regular_file')
    if (info.size > MAX_MIGRATION_BYTES) throw new Error('migration_too_large')
    totalBytes += info.size
    if (totalBytes > MAX_TOTAL_MIGRATION_BYTES) throw new Error('migrations_total_too_large')
    const migration = await readFile(path, 'utf8')
    for (const match of migration.matchAll(ENQUEUE_PAIR_PATTERN)) {
      pairs.add(`${match[1]}.${match[2]}`)
    }
  }
  return [...pairs].sort()
}

describe('embed worker allow-list drift', () => {
  it('exactly matches every migration embed enqueue target', async () => {
    const enqueuedPairs = await readEmbedEnqueuePairs(MIGRATIONS_DIRECTORY)

    expect(enqueuedPairs).toEqual(allowedEmbedPairs())
  })

  it('detects an embed enqueue target introduced by a second migration', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'movp-embed-drift-'))
    const baseline = [
      "jsonb_build_object('source_table', 'note', 'source_id', new.id, 'field', 'body', 'content_hash', v_hash)",
      "jsonb_build_object('source_table', 'task_revision', 'source_id', new.id, 'field', 'body', 'content_hash', v_hash)",
      "jsonb_build_object('source_table', 'content_item', 'source_id', new.id, 'field', 'search_body', 'content_hash', v_hash)",
      "jsonb_build_object('source_table', 'campaign', 'source_id', new.id, 'field', 'brief', 'content_hash', v_hash)",
    ].join('\n')
    const delta = [
      "jsonb_build_object('source_table', 'note', 'source_id', new.id, 'field', 'body', 'content_hash', v_hash)",
      "jsonb_build_object('source_table', 'reaction', 'source_id', new.id, 'field', 'body', 'content_hash', v_hash)",
    ].join('\n')

    try {
      await writeFile(join(fixtureDirectory, '20260701000002_movp_generated.sql'), baseline, { mode: 0o600 })
      await writeFile(join(fixtureDirectory, '20260719000001_movp_generated_reaction.sql'), delta, { mode: 0o600 })

      const enqueuedPairs = await readEmbedEnqueuePairs(fixtureDirectory)
      const allowedPairs = new Set(allowedEmbedPairs())
      expect(enqueuedPairs.filter((pair) => !allowedPairs.has(pair))).toEqual(['reaction.body'])
      expect(enqueuedPairs.filter((pair) => pair === 'note.body')).toHaveLength(1)
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true })
    }
  })
})
