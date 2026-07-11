#!/usr/bin/env node
// Config-lint for the per-client MCP samples under docs/agents/mcp/.
// Asserts: (1) each sample points at the real streamable-HTTP endpoint path,
// (2) the bearer/auth shape is correct per client, (3) every documented
// tools/call example names a CURRENTLY-registered MCP tool, and (4) consumer
// docs and bridge runtime references remain aligned with the implementation.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENDPOINT_PATH = '/functions/v1/mcp'
const REVOCATION_WINDOW = 'already-minted sessions can remain valid for up to 1 hour'
const serverPath = join(root, 'packages', 'mcp', 'src', 'server.ts')
const mcpDir = join(root, 'docs', 'agents', 'mcp')

const errors = []
const fail = (msg) => errors.push(msg)
const includesNormalized = (text, expected) => text.replace(/\s+/g, ' ').includes(expected)

// --- 1. Registered MCP tool names (literal registrations only; the dynamic
//        `${c.name}.*` collection tools are intentionally excluded so docs must
//        reference a statically-guaranteed tool). ---
function registeredTools() {
  const src = readFileSync(serverPath, 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/registerTool\(\s*'([a-z][\w.]*)'/g)) names.add(m[1])
  return names
}

// --- 2. Per-client config sample descriptors ---
const samples = [
  { file: 'claude-code.json', kind: 'json', url: (c) => c.mcpServers?.movp?.url,     auth: (c) => c.mcpServers?.movp?.headers?.Authorization },
  { file: 'cursor.json',      kind: 'json', url: (c) => c.mcpServers?.movp?.url,     auth: (c) => c.mcpServers?.movp?.headers?.Authorization },
  { file: 'gemini-cli.json',  kind: 'json', url: (c) => c.mcpServers?.movp?.httpUrl, auth: (c) => c.mcpServers?.movp?.headers?.Authorization },
  { file: 'copilot.json',     kind: 'json', url: (c) => c.servers?.movp?.url,        auth: (c) => c.servers?.movp?.headers?.Authorization },
  { file: 'codex.toml',       kind: 'codex' },
]

// literal PAT prefix, or an env-expansion placeholder (${VAR} / ${input:x} / ${env:x} / $VAR)
const BEARER_RE = /^Bearer\s+(movp_pat_|\$\{|\$[A-Za-z])/

function checkUrl(file, url) {
  if (typeof url !== 'string' || url.length === 0) return fail(`${file}: missing MCP endpoint url`)
  let path
  try { path = new URL(url).pathname } catch { return fail(`${file}: url is not a valid absolute URL: ${url}`) }
  if (path !== MCP_ENDPOINT_PATH) fail(`${file}: endpoint path must be ${MCP_ENDPOINT_PATH}, got ${path}`)
}

for (const s of samples) {
  const p = join(mcpDir, s.file)
  if (!existsSync(p)) { fail(`missing config sample: docs/agents/mcp/${s.file}`); continue }
  const raw = readFileSync(p, 'utf8')
  if (s.kind === 'json') {
    let cfg
    try { cfg = JSON.parse(raw) } catch (e) { fail(`${s.file}: invalid JSON: ${e.message}`); continue }
    checkUrl(s.file, s.url(cfg))
    const auth = s.auth(cfg)
    if (typeof auth !== 'string' || !BEARER_RE.test(auth)) {
      fail(`${s.file}: headers.Authorization must be "Bearer movp_pat_…" or an env placeholder, got ${JSON.stringify(auth)}`)
    }
  } else {
    // Codex TOML: no built-in parser + no new dependency -> regex-extract the two fixed keys.
    checkUrl(s.file, raw.match(/^\s*url\s*=\s*"([^"]+)"/m)?.[1])
    if (!/^\s*bearer_token_env_var\s*=\s*"[^"]+"/m.test(raw)) {
      fail(`${s.file}: Codex HTTP MCP auth requires bearer_token_env_var = "<ENV VAR NAME>" (rmcp sends its value as the Bearer token)`)
    }
    if (!/^\s*experimental_use_rmcp_client\s*=\s*true/m.test(raw)) {
      fail(`${s.file}: Codex streamable-HTTP MCP requires experimental_use_rmcp_client = true`)
    }
  }
}

// --- 3. Every documented tools/call example must name a registered tool ---
const tools = registeredTools()
function walk(dir, extensions = new Set(['.md', '.txt'])) {
  if (!existsSync(dir)) return []
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(fp, extensions))
    else if (extensions.has(extname(e.name))) out.push(fp)
  }
  return out
}
const docFiles = walk(join(root, 'docs', 'agents'))
const rootLlms = join(root, 'llms.txt')
if (existsSync(rootLlms)) docFiles.push(rootLlms)
const FENCE = /```json\s*([\s\S]*?)```/g
for (const file of docFiles) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(FENCE)) {
    let frame
    try { frame = JSON.parse(m[1]) } catch { continue } // non-JSON-RPC blocks (e.g. configs) are skipped
    if (frame?.method !== 'tools/call') continue
    const name = frame?.params?.name
    if (typeof name !== 'string') { fail(`${file}: a tools/call example is missing params.name`); continue }
    if (!tools.has(name)) fail(`${file}: tools/call references unregistered tool "${name}" (drifted from packages/mcp/src/server.ts)`)
  }
}

// --- 4. Agent-docs facts: stable error codes, llms.txt index, consumer template ---
const STABLE_CODES = ['missing_token', 'invalid_token', 'expired_token', 'invalid_claims']
const errCodesDoc = join(root, 'docs', 'agents', 'error-codes.md')
if (!existsSync(errCodesDoc)) fail('missing docs/agents/error-codes.md')
else {
  const t = readFileSync(errCodesDoc, 'utf8')
  for (const c of STABLE_CODES) if (!t.includes(`| \`${c}\` |`)) fail(`error-codes.md missing stable code: ${c}`)
  if (!includesNormalized(t, REVOCATION_WINDOW)) fail('error-codes.md must document the PAT revocation residual window')
}
const llms = join(root, 'llms.txt')
if (!existsSync(llms)) fail('missing repo-root llms.txt')
else {
  const t = readFileSync(llms, 'utf8')
  if (!t.startsWith('# MOVP — agent connectivity\n\n>')) fail('llms.txt must start with its agent-connectivity H1 and summary blockquote')
  if (!t.includes(MCP_ENDPOINT_PATH)) fail(`llms.txt must reference the MCP endpoint path ${MCP_ENDPOINT_PATH}`)
  for (const f of ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot']) {
    if (!t.includes(`agents/mcp/${f}`)) fail(`llms.txt must link to docs/agents/mcp/${f}`)
  }
}
const agentsTemplate = join(root, 'docs', 'agents', 'AGENTS.template.md')
if (!existsSync(agentsTemplate)) fail('missing docs/agents/AGENTS.template.md (consumer template)')
else {
  const t = readFileSync(agentsTemplate, 'utf8')
  if (!t.startsWith('<!-- MOVP consumer AGENTS.md template.')) fail('AGENTS.template.md must start with the consumer-template marker')
  if (!includesNormalized(t, REVOCATION_WINDOW)) fail('AGENTS.template.md must document the PAT revocation residual window')
}
const stdioDoc = join(mcpDir, 'stdio-bridge.md')
if (!existsSync(stdioDoc)) fail('missing docs/agents/mcp/stdio-bridge.md')
else {
  const t = readFileSync(stdioDoc, 'utf8')
  if (!t.includes('@movp/mcp-bridge')) fail('stdio-bridge.md must document @movp/mcp-bridge')
  if (/npx\s+(?:-y\s+)?mcp-remote/.test(t)) fail('stdio-bridge.md must not recommend the rejected mcp-remote path')
}
if (!existsSync(join(root, 'packages', 'mcp-bridge', 'src', 'index.ts'))) fail('missing @movp/mcp-bridge implementation')

const scriptFiles = walk(join(root, 'scripts'), new Set(['.js', '.mjs', '.ts', '.sh']))
for (const file of scriptFiles) {
  if (file.endsWith('check-agent-configs.mjs')) continue
  const t = readFileSync(file, 'utf8')
  if (/mcp-remote (?:emits|exited)|from mcp-remote/.test(t)) {
    fail(`${file}: stale mcp-remote runtime diagnostic; use @movp/mcp-bridge`)
  }
  if (/spawn\([\s\S]{0,400}mcp-remote@|const\s+args\s*=\s*\[[\s\S]{0,400}mcp-remote@/.test(t)) {
    fail(`${file}: executable mcp-remote path is rejected; use @movp/mcp-bridge`)
  }
}

const c3PlansDir = join(root, 'docs', 'superpowers', 'plans')
const c3cPlan = join(c3PlansDir, '2026-07-09-movp-stage-c-03c-mcp-matrix-docs.md')
if (!existsSync(c3cPlan)) fail('missing executed C3c plan')
else if (!readFileSync(c3cPlan, 'utf8').includes('**EXECUTION DEVIATION (2026-07-10):**')) {
  fail('C3c plan must preserve the mcp-remote execution-deviation banner')
}

const c3dPlan = join(c3PlansDir, '2026-07-09-movp-stage-c-03d-agents-slice.md')
if (!existsSync(c3dPlan)) fail('missing executed C3d plan')
else if (!readFileSync(c3dPlan, 'utf8').includes('**EXECUTION DEVIATION (2026-07-10):**')) {
  fail('C3d plan must preserve the mcp-remote execution-deviation banner')
}

const cliProgram = readFileSync(join(root, 'packages', 'cli', 'src', 'program.ts'), 'utf8')
if (/\.option\(['"]--token\b/.test(cliProgram)) {
  fail('movp login must read PATs from stdin; --token would expose the secret in argv')
}

if (errors.length) {
  console.error('agent-config lint: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('agent-config lint: ok')
