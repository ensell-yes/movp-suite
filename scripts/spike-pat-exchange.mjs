// C3a.1 fail-first spike: prove generateLink({type:'magiclink'}) -> verifyOtp mints a
// PostgREST-accepted, RLS-bound, USER-SCOPED session. Run against a live local stack:
//   eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
//   node scripts/spike-pat-exchange.mjs
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL ?? process.env.API_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY
// The verify type under test. Step 1 uses the tempting-but-unproven 'magiclink'; Step 2 pins 'email'.
const VERIFY_TYPE = 'email'

function die(msg) { console.error(`SPIKE RED: ${msg}`); process.exit(1) }
if (!url || !anonKey || !serviceKey) die('stack env missing (run: eval "$(supabase status -o env | sed ...)")')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

async function mintSession(email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) die(`generateLink failed: ${linkErr.message}`)
  const tokenHash = link?.properties?.hashed_token
  if (!tokenHash) die('generateLink returned no hashed_token')
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({ type: VERIFY_TYPE, token_hash: tokenHash })
  if (otpErr || !otp?.session?.access_token) {
    die(`verifyOtp(type=${VERIFY_TYPE}) returned no session${otpErr ? `: ${otpErr.message}` : ''} — the type is WRONG; pin type:'email' (magic_link.html uses &type=email)`)
  }
  return otp.session.access_token
}

function sessionClient(accessToken) {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  })
}

const stamp = Date.now()
const emailA = `spike-a-${stamp}@example.test`
const emailB = `spike-b-${stamp}@example.test`
for (const email of [emailA, emailB]) {
  const { error } = await admin.auth.admin.createUser({ email, email_confirm: true })
  if (error && !String(error.message).includes('already been registered')) die(`createUser failed: ${error.message}`)
}

// A: mint a real session, prove it is PostgREST-accepted + RLS-bound (creator becomes owner).
const tokenA = await mintSession(emailA)
const claimsA = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url').toString())
if (claimsA.aud !== 'authenticated' || !claimsA.sub) die(`minted token is not an authenticated session: aud=${claimsA.aud}`)
const clientA = sessionClient(tokenA)

const { data: ws, error: wsErr } = await clientA.rpc('create_workspace', { p_name: `Spike WS ${stamp}` })
if (wsErr || !ws?.id) die(`create_workspace via minted session failed: ${wsErr?.message ?? 'no row'}`)
const { data: note, error: noteErr } = await clientA.from('note').insert({ workspace_id: ws.id, title: 'spike-secret' }).select('id').single()
if (noteErr || !note?.id) die(`RLS insert via minted session failed: ${noteErr?.message ?? 'no row'}`)
const { data: ownRead } = await clientA.from('note').select('id').eq('id', note.id)
if (!ownRead || ownRead.length !== 1) die('owner cannot read its own note — session is not RLS-bound to the user')

// B: a DIFFERENT user's session cannot read A's private note (identity boundary).
const tokenB = await mintSession(emailB)
const { data: crossRead } = await sessionClient(tokenB).from('note').select('id').eq('id', note.id)
if (crossRead && crossRead.length !== 0) die('IDENTITY BOUNDARY BROKEN: user B read user A private note')

console.log('SPIKE GREEN: verifyOtp(type=' + VERIFY_TYPE + ') minted a PostgREST-accepted, RLS-bound, user-scoped session; identity boundary holds.')
