// Reads docs-site/movp.schema.json and writes the reference pages. Run: pnpm docs:reference.
// CI regenerates and runs `pnpm check:docs-freshness`.
import { fileURLToPath } from 'node:url'
import { readSchemaManifest } from '../src/dsl-reference/read-manifest.ts'
import { writeDslReference } from '../src/dsl-reference/write-reference.ts'

const MANIFEST_PATH = fileURLToPath(new URL('../movp.schema.json', import.meta.url))
const DOCS_ROOT = fileURLToPath(new URL('../src/content/docs/', import.meta.url))

const pageCount = await writeDslReference(DOCS_ROOT, await readSchemaManifest(MANIFEST_PATH))
console.log(`wrote ${pageCount} reference pages under docs-site/src/content/docs/reference/`)
