#!/usr/bin/env -S npx tsx
// The published @movp/cli bin bakes in the PLATFORM schema only. A scaffold's CLI must expose the
// COMPOSED project schema (kb_category/kb_article), so it wires buildProgram(schema) here. Run via
// `npm run movp -- <cmd>` (package.json script), never the installed `movp` bin.
import { buildProgram } from '@movp/cli'
import { schema } from '../movp.config.mjs'

buildProgram(schema)
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
