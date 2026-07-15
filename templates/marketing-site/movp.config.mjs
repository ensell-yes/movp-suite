// Node tooling (codegen, the movp CLI, verify-schema-runtime) reads the schema here; Deno edge
// functions import the SAME ../_shared/schema.ts directly. Both compute the identical
// runtimeFingerprint (06b) — the fingerprint `movp verify-schema-runtime` compares before serve/deploy
// (packages/cli/src/verify-schema-runtime.ts:57). It is NOT schemaFingerprint: that one is DB-exact and
// blind to `internal` + `events`, so it cannot detect a Node/Deno divergence in the exposed surface.
export { schema } from './supabase/functions/_shared/schema.ts'
