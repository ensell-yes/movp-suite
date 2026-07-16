export interface EditorAdapter<Doc> {
  decode(body: string): Doc
  encode(doc: Doc): string
}
export const INNER_CANONICAL_VERSION = 1
