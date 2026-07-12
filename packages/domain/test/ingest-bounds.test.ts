import { describe, it, expect } from 'vitest';
import {
  validateIngestEvent, INGEST_MAX_PROP_BYTES,
} from '../src/ingest-bounds';

describe('validateIngestEvent (require shape; measure serialized bytes)', () => {
  it('accepts a well-formed event and normalizes to known fields only', () => {
    const r = validateIngestEvent({
      event_type: 'signup', subject_type: 'user', subject_ref: 'u1',
      actor_ref: 'a1', occurred_at: '2026-07-01T00:00:00Z',
      properties: { plan: 'pro' }, workspace_id: 'ignored-here', junk: 42,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        event_type: 'signup', subject_type: 'user', subject_ref: 'u1',
        actor_ref: 'a1', properties: { plan: 'pro' }, occurred_at: '2026-07-01T00:00:00Z',
      });
      // unknown/extra fields (workspace_id, junk) are dropped by normalization
      expect(Object.keys(r.value)).not.toContain('workspace_id');
      expect(Object.keys(r.value)).not.toContain('junk');
    }
  });
  it('defaults a missing subject_type to "user" (platform_event.subject_type is NOT NULL)', () => {
    const r = validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.subject_type).toBe('user');
  });
  it('preserves a bounded string idempotency_key for API-key ingestion', () => {
    const r = validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z', idempotency_key: 'retry-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.idempotency_key).toBe('retry-1');
  });
  it('rejects a missing subject_ref as malformed', () => {
    expect(validateIngestEvent({ event_type: 'x', occurred_at: '2026-07-01T00:00:00Z' }))
      .toEqual({ ok: false, error: 'malformed' });
  });
  it('rejects a bad occurred_at as malformed', () => {
    expect(validateIngestEvent({ event_type: 'x', subject_ref: 's', occurred_at: 'not-a-date' }))
      .toEqual({ ok: false, error: 'malformed' });
  });
  it('rejects oversized properties by SERIALIZED byte length', () => {
    const big = { blob: 'x'.repeat(INGEST_MAX_PROP_BYTES) }; // JSON.stringify > cap
    expect(validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z', properties: big,
    })).toEqual({ ok: false, error: 'oversized' });
  });
  it('accepts properties at the compact JSON byte limit', () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ blob: '' })).length;
    const properties = { blob: 'x'.repeat(INGEST_MAX_PROP_BYTES - overhead) };
    expect(new TextEncoder().encode(JSON.stringify(properties))).toHaveLength(INGEST_MAX_PROP_BYTES);
    expect(validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z', properties,
    }).ok).toBe(true);
  });
  it('rejects properties one byte above the compact JSON byte limit', () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ blob: '' })).length;
    const properties = { blob: 'x'.repeat(INGEST_MAX_PROP_BYTES - overhead + 1) };
    expect(new TextEncoder().encode(JSON.stringify(properties))).toHaveLength(INGEST_MAX_PROP_BYTES + 1);
    expect(validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z', properties,
    })).toEqual({ ok: false, error: 'oversized' });
  });
});
