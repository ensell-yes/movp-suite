import type { EmbeddingProvider } from '@movp/domain'

export class FakeEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(384).fill(0)
    for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
}
