import type { EmbeddingProvider } from '@movp/domain'

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(text: string, opts: { mean_pool: boolean; normalize: boolean }): Promise<number[]>
    }
  }
}

export class GteSmallProvider implements EmbeddingProvider {
  #session: { run(text: string, opts: { mean_pool: boolean; normalize: boolean }): Promise<number[]> } | null = null

  async embed(text: string): Promise<number[]> {
    this.#session ??= new Supabase.ai.Session('gte-small')
    return await this.#session.run(text, { mean_pool: true, normalize: true })
  }
}
