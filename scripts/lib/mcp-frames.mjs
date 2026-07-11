// Shared helpers for the MCP HTTP + stdio smokes. Dependency-free (global fetch).
export function assert(cond, msg) { if (!cond) throw new Error(msg) }

export function env(name, fallback) {
  const v = process.env[name] ?? fallback
  if (!v) {
    console.error(`missing env ${name} (run: eval "$(supabase status -o env | sed 's/^\\([A-Z_]*\\)=/export \\1=/')")`)
    process.exit(1)
  }
  return v
}

// Streamable HTTP returns a raw JSON body OR an SSE stream (event: message /
// data: {…}); the MOVP bridge emits newline-delimited JSON over stdio. Normalise all.
export function parseRpc(body) {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
    return JSON.parse(lines[lines.length - 1])
  }
  const dataLines = trimmed.split('\n').filter((l) => l.startsWith('data:'))
  if (dataLines.length === 0) throw new Error(`no JSON-RPC payload in response (prefix: ${trimmed.slice(0, 60)})`)
  return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim())
}

async function restJson(apiUrl, path, anonKey, { token, body, method = 'POST' }) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', apikey: anonKey, Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 160)}`)
  return text.length ? JSON.parse(text) : null
}

// Seed a real user -> session -> workspace -> PAT against the local stack, using
// the C3a lifecycle RPCs over PostgREST. Returns { token: 'movp_pat_…', workspaceId }.
export async function seedPat({ apiUrl, anonKey, serviceRoleKey }) {
  const email = `mcp-smoke-${Date.now()}@example.test`
  const password = 'MovpSmoke123!'
  await restJson(apiUrl, '/auth/v1/admin/users', anonKey, { token: serviceRoleKey, body: { email, password, email_confirm: true } })
  const session = await restJson(apiUrl, '/auth/v1/token?grant_type=password', anonKey, { token: anonKey, body: { email, password } })
  assert(session?.access_token, 'password grant returned no access_token')
  // create_workspace's SQL param is `p_name` (migration 20260708000002); PostgREST binds RPC
  // args by parameter name, so the body key MUST be `p_name`, not `name`, or resolution 404s.
  const ws = await restJson(apiUrl, '/rest/v1/rpc/create_workspace', anonKey, { token: session.access_token, body: { p_name: 'MCP Smoke WS' } })
  assert(ws?.id, 'create_workspace returned no id')
  const pat = await restJson(apiUrl, '/rest/v1/rpc/create_personal_access_token', anonKey, { token: session.access_token, body: { default_ws: ws.id, name: 'mcp-smoke', ttl_days: 1 } })
  assert(typeof pat?.token === 'string' && pat.token.startsWith('movp_pat_'), 'create_personal_access_token did not return a movp_pat_ token')
  return { token: pat.token, workspaceId: ws.id }
}
