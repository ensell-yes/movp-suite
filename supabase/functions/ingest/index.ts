import { createClient } from '@supabase/supabase-js'; // mapped in ./deno.json (mirror graphql, NOT flows)
import { decideAgentAccess, resolvePrincipal } from '@movp/auth'; // resolved via supabase/functions/ingest/deno.json
import { emit, REDACTION_VERSION } from '@movp/obs';
import {
  INGEST_MAX_BATCH, validateIngestEvent, type NormalizedEvent,
} from '../_shared/ingest-bounds.ts';

const INGEST_MAX_BODY_BYTES = INGEST_MAX_BATCH * (16 * 1024 + 1024);
type AdminRpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function readJsonCapped(req: Request, maxBytes: number): Promise<unknown | null | 'too_large'> {
  const declared = req.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) return 'too_large';
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  // One correlation id pair per request so every emit() below ties together.
  const trace_id = crypto.randomUUID();
  const request_id = crypto.randomUUID();
  // Every failure emits a structured @movp/obs event carrying field NAMES + a bounded
  // error_code ONLY — never the request body, event properties, x-ingest-key, or raw key.
  // (redact() also drops any @-string.) No raw console logging here; emit is the only sink.
  const fail = (status: number, operation: string, error_code: string, actor_id?: string) => {
    emit({ trace_id, request_id, actor_id, surface: 'ingest', operation, error_code, redaction_version: REDACTION_VERSION });
    return json(status, { error: error_code });
  };

  if (req.method !== 'POST') return fail(405, 'ingest', 'method_not_allowed');

  // GOTCHA: resolve env at call time (Deno.env, Vault-backed); never module-scope the client.
  // SUPABASE_JWT_ISSUER mirrors functions/graphql/index.ts so a custom-issuer JWT that
  // graphql accepts is not 401'd here (falls back through MOVP_JWT_ISSUER -> default).
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    SUPABASE_JWT_ISSUER: Deno.env.get('MOVP_JWT_ISSUER') ?? Deno.env.get('SUPABASE_JWT_ISSUER') ?? undefined,
  };

  const ingestKey = req.headers.get('x-ingest-key');
  const hasAuth = (req.headers.get('Authorization') ?? '').length > 0;

  // F6: authenticate before reading the body. This function has `verify_jwt = false` because the
  // API-key path has no Authorization header; without this order, unauthenticated callers could
  // force JSON parsing/buffering before being rejected.
  if (!ingestKey && !hasAuth) return fail(401, 'authenticate', 'missing_credentials');
  if (ingestKey && hasAuth) return fail(400, 'authenticate', 'ambiguous_auth');

  let admin: AdminRpc | null = null;
  let jwtPrincipal: Awaited<ReturnType<typeof resolvePrincipal>> | null = null;
  if (ingestKey) {
    admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) as unknown as AdminRpc;
    // Preflight the API key before buffering the request body. An empty batch validates the
    // hashed key through the authoritative RPC without inserting events or firing triggers.
    const { error } = await admin.rpc('ingest_platform_event', { api_key: ingestKey, events: [] });
    if (error) {
      if (error.code === '28000') return fail(401, 'ingest_key', 'invalid_ingest_key');
      return fail(500, 'ingest_key', 'ingest_failed');
    }
  } else {
    const principal = await resolvePrincipal(req, env);
    if (!principal.ok) {
      return fail(principal.code === 'agent_session_ttl_out_of_bounds' ? 503 : 401, 'authenticate', principal.code);
    }
    if (principal.credentialKind === 'pat') {
      const decision = decideAgentAccess(principal.agentAccess, 'cli');
      if (!decision.ok) return fail(403, 'authorize', decision.code, principal.userId);
    }
    jwtPrincipal = principal;
  }

  const body = await readJsonCapped(req, INGEST_MAX_BODY_BYTES);
  if (body === 'too_large') return fail(413, 'ingest', 'body_too_large');
  if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events)) {
    return fail(400, 'ingest', 'events_required');
  }
  const rawEvents = (body as { events: unknown[] }).events;
  if (rawEvents.length > INGEST_MAX_BATCH) return fail(413, 'ingest', 'batch_too_large');

  // ── API-KEY path (service-to-service): an x-ingest-key header present (no JWT) ─
  if (ingestKey) {
    // Service-role client; the RPC resolves the workspace from the HASHED key.
    // Pre-filter/normalize on the edge (defense in depth). Its compact-JSON byte check can
    // pass a payload PostgreSQL later rejects after canonical jsonb rendering; the RPC is
    // authoritative and returns that rejection in dropped, which emits events_dropped below.
    // validateIngestEvent defaults a missing subject_type to 'user' (platform_event NOT NULL).
    const clean = rawEvents
      .map(validateIngestEvent)
      .filter((r): r is { ok: true; value: NormalizedEvent } => r.ok)
      .map((r) => r.value);
    const { data, error } = await admin!.rpc('ingest_platform_event', { api_key: ingestKey, events: clean });
    if (error) {
      // F7: branch on SQLSTATE (error.code), NEVER error.message. 28000=invalid key -> 401;
      // 54000=batch too large -> 413; anything else is an operational failure -> 500.
      if (error.code === '28000') return fail(401, 'ingest_key', 'invalid_ingest_key');
      if (error.code === '54000') return fail(413, 'ingest_key', 'batch_too_large');
      return fail(500, 'ingest_key', 'ingest_failed');
    }
    const result = data as { inserted: number; dropped: number; duplicate: number; conflict: number };
    // The RPC counts its own drops; add the edge pre-filter's drops so the caller sees the total.
    const preDropped = rawEvents.length - clean.length;
    const combined = {
      inserted: result.inserted,
      dropped: result.dropped + preDropped,
      duplicate: result.duplicate,
      conflict: result.conflict,
    };
    if (combined.dropped > 0) {
      emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_key', error_code: 'events_dropped', redaction_version: REDACTION_VERSION });
    }
    if (combined.conflict > 0) {
      emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_key', error_code: 'idempotency_conflicts', redaction_version: REDACTION_VERSION });
    }
    return json(200, combined); // { inserted, dropped, duplicate, conflict }
  }

  // ── JWT path (first-party): Authorization: Bearer <jwt> ─────────────────────
  const principal = jwtPrincipal;
  if (!principal?.ok) return fail(401, 'authenticate', 'principal_missing'); // fail-closed: never proceed anonymously
  // principal.db is an anon-key client carrying the caller's Bearer token → RLS applies.

  let dropped = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (const e of rawEvents) {
    const v = validateIngestEvent(e);
    if (!v.ok) { dropped++; continue; }
    // workspace_id is per-event or top-level; RLS `with check is_workspace_member` gates it.
    const wsId = (e as { workspace_id?: unknown }).workspace_id ?? (body as { workspace_id?: unknown }).workspace_id;
    if (typeof wsId !== 'string') { dropped++; continue; }
    rows.push({
      workspace_id: wsId,
      event_type: v.value.event_type,
      subject_type: v.value.subject_type, // always a string ('user' default) — platform_event NOT NULL
      subject_ref: v.value.subject_ref,
      actor_ref: v.value.actor_ref,
      source: 'external',
      properties: v.value.properties,
      occurred_at: v.value.occurred_at,
      ingested_at: new Date().toISOString(),
      // JWT ingestion is intentionally not deduplicated in v1; only API-key RPC ingest uses this key.
    });
  }
  if (rows.length === 0) {
    if (dropped > 0) emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_jwt', error_code: 'events_dropped', redaction_version: REDACTION_VERSION });
    return json(200, { inserted: 0, dropped });
  }
  // Atomic batch insert: a non-member workspace_id in ANY row makes RLS reject the
  // whole batch (42501) — fail LOUD (403), never a silent partial/anonymous success.
  const { error } = await principal.db.from('platform_event').insert(rows);
  if (error) {
    // F7: branch on SQLSTATE (error.code), NEVER error.message. 42501=RLS reject (non-member).
    return fail(error.code === '42501' ? 403 : 500, 'ingest_jwt',
      error.code === '42501' ? 'not_a_member' : 'ingest_failed');
  }
  if (dropped > 0) emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_jwt', error_code: 'events_dropped', redaction_version: REDACTION_VERSION });
  return json(200, { inserted: rows.length, dropped });
});
