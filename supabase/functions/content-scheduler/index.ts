import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (): Promise<Response> => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const { data: claimed, error } = await supabase.rpc('claim_due_schedules', { lim: 50 })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  let published = 0
  let failed = 0
  for (const row of (claimed ?? []) as Array<{ id: string }>) {
    const { error: runErr } = await supabase.rpc('run_scheduled_publish', { schedule_id: row.id })
    if (runErr) {
      await supabase.from('content_schedule').update({ state: 'failed' }).eq('id', row.id)
      failed++
    } else {
      published++
    }
  }

  return Response.json({ claimed: claimed?.length ?? 0, published, failed })
})
