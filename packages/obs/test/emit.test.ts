import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emit, REDACTION_VERSION, type ObsEvent } from '../src/index.ts'

function baseEvent(over: Partial<ObsEvent> = {}): ObsEvent {
  return {
    trace_id: 'trace-1',
    request_id: 'req-1',
    surface: 'graphql',
    operation: 'note.create',
    error_code: 'ok',
    redaction_version: REDACTION_VERSION,
    ...over,
  }
}

describe('emit', () => {
  let logs: string[]
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logs = []
    spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
  })

  afterEach(() => spy.mockRestore())

  it('emits exactly one structured JSON line for a valid event', () => {
    emit(baseEvent({ workspace_id_hash: 'ws-hash', actor_id: 'u1' }))
    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.surface).toBe('graphql')
    expect(parsed.operation).toBe('note.create')
    expect(parsed.error_code).toBe('ok')
    expect(parsed.redaction_version).toBe(1)
  })

  it('coerces an out-of-enum surface to unknown and emits a violation event', () => {
    emit(baseEvent({ surface: 'webhook' as unknown as ObsEvent['surface'] }))
    expect(logs).toHaveLength(2)
    const first = JSON.parse(logs[0]!)
    const second = JSON.parse(logs[1]!)
    expect(first.surface).toBe('unknown')
    expect(second.surface).toBe('unknown')
    expect(second.error_code).toBe('observability_enum_violation')
  })

  it('strips any string field containing @', () => {
    emit(baseEvent({ actor_email_hash: 'leaked@example.com' }))
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('@')
    expect(JSON.parse(logs[0]!).actor_email_hash).toBeUndefined()
  })

  it('forces redaction_version to the constant regardless of input', () => {
    emit(baseEvent({ redaction_version: 99 }))
    expect(JSON.parse(logs[0]!).redaction_version).toBe(1)
  })

  it('drops undefined optional fields', () => {
    emit(baseEvent())
    const parsed = JSON.parse(logs[0]!)
    expect('latency_ms' in parsed).toBe(false)
    expect('collection' in parsed).toBe(false)
  })
})
