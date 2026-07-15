// Gate: the committed docs manifest matches the live @movp/core-schema `schema`
// (projection + fingerprint). This is a pure schema check with NO database — the
// live-DB truth (schema <-> movp_fields) is C6c's `supabase db reset` gate, which
// this job does not duplicate. Run: pnpm check:docs-manifest.
import { fileURLToPath } from 'node:url'
import { schema } from '@movp/core-schema'
import { assertManifestMatchesSchema, DocsConsistencyError } from '../docs-site/src/dsl-reference/consistency.ts'
import { readSchemaManifest } from '../docs-site/src/dsl-reference/read-manifest.ts'

const MANIFEST_PATH = fileURLToPath(new URL('../docs-site/movp.schema.json', import.meta.url))

async function main(): Promise<void> {
  const manifest = await readSchemaManifest(MANIFEST_PATH)
  try {
    assertManifestMatchesSchema(schema, manifest)
    console.log('docs manifest consistency: OK')
  } catch (error: unknown) {
    // One error type carries every stable code (C6c comparator + fingerprint) via
    // its typed `.code`; no message-prefix sniffing, no separate fallback branch.
    if (error instanceof DocsConsistencyError) {
      console.error(`docs manifest consistency FAILED [${error.code}]: ${error.detail}`)
      process.exit(1)
    }
    throw error
  }
}

await main()
