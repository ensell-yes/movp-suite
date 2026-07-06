import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmbeddingProvider } from '@movp/domain'

export interface GraphQLContext {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
  accessToken?: string
  assetsFnUrl?: string
}

export type Row = { id: string; workspace_id: string; created_at: string; updated_at: string } & Record<
  string,
  unknown
>
