# stdio bridge - MOVP MCP via `@movp/mcp-bridge`

MOVP's MCP endpoint is streamable HTTP. A stdio-only client reaches it through the narrow
`@movp/mcp-bridge` workspace package.

## Why not `mcp-remote`

`mcp-remote@0.1.38` was tested on 2026-07-10. Repeated gates intermittently dropped the supplied
PAT, attempted OAuth registration against the PAT-only endpoint, and timed out waiting for JSON-RPC
ids 1 or 2. It also logs custom header values unless invoked with `--silent`. MOVP therefore does
not support that bridge version.

## Run from a MOVP Suite checkout

```sh
export MOVP_MCP_URL=https://your-project-ref.supabase.co/functions/v1/mcp
export MOVP_PAT=movp_pat_REPLACE_WITH_YOUR_TOKEN
pnpm --dir /path/to/movp-suite exec tsx packages/mcp-bridge/src/index.ts
```

For a local/self-hosted gateway that requires the Supabase `apikey` header, also set
`MOVP_MCP_APIKEY=<ANON_KEY>`. The bridge never prints the PAT, API key, or response payloads.

## Config for a stdio-only client
```json
{
  "mcpServers": {
    "movp": {
      "command": "pnpm",
      "args": [
        "--dir", "/path/to/movp-suite",
        "exec", "tsx", "packages/mcp-bridge/src/index.ts"
      ],
      "env": {
        "MOVP_MCP_URL": "https://your-project-ref.supabase.co/functions/v1/mcp",
        "MOVP_PAT": "${MOVP_PAT}"
      }
    }
  }
}
```

## Example call
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "task.list", "arguments": { "workspaceId": "00000000-0000-0000-0000-000000000000" } } }
```
