## Supabase Local Stack Hygiene

- This repo intentionally uses Supabase local ports `64321`/`64322`/`64320`/`64323`/`64324`/`64327`/`64329`.
  Do not revert them to the Supabase defaults as “cleanup” unless you first prove the default ports are free.
- Before changing `supabase/config.toml` ports, run `supabase status` in this repo and check for other local
  Supabase projects already owning default ports, especially `big-wave`, `norcal`, and `atomic`.
- Treat a port remap as environment isolation, not drift. If DB gates start reading a migration history that does
  not belong to this repo, stop and fix the local Supabase target before trusting pgTAP results.
- Storage may be temporarily disabled for pure-Postgres DB gates only when the local storage container healthcheck
  blocks `supabase db reset`. Re-enable storage before CMS asset or frontend e2e work.
