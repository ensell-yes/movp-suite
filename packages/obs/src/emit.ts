import { REDACTION_VERSION, type ObsEvent, type Surface } from './event.ts'

const SURFACES: readonly string[] = ['graphql', 'mcp', 'cli', 'flows', 'embed', 'ingest']

function isSurface(v: unknown): v is Surface {
  return typeof v === 'string' && SURFACES.includes(v)
}

function redact(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined) continue
    if (typeof v === 'string' && v.includes('@')) continue
    out[k] = v
  }
  return out
}

function write(rec: Record<string, unknown>): void {
  console.log(JSON.stringify(rec))
}

export function emit(e: ObsEvent): void {
  const violated = !isSurface(e.surface)
  const surface = violated ? 'unknown' : e.surface
  write(redact({ ...e, surface, redaction_version: REDACTION_VERSION }))
  if (violated) {
    write(
      redact({
        ...e,
        surface: 'unknown',
        error_code: 'observability_enum_violation',
        redaction_version: REDACTION_VERSION,
      }),
    )
  }
}
