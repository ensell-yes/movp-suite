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
  const result = await runEmbedWorker(db, embedder, 10)
  return Response.json(result)
})
