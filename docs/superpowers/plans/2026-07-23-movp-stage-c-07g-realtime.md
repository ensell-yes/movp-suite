# C7.5 — Private Content Realtime TDD Implementation Plan

> **Executor contract:** This part ships a headless transport-injected package and a dedicated authenticated browser fixture. It does not add Realtime to the reference delivery editor and must not expose its HttpOnly GoTrue token.

**Goal:** Deliver private revision Broadcast and Presence for authorized workspace members, with bounded reconnect and a content-disciplined database trigger.

**Depends on:** `2026-07-23-movp-stage-c-07f-inline-overlay.md`

**Approved design:** `docs/superpowers/specs/2026-07-23-movp-stage-c-07-tail-inline-editing-delivery-design.md` §10.

**Architecture:** `@movp/realtime` is a browser-safe state machine over an injected transport; it knows no Supabase implementation. A forward-only migration publishes minimal revision metadata through server-originated private Broadcast and authorizes member Presence/subscription through `realtime.messages` RLS. A test-only browser bundle adapts the repository’s existing `@supabase/supabase-js` dependency and proves two real sessions. The reference Astro page remains non-Realtime.

**No new external dependency:** Reuse the root’s existing `@supabase/supabase-js`, tsup, and the frontend’s existing Playwright. Do not add a new package/version. If lockfile resolution attempts a new version, stop for approval.

## Invariants

- Create only `supabase/migrations/20260723000003_content_realtime.sql`.
- Channels are `content:<validated-uuid>` and always private.
- Broadcast event is `revision_written`.
- Payload keys are exactly `item_id`, `revision_id`, `actor_id`, `created_at`.
- Payloads never contain body/data, hash, slug, field values, token, cookie, email, or URL.
- The trigger is owner/`SECURITY DEFINER` and server-originated. Client Broadcast insert remains denied.
- A Broadcast failure does not roll back the inserted revision. It emits one bounded database warning with ids and SQLSTATE, then returns `NEW`; no retry loop.
- Authenticated workspace members may SELECT Broadcast/Presence and INSERT Presence only for a valid item topic in their workspace.
- Malformed topics return false rather than throwing/casting before validation.
- Non-member subscription, anonymous subscription, and client-originated Broadcast insert fail closed.
- Reconnect attempts are bounded to three total attempts with capped exponential backoff and no jitter in deterministic tests. Exhaustion surfaces to the host and emits one safe operational event.
- Editing remains usable when Realtime is unavailable.
- Teardown cancels timers, untracks Presence, unsubscribes, and is idempotent.
- The package imports no Supabase, domain, GraphQL, auth, Node, Deno, or server-env module.
- Boundary scanners `lstat`, reject symlinks, and check size before reading.

## File map

**Create**

- `packages/realtime/package.json`
- `packages/realtime/tsconfig.json`
- `packages/realtime/vitest.config.ts`
- `packages/realtime/src/types.ts`
- `packages/realtime/src/channel.ts`
- `packages/realtime/src/index.ts`
- `packages/realtime/test/channel.test.ts`
- `packages/realtime/test/boundary.test.ts`
- `packages/realtime/test/public-surface.test.ts`
- `supabase/migrations/20260723000003_content_realtime.sql`
- `supabase/tests/content_realtime_test.sql`
- `templates/frontend-astro/tests/e2e/fixtures/realtime-client.ts`
- `templates/frontend-astro/tests/e2e/realtime.spec.ts`
- `scripts/check-content-realtime-browser.mjs`
- `scripts/test/check-content-realtime-browser.test.mjs`

**Modify**

- `package.json`
- `scripts/check-package-artifacts.mjs`
- `scripts/check-publishable-versions.mjs`
- `fixtures/verdaccio-crm-lite/gate.sh`
- `fixtures/verdaccio-gallery/pack.sh`
- `.github/workflows/ci.yml`
- `scripts/check-ci-wiring.mjs`
- `CLAUDE.md`
- `pnpm-lock.yaml`

## Task 0: Verify tools and local Realtime configuration

- [ ] Run:

```sh
git status --short --branch
supabase status
pnpm exec tsup --help
pnpm --filter @movp/frontend-astro exec playwright test --help
rg -n "^\\[realtime\\]|enabled|private" supabase/config.toml
```

Expected:

- intended branch and no unrelated changes;
- this repo’s `6432x` stack;
- tsup supports `--format`, `--platform`, `--global-name`, `--out-dir`, `--clean`;
- Playwright supports `--grep` and `--config`;
- local Realtime is enabled.

- [ ] Inspect installed local schemas/functions without changing them:

```sh
psql "$(supabase status -o env | sed -n 's/^DB_URL=//p')" -c "\\df realtime.send"
psql "$(supabase status -o env | sed -n 's/^DB_URL=//p')" -c "\\d+ realtime.messages"
```

Expected: the actual `realtime.send` signature and `realtime.messages` topic/extension columns are visible. If `supabase status -o env` is unavailable on this CLI, use the displayed local DB URL manually; do not encode an unverified flag.

Record the exact signatures in the PR and adapt the migration to those installed objects.

## Task 1: Scaffold the transport-injected `@movp/realtime` package

- [ ] Create the package at version `0.1.1`, following `@movp/richtext` conventions. It has no runtime dependencies.

Public types:

```ts
export type RevisionNotice = Readonly<{
  itemId: string
  revisionId: string
  actorId: string
  createdAt: string
}>

export type PresenceNotice = Readonly<{
  joins: readonly string[]
  leaves: readonly string[]
}>

export type RealtimeOperationalEvent = Readonly<{
  event: 'content.realtime_subscribe'
  itemId: string
  outcome: 'subscribed' | 'retrying' | 'exhausted' | 'closed'
  attempt: 1 | 2 | 3
  code?: string
  latencyMs: number
}>
```

Define a minimal host transport interface that supports:

- set/refresh auth;
- subscribe to a named private channel;
- receive Broadcast and Presence sync/join/leave;
- track/untrack Presence;
- unsubscribe.

All transport callbacks accept `unknown` and are structurally narrowed by the package.

- [ ] Add `public-surface.test.ts` first, then run:

```sh
pnpm --filter @movp/realtime test -- public-surface.test.ts
```

Expected: **FAIL** because the package/exports are incomplete. “No projects matched” is not an acceptable red state; create the manifest and run `pnpm install --lockfile-only` before this gate.

- [ ] Export:

```ts
subscribeContentChannel(
  transport: RealtimeTransport,
  itemId: string,
  options: SubscribeContentOptions,
): ContentChannelSubscription
```

The returned object exposes `ready: Promise<void>` and idempotent `destroy(): Promise<void>`.

**Scaffold gate**

```sh
pnpm install --lockfile-only
pnpm --filter @movp/realtime typecheck
```

Expected: package resolves and no new registry package/version is added.

## Task 2: Implement validation, Presence, reconnect, and teardown TDD

**Red first**

- [ ] Write `channel.test.ts` with fake timers and a fake transport. Cover:
  - valid private topic is exactly `content:<uuid>`;
  - invalid item id fails before transport creation;
  - valid revision payload reaches `onRevision`;
  - extra/missing/wrong-type payload keys are rejected and never reach the callback;
  - payload values are validated UUID/ISO timestamp strings;
  - Presence join/leave is normalized and bounded;
  - auth is set before the first subscribe;
  - refreshed auth is applied before resubscribe;
  - transient errors retry at most attempts 2 and 3 with capped backoff;
  - authorization/validation errors are terminal and do not retry;
  - exhaustion emits exactly one `attempt:3` event and rejects/surfaces a stable code;
  - callback exceptions do not trigger reconnect loops;
  - `destroy()` cancels a pending retry, untracks, unsubscribes, and is safe twice;
  - no event contains inbound payload/token content.

- [ ] Run:

```sh
pnpm --filter @movp/realtime test -- channel.test.ts
```

Expected: **FAIL** because `subscribeContentChannel` is not implemented.

**Green implementation**

- [ ] Implement a closed state machine (`idle | subscribing | active | retry_wait | exhausted | closed`). Do not represent states with booleans/sentinels.

- [ ] Default retry policy:

```text
attempt 1 immediately
attempt 2 after 250 ms
attempt 3 after 1,000 ms
then fail hard and notify the host
```

Allow a scheduler/clock injection for deterministic tests, not arbitrary unbounded policy.

- [ ] Presence input limits: cap participant list/event batch and identifier byte length. Drop malformed individual entries; if the whole message is malformed, surface a safe validation code. Never log a preview.

- [ ] Add the guarded recursive boundary test. Reject:
  - `@supabase/*`;
  - `@movp/domain`, `@movp/graphql`, `@movp/auth`;
  - `node:*`, `Deno`, `cloudflare:workers`;
  - service-role/env/token literal access.

The test must create a nested fixture during its own test or scan nested source so helper extraction cannot escape.

**Gate**

```sh
pnpm --filter @movp/realtime test
pnpm --filter @movp/realtime typecheck
pnpm --filter @movp/realtime build
```

Expected: all tests green and `dist/index.js`/`.d.ts` exist.

**Commit**

```sh
git add packages/realtime pnpm-lock.yaml
git commit -m "feat(realtime): add transport-injected content channel"
```

## Task 3: Write private-channel RLS and trigger tests

**Red first**

- [ ] Create transactional `content_realtime_test.sql`. Pin catalog and behavior:
  1. trigger exists only on `content_revision` `AFTER INSERT`;
  2. trigger function is owned/`SECURITY DEFINER`, has explicit search path, and is not executable by application roles;
  3. trigger payload expression contains exactly the four allowed keys;
  4. authenticated workspace member may SELECT Broadcast/Presence for `content:<owned-item-uuid>`;
  5. same member may INSERT Presence only;
  6. client Broadcast INSERT is denied;
  7. non-member and anon SELECT/INSERT are denied;
  8. malformed, empty, overlong, wrong-prefix, non-UUID topics return false/deny without an exception;
  9. a revision insert still succeeds when the send path raises, and one warning path is present;
  10. there is no retry loop/queue table.

For failure testing, replace or wrap the send dependency only inside the pgTAP transaction and restore through rollback. Do not edit Supabase-owned schema objects in a migration.

- [ ] Run:

```sh
supabase test db supabase/tests/content_realtime_test.sql
```

Expected: **FAIL** because trigger/policies do not exist.

## Task 4: Add the forward-only Broadcast trigger and `realtime.messages` RLS

- [ ] Create `20260723000003_content_realtime.sql`.

Add a helper predicate that:

1. checks `topic` starts with exactly `content:`;
2. extracts the suffix;
3. validates the suffix with a UUID regex/guard before casting;
4. resolves the item’s workspace;
5. calls the existing caller-bound membership helper;
6. returns false for every malformed/missing case.

Keep the helper least-privileged and revoke broad execute where appropriate.

- [ ] Create restrictive policies matching:

```text
SELECT: authenticated + valid member topic + extension in (broadcast, presence)
INSERT: authenticated + valid member topic + extension = presence
```

Do not add client UPDATE/DELETE or Broadcast INSERT.

- [ ] Implement the trigger using the installed `realtime.send` signature. Its exception block is:

```text
catch all -> raise one WARNING with item_id, revision_id, SQLSTATE -> return NEW
```

Do not include SQLERRM because it may contain untrusted/internal values. Do not retry.

The database call runs as the trigger owner/definer and therefore does not rely on the client Presence-only INSERT policy.

**Green gate**

```sh
supabase db reset
supabase test db supabase/tests/content_realtime_test.sql
supabase test db
pnpm test:forward-only-migrations
```

Expected: full pgTAP green; revision commit survives the simulated Broadcast failure; forward-only guard passes.

**Commit**

```sh
git add supabase/migrations/20260723000003_content_realtime.sql supabase/tests/content_realtime_test.sql
git commit -m "feat(realtime): authorize private content broadcasts"
```

## Task 5: Build a real two-session browser fixture

The fixture is test-only. It owns browser-readable test sessions and must never be imported by production frontend source.

**Red first**

- [ ] Add `scripts/test/check-content-realtime-browser.test.mjs` to require:
  - fixture source exists and is a regular non-symlink below a byte cap;
  - the runner uses `mkdtemp`, cleans in `finally`, and never writes credentials;
  - tsup is invoked through argument arrays (no shell interpolation);
  - Playwright receives the generated bundle path through an environment variable;
  - production `templates/frontend-astro/src` has no import/reference to the fixture.

- [ ] Add the Playwright spec cases before the runner:
  - two authorized browser contexts join the same private channel and observe Presence join/leave;
  - writing a revision from session A delivers one validated `revision_written` to session B;
  - non-member subscribe is denied;
  - malformed topic is denied;
  - a client Broadcast send/insert is denied;
  - token refresh calls `setAuth` before resubscription;
  - after teardown, no callbacks arrive.

- [ ] Run:

```sh
node --test scripts/test/check-content-realtime-browser.test.mjs
```

Expected: **FAIL** because the runner/bundle source is absent.

**Green implementation**

- [ ] `realtime-client.ts` is the only Supabase adapter. It imports:

```ts
import { createClient } from '@supabase/supabase-js'
import { subscribeContentChannel } from '@movp/realtime'
```

It creates the channel with `{ config: { private: true } }`, adapts Broadcast/Presence/auth/unsubscribe, and exposes a narrow test API on one known fixture global. No token is logged or included in assertion messages.

- [ ] `check-content-realtime-browser.mjs`:
  1. `lstat`s source/config paths and size-checks before use;
  2. makes a unique temp directory;
  3. calls root `pnpm exec tsup ... --format iife --platform browser --global-name MovpRealtimeFixture`;
  4. validates generated bundle is regular/non-symlink/bounded;
  5. invokes the exact Playwright spec with its bundle path in env;
  6. removes the temp directory in `finally`.

Use `execFileSync`/`spawn` argument arrays, not a constructed shell command.

- [ ] Add root script:

```json
"test:content-realtime-browser": "node scripts/check-content-realtime-browser.mjs"
```

The runner reads local public URL/anon key and test credentials from environment at runtime. It fails loudly with named missing-variable codes. It never accepts credentials in argv or writes them to disk.

**Integration gate**

```sh
pnpm test:content-realtime-browser
```

Expected: all two-session positive/negative cases pass against the local stack. If the local Realtime service is unhealthy, that is an operational failure, not a passing/skipped result.

**Commit**

```sh
git add templates/frontend-astro/tests/e2e/fixtures/realtime-client.ts templates/frontend-astro/tests/e2e/realtime.spec.ts scripts/check-content-realtime-browser.mjs scripts/test/check-content-realtime-browser.test.mjs package.json
git commit -m "test(realtime): add private two-session browser gate"
```

## Task 6: Register the package and make CI authoritative

**Red first**

- [ ] Update inventory expectations/tests before lists, then run:

```sh
pnpm check:packages
pnpm check:publishable-versions
pnpm check:ci-wiring
```

Expected: **FAIL** naming missing `@movp/realtime` and/or required job.

**Green implementation**

- [ ] Add `realtime` to package artifact/version and both Verdaccio package lists. Pin its no-dependency manifest and built entrypoint.

- [ ] Add required CI job `c7-realtime`:
  - starts the isolated local Supabase stack;
  - runs focused pgTAP;
  - runs package test/typecheck/build/boundary;
  - provisions bounded throwaway owner/member/non-member test sessions without printing tokens;
  - runs `pnpm test:content-realtime-browser`;
  - cleans test identities/state.

- [ ] Before any hosted acceptance run, document an operator check that Realtime Authorization is enabled. This plan does not mutate hosted configuration.

- [ ] Update `CLAUDE.md`: private topic format, payload allowlist, trigger failure semantics, client policy, three-attempt reconnect, transport-injection boundary, and honest “fixture only; reference editor has no Realtime” scope.

**Final gates**

```sh
pnpm check:packages
pnpm check:publishable-versions
pnpm check:ci-wiring
pnpm --filter @movp/realtime test
pnpm --filter @movp/realtime typecheck
pnpm --filter @movp/realtime build
supabase test db supabase/tests/content_realtime_test.sql
pnpm test:content-realtime-browser
pnpm test:forward-only-migrations
git diff --check
```

Expected: every command exits `0`; package boundary finds no Supabase import; real browser fixture proves authorized Presence/Broadcast and all denial paths.

**Commit**

```sh
git add scripts fixtures packages/realtime .github/workflows/ci.yml CLAUDE.md pnpm-lock.yaml
git commit -m "ci(realtime): gate private content channels"
```

## Completion gate

C7.5 is complete only when:

- the package’s fake-transport suite proves validation/reconnect/teardown;
- pgTAP proves topic parsing, least privilege, and non-rollback trigger failure;
- a real two-session browser test proves Presence and revision Broadcast;
- non-member/malformed/client-Broadcast paths deny;
- production frontend source cannot import the fixture;
- package/release/CI inventories include `@movp/realtime`;
- no claim or code wires Realtime into the reference editor.

Then proceed to `2026-07-23-movp-stage-c-07h-delivery-seo.md`.
