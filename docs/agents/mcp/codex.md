# Codex — MOVP MCP (streamable HTTP)

## Option A — CLI

Load `MOVP_PAT` from Keychain, a password manager, or another secure environment injector without
typing its value into a command or shell history. The examples assume it is already set.

```sh
: "${MOVP_PAT:?MOVP_PAT is not set; load it from your credential store}"
codex mcp add movp \
  --url https://your-project-ref.supabase.co/functions/v1/mcp \
  --bearer-token-env-var MOVP_PAT
codex mcp get movp
```

The command stores only the environment-variable name, never the PAT value.

## Option B — `config.toml`

```sh
: "${MOVP_PAT:?MOVP_PAT is not set; load it from your credential store}"
codex   # picks up ~/.codex/config.toml
```

Copy `codex.toml` in this directory into `~/.codex/config.toml` (or a trusted-project
`.codex/config.toml`). Endpoint: `${apiUrl}/functions/v1/mcp`.

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
Codex reads MCP config from `~/.codex/config.toml` and from `.codex/config.toml` in trusted projects.
Streamable-HTTP servers authenticate via `bearer_token_env_var` — the **name** of an environment
variable whose value Codex sends as the Bearer token. Do not add the retired
`experimental_use_rmcp_client` setting; current Codex rejects it under `--strict-config`.
