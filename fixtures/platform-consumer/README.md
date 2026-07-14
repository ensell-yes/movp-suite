# Platform consumer fixture

This fixture proves the C6a platform artifact can be materialized into a standalone, port-isolated Supabase project, reset without source-repository paths, and extended without changing platform metadata. It requires Docker, the Supabase CLI, and `psql`; run `bash gate.sh`. `supabase/migrations/` is ignored and rebuilt from `@movp/platform`'s verified `dist/` artifact on every run.
