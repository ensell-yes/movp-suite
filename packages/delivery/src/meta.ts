import {
  DeliveryArtifactError,
  type DeliveryArtifactErrorCode,
  type DeliveryRoute,
} from './types.ts'

export const MAX_JSON_LD_BYTES = 1024 * 1024
const MAX_JSON_LD_DEPTH = 64
const MAX_JSON_LD_NODES = 20_000
const TYPE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const encoder = new TextEncoder()

function fail(code: DeliveryArtifactErrorCode): never {
  throw new DeliveryArtifactError(code)
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function normalizeDeliveryOrigin(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2_048) {
    fail('delivery_origin_invalid')
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    fail('delivery_origin_invalid')
  }

  const secure = parsed.protocol === 'https:'
  const localHttp = parsed.protocol === 'http:' && isLocalHostname(parsed.hostname)
  if (
    (!secure && !localHttp)
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    fail('delivery_origin_invalid')
  }
  return parsed.origin
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

function validateRoute(route: DeliveryRoute): void {
  if (
    typeof route !== 'object'
    || route === null
    || Array.isArray(route)
    || typeof route.contentType !== 'string'
    || !TYPE_KEY_PATTERN.test(route.contentType)
    || encoder.encode(route.contentType).byteLength > 128
    || typeof route.slug !== 'string'
    || encoder.encode(route.slug).byteLength < 1
    || encoder.encode(route.slug).byteLength > 256
    || route.slug.includes('/')
    || route.slug.includes('\\')
    || CONTROL_PATTERN.test(route.slug)
  ) {
    fail('delivery_route_invalid')
  }
}

export function canonicalUrl(origin: string, route: DeliveryRoute): string {
  const normalizedOrigin = normalizeDeliveryOrigin(origin)
  validateRoute(route)
  return `${normalizedOrigin}/${encodePathSegment(route.contentType)}/${encodePathSegment(route.slug)}`
}

type JsonState = {
  ancestors: WeakSet<object>
  bytes: number
  nodes: number
}

function emitJson(token: string, state: JsonState): string {
  state.bytes += encoder.encode(token).byteLength
  if (state.bytes > MAX_JSON_LD_BYTES) fail('delivery_jsonld_too_large')
  return token
}

function serializeJsonString(value: string, state: JsonState): string {
  const serialized = JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
  return emitJson(serialized, state)
}

function serializeJson(value: unknown, state: JsonState, depth: number): string {
  if (depth > MAX_JSON_LD_DEPTH) fail('delivery_jsonld_invalid')
  state.nodes += 1
  if (state.nodes > MAX_JSON_LD_NODES) fail('delivery_jsonld_invalid')

  if (value === null) return emitJson('null', state)
  if (typeof value === 'string') return serializeJsonString(value, state)
  if (typeof value === 'boolean') return emitJson(value ? 'true' : 'false', state)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('delivery_jsonld_invalid')
    return emitJson(JSON.stringify(value), state)
  }
  if (typeof value !== 'object') fail('delivery_jsonld_invalid')
  if (state.ancestors.has(value)) fail('delivery_jsonld_invalid')

  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const output: string[] = [emitJson('[', state)]
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) fail('delivery_jsonld_invalid')
        if (index > 0) output.push(emitJson(',', state))
        output.push(serializeJson(value[index], state, depth + 1))
      }
      output.push(emitJson(']', state))
      return output.join('')
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      fail('delivery_jsonld_invalid')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('delivery_jsonld_invalid')
    }

    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(descriptors)
    const output: string[] = [emitJson('{', state)]
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      const descriptor = descriptors[key]
      if (
        !descriptor
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) {
        fail('delivery_jsonld_invalid')
      }
      if (index > 0) output.push(emitJson(',', state))
      output.push(serializeJsonString(key, state))
      output.push(emitJson(':', state))
      output.push(serializeJson(descriptor.value, state, depth + 1))
    }
    output.push(emitJson('}', state))
    return output.join('')
  } finally {
    state.ancestors.delete(value)
  }
}

export function generateJsonLd(input: unknown): string {
  return serializeJson(input, {
    ancestors: new WeakSet<object>(),
    bytes: 0,
    nodes: 0,
  }, 1)
}
