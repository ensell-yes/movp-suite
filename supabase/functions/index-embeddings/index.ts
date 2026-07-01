import { createClient } from 'npm:@supabase/supabase-js@2'
import { GteSmallProvider } from '@movp/search/gte-small'
import { runEmbedWorker } from '@movp/flows'

const embedder = new GteSmallProvider()

Deno.serve(async (): Promise<Response> => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const result = await runEmbedWorker(db, embedder, 10)
  return Response.json(result)
})
