import {
  DeliveryRenderError,
  type DeliveryRenderErrorCode,
  type RenderOptions,
} from './types.ts'

export const DELIVERY_NODE_TYPES = [
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
  'text',
] as const

export const DELIVERY_MARK_TYPES = ['bold', 'italic', 'strike', 'code'] as const

export const DELIVERY_MAX_DEPTH = 64
export const DELIVERY_MAX_NODES = 20_000
export const DELIVERY_MAX_TEXT_BYTES = 1024 * 1024

type DeliveryNodeType = (typeof DELIVERY_NODE_TYPES)[number]
type DeliveryMarkType = (typeof DELIVERY_MARK_TYPES)[number]
type JsonRecord = Record<string, unknown>

const NODE_TYPES = new Set<string>(DELIVERY_NODE_TYPES)
const MARK_TYPES = new Set<string>(DELIVERY_MARK_TYPES)
const BLOCK_TYPES = new Set<DeliveryNodeType>([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
])
const INLINE_TYPES = new Set<DeliveryNodeType>(['text', 'hardBreak'])
const LANGUAGE_PATTERN = /^[A-Za-z0-9_+-]{1,32}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/

function fail(code: DeliveryRenderErrorCode): never {
  throw new DeliveryRenderError(code)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKeys(record: JsonRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed)
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    fail('delivery_render_invalid_document')
  }
}

function contentOf(node: JsonRecord, required: boolean): readonly unknown[] {
  if (node.content === undefined && !required) return []
  if (!Array.isArray(node.content)) fail('delivery_render_invalid_document')
  return node.content
}

function attrsOf(node: JsonRecord): JsonRecord | undefined {
  if (node.attrs === undefined) return undefined
  if (!isRecord(node.attrs)) fail('delivery_render_unknown_attribute')
  return node.attrs
}

function rejectAttrs(node: JsonRecord): void {
  const attrs = attrsOf(node)
  if (attrs && Object.keys(attrs).length > 0) {
    fail('delivery_render_unknown_attribute')
  }
}

function parseHeadingLevel(node: JsonRecord): number {
  const attrs = attrsOf(node)
  if (!attrs || Object.keys(attrs).length !== 1 || !('level' in attrs)) {
    fail('delivery_render_unknown_attribute')
  }
  const level = attrs.level
  if (!Number.isInteger(level) || typeof level !== 'number' || level < 1 || level > 6) {
    fail('delivery_render_unknown_attribute')
  }
  return level
}

function parseOrderedListStart(node: JsonRecord): number {
  const attrs = attrsOf(node)
  if (!attrs || Object.keys(attrs).length === 0) return 1
  if (Object.keys(attrs).length !== 1 || !('start' in attrs)) {
    fail('delivery_render_unknown_attribute')
  }
  const start = attrs.start
  if (
    typeof start !== 'number'
    || !Number.isSafeInteger(start)
    || start < 1
  ) {
    fail('delivery_render_unknown_attribute')
  }
  return start
}

function validateCodeBlockLanguage(node: JsonRecord): void {
  const attrs = attrsOf(node)
  if (!attrs || Object.keys(attrs).length === 0) return
  if (Object.keys(attrs).length !== 1 || !('language' in attrs)) {
    fail('delivery_render_unknown_attribute')
  }
  const language = attrs.language
  if (language !== null && (typeof language !== 'string' || !LANGUAGE_PATTERN.test(language))) {
    fail('delivery_render_unknown_attribute')
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseMarks(value: unknown): readonly DeliveryMarkType[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('delivery_render_invalid_document')

  const found = new Set<DeliveryMarkType>()
  for (const mark of value) {
    if (!isRecord(mark)) fail('delivery_render_invalid_document')
    if (typeof mark.type !== 'string' || !MARK_TYPES.has(mark.type)) {
      fail('delivery_render_unknown_mark')
    }
    if (Object.keys(mark).some((key) => key !== 'type')) {
      fail('delivery_render_unknown_attribute')
    }
    const markType = mark.type as DeliveryMarkType
    if (found.has(markType)) fail('delivery_render_invalid_document')
    found.add(markType)
  }
  return DELIVERY_MARK_TYPES.filter((mark) => found.has(mark))
}

function applyMarks(text: string, marks: readonly DeliveryMarkType[]): string {
  let output = text
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    switch (marks[index]) {
      case 'bold':
        output = `<strong>${output}</strong>`
        break
      case 'italic':
        output = `<em>${output}</em>`
        break
      case 'strike':
        output = `<s>${output}</s>`
        break
      case 'code':
        output = `<code>${output}</code>`
        break
    }
  }
  return output
}

type RenderState = {
  nodeCount: number
  textBytes: number
}

function parseNodeType(value: unknown): DeliveryNodeType {
  if (!isRecord(value) || typeof value.type !== 'string') {
    fail('delivery_render_invalid_document')
  }
  if (!NODE_TYPES.has(value.type)) fail('delivery_render_unknown_node')
  return value.type as DeliveryNodeType
}

function assertChildTypes(
  children: readonly unknown[],
  allowed: ReadonlySet<DeliveryNodeType>,
): void {
  for (const child of children) {
    if (!allowed.has(parseNodeType(child))) {
      fail('delivery_render_invalid_nesting')
    }
  }
}

function renderNode(
  input: unknown,
  depth: number,
  state: RenderState,
): string {
  if (depth > DELIVERY_MAX_DEPTH) fail('delivery_render_depth_exceeded')
  state.nodeCount += 1
  if (state.nodeCount > DELIVERY_MAX_NODES) {
    fail('delivery_render_node_limit_exceeded')
  }

  if (!isRecord(input)) fail('delivery_render_invalid_document')
  const nodeType = parseNodeType(input)

  switch (nodeType) {
    case 'doc': {
      assertKeys(input, ['type', 'content'])
      rejectAttrs(input)
      const children = contentOf(input, true)
      assertChildTypes(children, BLOCK_TYPES)
      return children.map((child) => renderNode(child, depth + 1, state)).join('')
    }

    case 'paragraph': {
      assertKeys(input, ['type', 'attrs', 'content'])
      rejectAttrs(input)
      const children = contentOf(input, false)
      assertChildTypes(children, INLINE_TYPES)
      return `<p>${children.map((child) => renderNode(child, depth + 1, state)).join('')}</p>`
    }

    case 'heading': {
      assertKeys(input, ['type', 'attrs', 'content'])
      const level = parseHeadingLevel(input)
      const children = contentOf(input, false)
      assertChildTypes(children, INLINE_TYPES)
      return `<h${level}>${children.map((child) => renderNode(child, depth + 1, state)).join('')}</h${level}>`
    }

    case 'bulletList':
    case 'orderedList': {
      assertKeys(input, ['type', 'attrs', 'content'])
      const start = nodeType === 'orderedList' ? parseOrderedListStart(input) : 1
      if (nodeType === 'bulletList') rejectAttrs(input)
      const children = contentOf(input, true)
      if (children.length === 0) fail('delivery_render_invalid_nesting')
      assertChildTypes(children, new Set<DeliveryNodeType>(['listItem']))
      const inner = children.map((child) => renderNode(child, depth + 1, state)).join('')
      if (nodeType === 'bulletList') return `<ul>${inner}</ul>`
      return start === 1 ? `<ol>${inner}</ol>` : `<ol start="${start}">${inner}</ol>`
    }

    case 'listItem': {
      assertKeys(input, ['type', 'attrs', 'content'])
      rejectAttrs(input)
      const children = contentOf(input, true)
      if (children.length === 0 || parseNodeType(children[0]) !== 'paragraph') {
        fail('delivery_render_invalid_nesting')
      }
      assertChildTypes(children, BLOCK_TYPES)
      return `<li>${children.map((child) => renderNode(child, depth + 1, state)).join('')}</li>`
    }

    case 'blockquote': {
      assertKeys(input, ['type', 'attrs', 'content'])
      rejectAttrs(input)
      const children = contentOf(input, true)
      if (children.length === 0) fail('delivery_render_invalid_nesting')
      assertChildTypes(children, BLOCK_TYPES)
      return `<blockquote>${children.map((child) => renderNode(child, depth + 1, state)).join('')}</blockquote>`
    }

    case 'codeBlock': {
      assertKeys(input, ['type', 'attrs', 'content'])
      validateCodeBlockLanguage(input)
      const children = contentOf(input, false)
      assertChildTypes(children, new Set<DeliveryNodeType>(['text']))
      for (const child of children) {
        if (isRecord(child) && child.marks !== undefined) {
          fail('delivery_render_invalid_nesting')
        }
      }
      return `<pre><code>${children.map((child) => renderNode(child, depth + 1, state)).join('')}</code></pre>`
    }

    case 'hardBreak':
      assertKeys(input, ['type', 'attrs'])
      rejectAttrs(input)
      return '<br>'

    case 'horizontalRule':
      assertKeys(input, ['type', 'attrs'])
      rejectAttrs(input)
      return '<hr>'

    case 'text': {
      assertKeys(input, ['type', 'text', 'marks'])
      if (typeof input.text !== 'string') fail('delivery_render_invalid_document')
      const bytes = new TextEncoder().encode(input.text).byteLength
      state.textBytes += bytes
      if (state.textBytes > DELIVERY_MAX_TEXT_BYTES) {
        fail('delivery_render_text_limit_exceeded')
      }
      const marks = parseMarks(input.marks)
      return applyMarks(escapeHtml(input.text), marks)
    }
  }
}

function renderBinding(html: string, options: RenderOptions | undefined): string {
  if (!options?.bind) return html
  const { itemId, fieldKey } = options.bind
  if (!UUID_PATTERN.test(itemId) || !FIELD_KEY_PATTERN.test(fieldKey)) {
    fail('delivery_render_binding_invalid')
  }
  return `<div data-movp-item="${escapeHtml(itemId)}" data-movp-field="${escapeHtml(fieldKey)}">${html}</div>`
}

export function renderDocToHtml(doc: unknown, options?: RenderOptions): string {
  if (parseNodeType(doc) !== 'doc') {
    fail('delivery_render_invalid_nesting')
  }
  const state: RenderState = { nodeCount: 0, textBytes: 0 }
  const html = renderNode(doc, 1, state)
  return renderBinding(html, options)
}
