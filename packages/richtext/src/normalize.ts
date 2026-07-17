import { canonicalizeInnerJson } from './canonical.ts'

export function isDocShape(v: unknown): v is { type: 'doc'; content: unknown[] } {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    (v as { type?: unknown }).type === 'doc' && Array.isArray((v as { content?: unknown }).content)
  )
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock', 'horizontalRule'])

/**
 * Plain text for search. Rule: adjacent inline text nodes concatenate with NO separator; each
 * block-level node is separated by exactly one space. (A naive `parts.join(' ')` would double-space
 * adjacent text like `['Hello ', 'world']` → `'Hello  world'`.) Never emits node/markup keys.
 */
export function docToPlainText(doc: unknown): string {
  let out = ''
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const n = node as { type?: unknown; text?: unknown; content?: unknown }
    if (n.type === 'text' && typeof n.text === 'string') { out += n.text; return }
    if (typeof n.type === 'string' && BLOCK_TYPES.has(n.type) && out !== '' && !out.endsWith(' ')) out += ' '
    if (Array.isArray(n.content)) for (const child of n.content) walk(child)
  }
  walk(doc)
  return out.trim()
}

const emptyDoc = () => canonicalizeInnerJson({ type: 'doc', content: [] })
const textParagraph = (text: string) =>
  canonicalizeInnerJson({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

/**
 * The authoritative richtext storage normalizer (spec §3.2). Output is a canonical doc-JSON string.
 * Legacy HTML is stored as literal text (not parsed) in v1 — see spec §3.4 / Deferred.
 */
export function normalizeToCanonicalDoc(value: unknown): string {
  if (typeof value !== 'string') throw new Error('richtext_value_not_a_string')
  if (value === '') return emptyDoc()
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return textParagraph(value)
  }
  if (isDocShape(parsed)) return canonicalizeInnerJson(parsed)
  return textParagraph(value)
}
