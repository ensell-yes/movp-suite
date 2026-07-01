export function chunkText(text: string, opts: { tokens?: number; overlapPct?: number } = {}): string[] {
  const maxTokens = opts.tokens ?? 400
  const overlap = Math.floor((maxTokens * (opts.overlapPct ?? 15)) / 100)
  const clean = text.trim()
  if (!clean) return []

  const sentences = clean.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let cur: string[] = []

  const flush = () => {
    if (cur.length) chunks.push(cur.join(' '))
  }

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean)
    if (words.length > maxTokens) {
      for (let i = 0; i < words.length; i += Math.max(1, maxTokens - overlap)) {
        const slice = words.slice(i, i + maxTokens)
        if (cur.length) {
          flush()
          cur = []
        }
        chunks.push(slice.join(' '))
      }
      continue
    }
    if (cur.length > 0 && cur.length + words.length > maxTokens) {
      flush()
      cur = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) : []
    }
    cur.push(...words)
  }
  flush()
  return chunks
}
