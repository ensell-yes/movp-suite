#!/usr/bin/env -S npx tsx
import { emit, REDACTION_VERSION } from '@movp/obs'
import { buildProgram } from './program.ts'

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    emit({
      trace_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      surface: 'cli',
      operation: process.argv[2] ?? 'unknown',
      error_code: 'cli_error',
      redaction_version: REDACTION_VERSION,
    })
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
