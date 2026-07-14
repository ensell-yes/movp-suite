import { createClient } from 'npm:@supabase/supabase-js@2'
import { ResendAdapter } from '@movp/notifications'
import { runFlowsWorker } from '@movp/flows'
import { schema } from '@movp/core-schema'

Deno.serve(async (): Promise<Response> => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const notifier = new ResendAdapter(Deno.env.get('RESEND_API_KEY')!)
  const result = await runFlowsWorker(db, notifier, 10, { schema })
  return Response.json(result)
})
