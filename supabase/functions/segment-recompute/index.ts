import { createClient } from 'npm:@supabase/supabase-js@2' // matches flows/index.ts
import { drainSegmentRecompute } from '@movp/flows'          // matches flows-worker's @movp/flows import

Deno.serve(async (): Promise<Response> => {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return new Response('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', { status: 500 })
  const db = createClient(url, key, { auth: { persistSession: false } })
  const result = await drainSegmentRecompute(db, 20)
  return Response.json(result)
})
