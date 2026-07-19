// Regression tests for the credential-hygiene predicates enforced by
// scripts/check-agent-configs.mjs. These pin the load-bearing rules:
//   - no literal MOVP PAT in an `export MOVP_PAT=movp_pat_…` line
//   - Codex TOML must not carry the retired experimental_use_rmcp_client key
//   - Codex TOML must name a bearer_token_env_var
//   - a sample Authorization header must be a placeholder or movp_pat_ prefix,
//     never a hardcoded arbitrary secret
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  docHasLiteralPatExport,
  codexTomlHasRetiredRmcp,
  codexTomlHasBearerEnvVar,
  authIsSecurePlaceholder,
} from '../lib/agent-config-checks.mjs'

test('docHasLiteralPatExport flags a literal PAT export, allows secure injection', () => {
  assert.equal(docHasLiteralPatExport('export MOVP_PAT=movp_pat_ABC123'), true)
  assert.equal(docHasLiteralPatExport('  export MOVP_PAT=movp_pat_deadbeef\n'), true)
  assert.equal(docHasLiteralPatExport(': "${MOVP_PAT:?load it from your credential store}"'), false)
  assert.equal(docHasLiteralPatExport('export MOVP_MCP_URL=https://x/functions/v1/mcp'), false)
})

test('codexTomlHasRetiredRmcp flags the retired rmcp key in any value form', () => {
  assert.equal(codexTomlHasRetiredRmcp('experimental_use_rmcp_client = true'), true)
  assert.equal(codexTomlHasRetiredRmcp('  experimental_use_rmcp_client=false'), true)
  assert.equal(codexTomlHasRetiredRmcp('[mcp_servers.movp]\nurl = "https://x"'), false)
})

test('codexTomlHasBearerEnvVar requires a non-empty env-var name', () => {
  assert.equal(codexTomlHasBearerEnvVar('bearer_token_env_var = "MOVP_PAT"'), true)
  assert.equal(codexTomlHasBearerEnvVar('bearer_token_env_var = ""'), false)
  assert.equal(codexTomlHasBearerEnvVar('url = "https://x"'), false)
})

test('authIsSecurePlaceholder accepts env placeholders, rejects literal PAT and hardcoded/absent', () => {
  assert.equal(authIsSecurePlaceholder('Bearer ${MOVP_PAT}'), true)       // Claude Code / Gemini
  assert.equal(authIsSecurePlaceholder('Bearer ${env:MOVP_PAT}'), true)   // Cursor
  assert.equal(authIsSecurePlaceholder('Bearer ${input:movpPat}'), true)  // Copilot
  assert.equal(authIsSecurePlaceholder('Bearer $MOVP_PAT'), true)
  assert.equal(authIsSecurePlaceholder('Bearer movp_pat_REPLACE_WITH_YOUR_TOKEN'), false) // a committed literal PAT
  assert.equal(authIsSecurePlaceholder('Bearer movp_pat_ABC'), false)
  assert.equal(authIsSecurePlaceholder('Bearer hardcoded-secret'), false)
  assert.equal(authIsSecurePlaceholder(undefined), false)
  assert.equal(authIsSecurePlaceholder(''), false)
})
