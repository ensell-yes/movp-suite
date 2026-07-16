import { canonicalizeInnerJson, type EditorAdapter } from '@spike/fixture'

export type BlockNoteDoc = unknown[]

export const blockNoteAdapter: EditorAdapter<BlockNoteDoc> = {
  decode(body) {
    if (body === '') return []
    const parsed: unknown = JSON.parse(body)
    if (!Array.isArray(parsed)) throw new Error('blocknote.decode: expected block array')
    return parsed
  },
  encode(doc) {
    return canonicalizeInnerJson(doc)
  },
}
