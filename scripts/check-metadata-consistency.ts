import { execFileSync } from 'node:child_process'
import { schema } from '@movp/core-schema'
import {
  checkMetadataConsistency,
  MetadataConsistencyError,
  type MetadataDbState,
} from '@movp/codegen'

const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:64322/postgres'

function queryRows<T>(sql: string): T[] {
  const output = execFileSync(
    'psql',
    [DB_URL, '-tAX', '-c', `select coalesce(json_agg(t), '[]') from (${sql}) t`],
    { encoding: 'utf8' },
  )
  const parsed: unknown = JSON.parse(output.trim())
  if (!Array.isArray(parsed)) throw new Error('metadata_query_invalid_shape')
  return parsed as T[]
}

function main(): void {
  const collections = queryRows<MetadataDbState['collections'][number]>(
    'select name, label, label_plural, workspace_scoped, layer from public.movp_collections',
  )
  const fields = queryRows<MetadataDbState['fields'][number]>(
    'select collection_name, name, type, label, cardinality, reporting_role, searchable, embeddable, layer from public.movp_fields',
  )
  try {
    checkMetadataConsistency(schema, { collections, fields })
    console.log('metadata consistency: OK')
  } catch (error: unknown) {
    if (error instanceof MetadataConsistencyError) {
      console.error(`metadata consistency FAILED [${error.code}]: ${error.detail}`)
      process.exit(1)
    }
    throw error
  }
}

main()
