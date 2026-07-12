// Pure ingestion bounds — the "bound-before-buffer" gate for external events.
// DUPLICATED VERBATIM in supabase/functions/_shared/ingest-bounds.ts (Deno edge).
// Byte length is measured with new TextEncoder().encode(...).length — TextEncoder is a
// web standard present in BOTH Node (vitest) and the Deno edge runtime with NO polyfill,
// so this module is valid verbatim in both. Do NOT use Buffer (it is not a Deno global).
export const INGEST_MAX_BATCH = 500;
export const INGEST_MAX_PROP_BYTES = 16 * 1024; // 16 KiB, measured on the serialized payload

export interface NormalizedEvent {
  event_type: string;
  subject_type: string; // platform_event.subject_type is NOT NULL; missing -> defaulted to 'user'
  subject_ref: string;
  actor_ref: string | null;
  properties: Record<string, unknown>;
  occurred_at: string;
  idempotency_key?: string;
}

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function validateIngestEvent(e: unknown):
  { ok: true; value: NormalizedEvent } | { ok: false; error: 'malformed' | 'oversized' } {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: 'malformed' };
  const o = e as Record<string, unknown>;
  const event_type = asStr(o['event_type']);
  const subject_ref = asStr(o['subject_ref']);
  const occurred_at = asStr(o['occurred_at']);
  const rawIdempotencyKey = o['idempotency_key'];
  const idempotency_key = asStr(rawIdempotencyKey);
  if (!event_type || event_type.length === 0) return { ok: false, error: 'malformed' };
  if (!subject_ref || subject_ref.length === 0) return { ok: false, error: 'malformed' };
  if (!occurred_at || Number.isNaN(Date.parse(occurred_at))) return { ok: false, error: 'malformed' };
  if (rawIdempotencyKey !== undefined && (
    !idempotency_key || new TextEncoder().encode(idempotency_key).length > 255
  )) return { ok: false, error: 'malformed' };
  const rawProps = o['properties'];
  const properties = (rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps))
    ? (rawProps as Record<string, unknown>) : {};
  // This is an early compact-JSON bound, not the final storage contract. PostgreSQL
  // authoritatively measures canonical jsonb text, which can be larger at the same payload.
  // TextEncoder is a web standard in BOTH Node (vitest) and Deno — no Buffer, no polyfill.
  if (new TextEncoder().encode(JSON.stringify(properties)).length > INGEST_MAX_PROP_BYTES) {
    return { ok: false, error: 'oversized' };
  }
  // normalize to known fields ONLY — unknown/extra fields are dropped here.
  // subject_type defaults to 'user' so platform_event.subject_type (NOT NULL) is always satisfied.
  return {
    ok: true,
    value: {
      event_type,
      subject_type: asStr(o['subject_type']) ?? 'user',
      subject_ref,
      actor_ref: asStr(o['actor_ref']),
      properties,
      occurred_at,
      ...(idempotency_key ? { idempotency_key } : {}),
    },
  };
}
