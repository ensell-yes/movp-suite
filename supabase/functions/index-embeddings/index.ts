import { createClient } from 'npm:@supabase/supabase-js@2'
import { GteSmallProvider } from '@movp/search/gte-small'
import { runEmbedWorker } from '@movp/flows'

const embedder = new GteSmallProvider()
let warmed = false

async function warmEmbedder(): Promise<void> {
  if (warmed) return
  await embedder.embed('warmup')
  warmed = true
}

Deno.serve(async (): Promise<Response> => {
  // Warm the local model before claiming jobs. A first-run model download can
  // exceed the request timeout; doing it before claim avoids stranding a real job
  // in `running` until its lease expires.
  await warmEmbedder()
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const configuredBatchSize = Number(Deno.env.get('MOVP_EMBED_BATCH_SIZE') ?? '10')
  const batchSize = Number.isInteger(configuredBatchSize) && configuredBatchSize >= 1 && configuredBatchSize <= 10
    ? configuredBatchSize
    : 10
  const result = await runEmbedWorker(db, embedder, batchSize)
  return Response.json(result)
})
