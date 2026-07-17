import { canonicalizeInnerJson } from './canonical.ts'

export interface EditorAdapter<Doc> {
  /** stored richtext string -> editor document */
  decode(body: string): Doc
  /** editor document -> stored richtext string, via the §5.2 canonical algorithm */
  encode(doc: Doc): string
}

/** Bump if the §5.2 canonical algorithm changes. */
export const INNER_CANONICAL_VERSION = 1

export type TipTapDoc = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Top-level ProseMirror doc shape only. Deeper node validation is intentionally out of scope. */
function isDocShape(value: unknown): value is TipTapDoc {
  return isRecord(value) && value.type === 'doc' && Array.isArray(value.content)
}

export const tipTapAdapter: EditorAdapter<TipTapDoc> = {
  decode(body) {
    if (body === '') return { type: 'doc', content: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // Stable code; never echo the untrusted source into diagnostics.
      throw new Error('tiptap.decode: invalid_richtext_document')
    }
    if (!isDocShape(parsed)) throw new Error('tiptap.decode: invalid_richtext_document')
    return parsed
  },
  encode(doc) {
    return canonicalizeInnerJson(doc)
  },
}
