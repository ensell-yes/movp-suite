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

// A sample Authorization header must be a literal movp_pat_ prefix or an
// env-expansion placeholder (${VAR} / $VAR) — never a hardcoded arbitrary secret.
export const BEARER_RE = /^Bearer\s+(movp_pat_|\$\{|\$[A-Za-z])/
export const authIsValidBearer = (auth) => typeof auth === 'string' && BEARER_RE.test(auth)
