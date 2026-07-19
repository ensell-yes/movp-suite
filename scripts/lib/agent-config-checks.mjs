// Pure, load-bearing credential-hygiene predicates for the MCP agent-config
// samples and docs. Extracted so scripts/test/check-agent-configs.test.mjs can
// exercise them directly with positive + negative cases; check-agent-configs.mjs
// imports and applies them so the production path and the tests share one rule.

// A literal MOVP PAT must never appear in an `export MOVP_PAT=movp_pat_…` line;
// docs load it from a credential store instead.
export const PAT_LITERAL_EXPORT = /^\s*export\s+MOVP_PAT\s*=\s*movp_pat_/m
export const docHasLiteralPatExport = (src) => PAT_LITERAL_EXPORT.test(src)

// Codex has native streamable HTTP; the retired experimental_use_rmcp_client
// setting is rejected under --strict-config and must not appear (any value form).
export const RETIRED_RMCP = /^\s*experimental_use_rmcp_client\s*=/m
export const codexTomlHasRetiredRmcp = (raw) => RETIRED_RMCP.test(raw)

// Codex HTTP MCP auth is the NAME of an env var whose value Codex sends as the
// Bearer token; the sample must declare a non-empty bearer_token_env_var.
export const BEARER_ENV_VAR = /^\s*bearer_token_env_var\s*=\s*"[^"]+"/m
export const codexTomlHasBearerEnvVar = (raw) => BEARER_ENV_VAR.test(raw)

// A committed sample Authorization header must be an env-expansion placeholder
// — ${VAR} (incl. ${env:VAR} / ${input:x}) or $VAR — never a literal movp_pat_
// token (all supported clients: Claude Code, Cursor, Gemini, Copilot expand one).
export const BEARER_PLACEHOLDER_RE = /^Bearer\s+(\$\{|\$[A-Za-z])/
export const authIsSecurePlaceholder = (auth) => typeof auth === 'string' && BEARER_PLACEHOLDER_RE.test(auth)
