import { canonicalizeInnerJson, type EditorAdapter } from '@spike/fixture'

export type TipTapDoc = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const tipTapAdapter: EditorAdapter<TipTapDoc> = {
  decode(body) {
    if (body === '') return { type: 'doc', content: [] }
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed)) throw new Error('tiptap.decode: expected doc object')
    return parsed
  },
  encode(doc) {
    return canonicalizeInnerJson(doc)
  },
}
