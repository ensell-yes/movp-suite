# MOVP App — Collaboration Phase 2, Part B: Domain Services, Inbox, Surfaces & Notifications

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is bite-sized TDD: write a failing test → run it (expect the stated failure) → write the COMPLETE implementation → run it (expect pass) → run the machine-checkable gate → commit.

**Goal:** Build the read/write behaviour of MOVP collaboration on top of the config, tables, RLS, and event triggers delivered by **Part A**. This part adds: a domain `collab` service (`packages/domain/src/collab.ts`) wired into `createDomain`; two workspace-scoped SECURITY DEFINER RPCs (`inbox_feed`, `resolve_share_link`) in migration `20260701000007_collaboration_rpcs.sql`; a recipient generalization in the `flows` notify worker so mention notifications reach the mentioned user's email; and the GraphQL, MCP, and CLI surfaces for inbox + comment/reaction/save/share. It closes with an end-to-end collaboration slice in `scripts/slice-e2e.sh` and a domain integration test.

**Architecture:** Part A adds the 5 collaboration collections config-first (`comment`, `reaction`, `saved_item`, `mention`, `share_link`) and marks each `internal: true` (a new optional `CollectionDef.internal` flag). The existing schema-driven builders (GraphQL `packages/graphql/src/schema.ts`, MCP `packages/mcp/src/server.ts`, CLI `packages/cli/src/program.ts`) **skip** every `internal` collection, so these five get **no** generic CRUD — no `createComment` mutation, no `comment.create` tool, no `movp comment create` command. They *must* be internal: the committed generic builders assume relations are many-to-many → edges (`loadEdgeTargets`) and their create inputs drop relation fields, so they cannot set a required `mention.comment_id`, resolve `comment.parent` through the (nonexistent) edge, or preserve the atomic mention write — a generic `createComment` would bypass the composite logic. The collab collections are reached **exclusively** through a hand-written `collab` service (wired into `createDomain`) that owns the composite writes (a comment plus its denormalized mention rows via the `create_comment_with_mentions` RPC; share-link token minting) and the inbox read, mirroring the existing hand-written `search` op. Codegen still produces the collab `*Row` types, which the `collab` service consumes. Because `movp_internal` is not exposed to PostgREST (`supabase/config.toml [api] schemas`), the inbox feed — which reads `movp_internal.movp_events` for the `all` tab — **must** be a `public` SECURITY DEFINER RPC granted to `authenticated`, scoped inside by `public.is_workspace_member(ws)` + `auth.uid()`; it can never be a view. Share tokens are minted client-side (raw token returned once), only `sha256hex(token)` is persisted, and resolution is a second DEFINER RPC. Mention notifications reuse the existing `notify` job kind (no new `movp_job_kind`): Part A's `user.mentioned` payload carries `recipient_user_id`; the notify worker resolves it to an email via the service-role admin API.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Vitest, pgTAP, Supabase CLI. `.ts` relative imports with explicit extensions; bare `@movp/*` workspace specifiers. Web Crypto (`crypto.subtle`, `crypto.randomUUID`) for hashing/token minting (works in Node ≥ 20 and Deno). Pothos (`@pothos/core`) for GraphQL; `@modelcontextprotocol/sdk` + `zod` for MCP; `commander` for the CLI.

**This is Part B of the Phase-2 Collaboration series.** It depends on **Part A** (`supabase/migrations/20260701000006_collaboration.sql`, the collab collection config in `@movp/core-schema`, and the generated collab types in `packages/domain/src/generated/types.ts`) being merged first. Part A and Part B compose: the surface builders skip every `internal: true` collection, so the five collab collections never reach the `no domain service for collection` guard (that guard still applies to non-`internal` collections like `note`/`tag`, which already have services). The custom collab ops (inbox, addComment, …) instead resolve `domain.collab`, which Task 2 wires — so the collab surface is only functional once Task 2 lands.

## Global Constraints

- **Consume Part A; do not rebuild it.** The 5 collab tables, their RLS, the `public.can_access_entity(entity_type text, entity_id uuid, ws uuid) returns boolean` DEFINER function, the AFTER-INSERT event triggers, and the generated collab types are fixed inputs. Do not redefine them. Your migration is `20260701000007_collaboration_rpcs.sql` (sorts after Part A's `...006`).
- **The `CollabService` interface is a fixed contract** (see "Inputs consumed from Part A → CollabService interface"). Implement it exactly; do not add or rename methods. Share-link *resolution* is a separate standalone `resolveShareLink(ctx, token)` domain export (surfaces need it; the `CollabService` interface deliberately omits it).
- **Per-request dependencies resolved at call time.** `collab.ts` reads `ctx.db` / `ctx.userId` from the `DomainCtx` passed into `makeCollabService(ctx)` — never module scope. Surfaces build a fresh `createDomain({ db: ctx.db, userId: ctx.userId }, …)` per request (existing `domainFrom(ctx)` pattern).
- **Hardened SECURITY DEFINER.** Both new DEFINER read RPCs (`inbox_feed`, `resolve_share_link`) use `set search_path = ''`, every object schema-qualified, `execute` revoked from `public, anon` and granted to `authenticated`. They are user-facing reads scoped by `is_workspace_member` / `auth.uid()`, NOT service-role-only queue RPCs. `node scripts/check-definer-audit.mjs` must stay green. The migration's third function, `create_comment_with_mentions`, is `SECURITY INVOKER` (runs under the caller's RLS) — it also pins `set search_path = ''` and is schema-qualified + `authenticated`-only, but the definer audit does not flag it because it is not a definer.
- **Reuse Core's async spine.** No new queue, no new `movp_job_kind`. Mention notifications ride the existing `notify` kind (Part A's trigger → `public.emit_event` → a `notify` job).
- **Observability discipline.** The notify worker logs bounded `error_code`s only (existing `completeJob(..., false, code)` path) — never a resolved email or payload value.
- **Boundary gate.** `templates/` must stay free of `@movp/{auth,domain}` and service-role references — this part touches only `packages/*` and `supabase/*`, never `templates/`. `bash scripts/check-boundary.sh` must stay green.
- **Supabase CLI is the only migration applier.** Plain SQL in `supabase/migrations/`.

## Inputs consumed from Part A (verify BEFORE Task 1)

These are Part A's deliverables. Part B code references them by exact name; a mismatch here is a reconciliation defect, not something to work around.

**Naming invariant (load-bearing):** each collab collection's `name` in `schema.collections` equals its snake_case DB table name: `comment`, `reaction`, `saved_item`, `mention`, `share_link`. These are **not** `createDomain` keys (only `note`/`tag` are) — the `collab` service reaches them by literal table name (`ctx.db.from('comment')…`, the `create_comment_with_mentions` RPC). Generated TypeScript types are Pascal-singular: `CommentRow/CommentCreate/CommentUpdate`, `ReactionRow/…`, `SavedItemRow/…`, `MentionRow/…`, `ShareLinkRow/…` (codegen still produces them; the `collab` service consumes `CommentRow`). If Part A named a collection or table differently (e.g. `savedItem`), STOP and reconcile — the collab collection names, the table names the `collab` service references, and (for `note`/`tag`) the `createDomain` keys + `service(domain, c.name)` lookups all depend on this.

**`internal` flag (load-bearing):** Part A adds an optional `internal?: boolean` to `CollectionDef` and sets `internal: true` on all five collab collections. The GraphQL/MCP/CLI builders read `c.internal` to skip generic CRUD for them (Tasks 4–6); `note`/`tag` leave `internal` unset and stay fully surfaced. If `CollectionDef.internal` is absent or unset on the collab collections, STOP and reconcile — Tasks 4–6's `if (c.internal) continue` guards depend on it.

**Tables & columns Part B reads/writes** (Part A owns their creation, RLS, defaults, triggers):
- `public.comment (id uuid, workspace_id uuid, entity_type text, entity_id uuid, body text, author_id uuid, parent_id uuid null, created_at, updated_at)`
- `public.reaction (id, workspace_id, user_id uuid, entity_type, entity_id, kind text check in ('like','dislike'), created_at, updated_at)`
- `public.saved_item (id, workspace_id, user_id, entity_type, entity_id, created_at, updated_at)`
- `public.mention (id, workspace_id, comment_id uuid, mentioned_user_id uuid, entity_type, entity_id, created_at)`
- `public.share_link (id, workspace_id, entity_type, entity_id, token_hash text, scope text, created_by uuid, expires_at timestamptz null, created_at)`
- `public.can_access_entity(text, uuid, uuid) returns boolean` (SECURITY DEFINER, granted `authenticated`).
- `public.is_workspace_member(uuid)` (from bootstrap tenancy — already present).
- `movp_internal.movp_events (id, type, workspace_id, payload jsonb, trace_id, created_at)` (from `...005`).

**RLS assumptions Part B relies on:** comment writes are author-scoped (`author_id = auth.uid()`) with `can_access_entity` reads; a comment's author may insert `mention` rows for that comment; reaction/saved_item are user-scoped (`user_id = auth.uid()`). Part A's `user.mentioned` event payload carries `recipient_user_id`.

**CollabService interface (fixed contract — Task 2 implements it verbatim):**
```ts
export interface InboxItem {
  kind: string
  entity_type: string
  entity_id: string
  ref_id: string
  created_at: string
  payload: Record<string, unknown>
}

export interface CollabService {
  comment: {
    create(input: {
      entityType: string
      entityId: string
      body: string
      parentId?: string
      mentions?: string[]
    }): Promise<CommentRow>
    listByEntity(a: {
      workspaceId: string
      entityType: string
      entityId: string
      first?: number
      after?: string | null
    }): Promise<Page<CommentRow>>
  }
  react(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  unreact(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  save(i: { entityType: string; entityId: string }): Promise<void>
  unsave(i: { entityType: string; entityId: string }): Promise<void>
  createShareLink(i: { entityType: string; entityId: string; expiresInHours?: number }): Promise<{ token: string }>
  inbox(a: { workspaceId: string; tab: 'all' | 'mentions' | 'saved' | 'assigned'; first?: number }): Promise<InboxItem[]>
}
```

- [ ] **Precondition check** — confirm Part A is merged. Run:
```bash
cd /Users/ensell/Code/supasuite
grep -q 'CommentRow' packages/domain/src/generated/types.ts && echo GEN_OK || echo GEN_MISSING
ls supabase/migrations/20260701000006_collaboration.sql >/dev/null 2>&1 && echo MIG_OK || echo MIG_MISSING
```
Expected: `GEN_OK` and `MIG_OK`. If either is missing, STOP — Part A is not merged; this plan cannot execute.

## File Structure

```
supasuite/
  supabase/
    migrations/
      20260701000007_collaboration_rpcs.sql   # NEW: inbox_feed + resolve_share_link (DEFINER, authenticated)
    tests/
      collaboration_rpcs_test.sql              # NEW: pgTAP for the two RPCs
  packages/
    domain/
      src/collab.ts                            # NEW: makeCollabService + resolveShareLink
      src/types.ts                             # EDIT: InboxItem, CollabService, Domain.collab (no generic collab CollectionServices)
      src/domain.ts                            # EDIT: wire the collab service (collab collections are internal — NOT wired as generic services)
      src/index.ts                             # EDIT: export collab symbols/types
      test/collab.integration.test.ts          # NEW: comment+mention→inbox, react/save, share, atomic rollback, cross-ws
    flows/
      src/flows-worker.ts                      # EDIT: notify recipient_user_id resolution
      test/flows-worker.test.ts                # NEW: recipient resolution + note.created fallback
    graphql/
      src/schema.ts                            # EDIT: inbox query + 5 collab mutations
      test/collab.test.ts                      # NEW
    mcp/
      src/server.ts                            # EDIT: 5 collab tools
      test/server.test.ts                      # EDIT: mock all collections + collab-tool assertions
    cli/
      src/program.ts                           # EDIT: inbox + comment add commands
      test/program.test.ts                     # EDIT: mock collab + collab-command assertions
  scripts/
    slice-e2e.sh                               # EDIT: collab e2e slice
```

> **Scope note — comment search is deferred.** `packages/domain/src/search.ts`'s `COLLECTIONS` const stays `['note', 'tag']`. The generic FTS path (`search_fts` + `hydrateTitles`) assumes each searchable collection has a `title`/`name` column; `comment` has `body`, not `title`, so adding it would break `hydrateTitles`. Comment-body search is out of scope for Part B.

---

### Task 1: Inbox + share-link RPCs (`20260701000007_collaboration_rpcs.sql`) + pgTAP

Two `public` SECURITY DEFINER read RPCs granted to `authenticated`. `inbox_feed` returns `'[]'` unless the caller is a member of `ws`, then returns this user's mentions / saved items / recent workspace events / (empty for `assigned`). `resolve_share_link` returns `{entity_type, entity_id, workspace_id}` for a non-expired link matching the token hash, else SQL `null`. The same migration also adds one `SECURITY INVOKER` write RPC, `create_comment_with_mentions`, which inserts a comment and its denormalized mention rows in a single transaction (see FIX 2 in the migration below); Task 2's domain service calls it and Task 2's integration test proves its atomicity, while this task's pgTAP asserts only its structure + grants.

**Files:**
- Create: `supabase/migrations/20260701000007_collaboration_rpcs.sql`
- Test: `supabase/tests/collaboration_rpcs_test.sql`

**Interfaces produced:**
- `public.inbox_feed(ws uuid, tab text, lim int) returns jsonb` (DEFINER, `search_path=''`, `authenticated`).
- `public.resolve_share_link(p_token_hash text) returns jsonb` (DEFINER, `search_path=''`, `authenticated`).
- `public.create_comment_with_mentions(ws uuid, p_entity_type text, p_entity_id uuid, p_body text, p_parent_id uuid, p_mentions uuid[]) returns jsonb` (INVOKER, `search_path=''`, `authenticated`) — atomic comment + mentions insert.

- [ ] **Step 1: Write the failing pgTAP test**

`supabase/tests/collaboration_rpcs_test.sql`:
```sql
begin;
select plan(14);

-- structure + grants
select has_function('public', 'inbox_feed', array['uuid','text','integer'], 'inbox_feed exists');
select has_function('public', 'resolve_share_link', array['text'], 'resolve_share_link exists');
select is(has_function_privilege('authenticated', 'public.inbox_feed(uuid,text,integer)', 'execute'),
          true, 'authenticated can execute inbox_feed');
select is(has_function_privilege('anon', 'public.inbox_feed(uuid,text,integer)', 'execute'),
          false, 'anon cannot execute inbox_feed');
select is(has_function_privilege('authenticated', 'public.resolve_share_link(text)', 'execute'),
          true, 'authenticated can execute resolve_share_link');

-- the atomic comment+mentions write RPC (SECURITY INVOKER): structure + grants only;
-- its transactional behaviour is proved by Task 2's domain integration test.
select has_function('public', 'create_comment_with_mentions',
                    array['uuid','text','uuid','text','uuid','uuid[]'], 'create_comment_with_mentions exists');
select is(has_function_privilege('authenticated',
            'public.create_comment_with_mentions(uuid,text,uuid,text,uuid,uuid[])', 'execute'),
          true, 'authenticated can execute create_comment_with_mentions');
select is(has_function_privilege('anon',
            'public.create_comment_with_mentions(uuid,text,uuid,text,uuid,uuid[])', 'execute'),
          false, 'anon cannot execute create_comment_with_mentions');

-- seed as superuser (reset role bypasses RLS)
reset role;
insert into public.workspace (id, name)
  values ('44444444-4444-4444-4444-444444444444', 'CollabWs') on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
  on conflict do nothing;
insert into public.note (id, workspace_id, title, body, status)
  values ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'N', 'b', 'draft')
  on conflict (id) do nothing;
insert into public.comment (id, workspace_id, entity_type, entity_id, body, author_id)
  values ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
          'note', '55555555-5555-5555-5555-555555555555', 'hi', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  on conflict (id) do nothing;
insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
  values ('44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'note', '55555555-5555-5555-5555-555555555555');
insert into public.saved_item (workspace_id, user_id, entity_type, entity_id)
  values ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'note', '55555555-5555-5555-5555-555555555555');
insert into public.share_link (workspace_id, entity_type, entity_id, token_hash, scope, created_by)
  values ('44444444-4444-4444-4444-444444444444', 'note', '55555555-5555-5555-5555-555555555555',
          'deadbeefhash', 'view', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.share_link (workspace_id, entity_type, entity_id, token_hash, scope, created_by, expires_at)
  values ('44444444-4444-4444-4444-444444444444', 'note', '55555555-5555-5555-5555-555555555555',
          'expiredhash', 'view', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '1 hour');

-- as the member: mentions / saved return their rows; assigned is empty (phase-3 seam)
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','mentions',20)),
          1, 'mentions tab returns the mention');
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','saved',20)),
          1, 'saved tab returns the saved item');
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','assigned',20)),
          0, 'assigned tab is empty (phase-3 seam)');

-- a non-member gets an empty feed even for a real ws
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','mentions',20)),
          0, 'non-member feed is empty');

-- share link resolves by hash (non-expired); expired resolves to null
select is((public.resolve_share_link('deadbeefhash'))->>'entity_id',
          '55555555-5555-5555-5555-555555555555', 'resolve_share_link returns the entity ref');
select ok(public.resolve_share_link('expiredhash') is null, 'expired share link resolves to null');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
supabase db reset && supabase test db
```
Expected: FAIL — `function public.inbox_feed(uuid, text, integer) does not exist`. (`db reset` applies Part A's `...006` migration first; the pgTAP file references its tables.)

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260701000007_collaboration_rpcs.sql`:
```sql
-- Collaboration RPCs: two SECURITY DEFINER reads (inbox_feed, resolve_share_link)
-- plus one SECURITY INVOKER write (create_comment_with_mentions, defined last).
-- movp_internal is NOT exposed to PostgREST, so the inbox feed (which reads
-- movp_internal.movp_events for the 'all' tab) MUST be a public SECURITY DEFINER
-- RPC scoped by is_workspace_member + auth.uid() — never a view.

create or replace function public.inbox_feed(ws uuid, tab text, lim int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  capped int := least(greatest(coalesce(lim, 20), 1), 100);
  result jsonb;
begin
  -- Membership gate: a non-member (or unauthenticated) caller sees nothing.
  if not public.is_workspace_member(ws) then
    return '[]'::jsonb;
  end if;

  if tab = 'mentions' then
    select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb) into result
    from (
      select jsonb_build_object(
               'kind', 'user.mentioned',
               'entity_type', m.entity_type,
               'entity_id', m.entity_id::text,
               'ref_id', m.id::text,
               'created_at', m.created_at,
               'payload', jsonb_build_object('comment_id', m.comment_id::text, 'body', c.body)
             ) as item,
             m.created_at as created_at
        from public.mention m
        join public.comment c on c.id = m.comment_id
       where m.workspace_id = ws
         and m.mentioned_user_id = uid
       order by m.created_at desc
       limit capped
    ) s;

  elsif tab = 'saved' then
    select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb) into result
    from (
      select jsonb_build_object(
               'kind', 'item.saved',
               'entity_type', si.entity_type,
               'entity_id', si.entity_id::text,
               'ref_id', si.id::text,
               'created_at', si.created_at,
               'payload', '{}'::jsonb
             ) as item,
             si.created_at as created_at
        from public.saved_item si
       where si.workspace_id = ws
         and si.user_id = uid
       order by si.created_at desc
       limit capped
    ) s;

  elsif tab = 'all' then
    select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb) into result
    from (
      select jsonb_build_object(
               'kind', e.type,
               'entity_type', coalesce(e.payload->>'entity_type', ''),
               'entity_id', coalesce(e.payload->>'entity_id', e.payload->>'id', ''),
               'ref_id', e.id::text,
               'created_at', e.created_at,
               'payload', e.payload
             ) as item,
             e.created_at as created_at
        from movp_internal.movp_events e
       where e.workspace_id = ws
       order by e.created_at desc
       limit capped
    ) s;

  else
    -- 'assigned' is a Phase-3 Task seam; any unknown tab also returns empty.
    result := '[]'::jsonb;
  end if;

  return result;
end;
$$;

create or replace function public.resolve_share_link(p_token_hash text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'entity_type', sl.entity_type,
           'entity_id', sl.entity_id::text,
           'workspace_id', sl.workspace_id::text
         )
    from public.share_link sl
   where sl.token_hash = p_token_hash
     and (sl.expires_at is null or sl.expires_at > now())
   limit 1;
$$;

-- User-facing DEFINER reads: revoke from public/anon, grant to authenticated only.
revoke all on function public.inbox_feed(uuid, text, int) from public, anon;
revoke all on function public.resolve_share_link(text) from public, anon;
grant execute on function public.inbox_feed(uuid, text, int) to authenticated;
grant execute on function public.resolve_share_link(text) to authenticated;

-- FIX 2 — Atomic comment + mentions. A comment and its denormalized mention rows
-- must commit together: with two separate supabase-js inserts, a failing mention
-- insert leaves an orphan comment (no mentions, no user.mentioned events). This
-- SECURITY INVOKER RPC inserts both in ONE transaction, so Part A's RLS still runs
-- as the CALLER (author-scoping on comment + can_access_entity + the mention
-- author/exists check). Because the comment is inserted BEFORE the mentions in the
-- same transaction, Part A's mention_insert RLS `exists(... c.author_id = auth.uid())`
-- is satisfied by the just-inserted comment; and if ANY mention is disallowed the
-- whole statement rolls back — no orphan comment persists.
create or replace function public.create_comment_with_mentions(
  ws uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_body text,
  p_parent_id uuid,
  p_mentions uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
  mention_id uuid;
  result jsonb;
begin
  insert into public.comment (workspace_id, entity_type, entity_id, body, author_id, parent_id)
    values (ws, p_entity_type, p_entity_id, p_body, (select auth.uid()), p_parent_id)
    returning id into new_id;

  if p_mentions is not null then
    foreach mention_id in array p_mentions loop
      insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
        values (ws, new_id, mention_id, p_entity_type, p_entity_id);
    end loop;
  end if;

  select to_jsonb(c) into result from public.comment c where c.id = new_id;
  return result;
end;
$$;

-- INVOKER write RPC: same grant discipline (authenticated only).
revoke all on function public.create_comment_with_mentions(uuid, text, uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.create_comment_with_mentions(uuid, text, uuid, text, uuid, uuid[]) to authenticated;
```

> **Why `SECURITY INVOKER` (not `DEFINER`).** The function must run under the caller's RLS so Part A enforces author-scoping + `can_access_entity` on the comment insert and the mention author/exists check on each mention row. Because the comment is inserted BEFORE the mentions in the SAME transaction, Part A's `mention_insert` RLS `exists(... c.author_id = auth.uid())` check is satisfied by the just-inserted comment — and the whole thing rolls back if any mention is disallowed, so no orphan comment is ever persisted. It carries `set search_path = ''` and full schema-qualification like the DEFINER RPCs, but `check-definer-audit.mjs` does not flag it (it is not a definer).

- [ ] **Step 4: Apply, run the test, drift + definer gates**

Run:
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: migration applies; `collaboration_rpcs_test.sql .. ok` (14 assertions pass); definer-audit prints `all definers pinned`; `db diff` reports no schema changes.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260701000007_collaboration_rpcs.sql supabase/tests/collaboration_rpcs_test.sql
git commit -m "feat(db): inbox_feed + resolve_share_link collaboration RPCs (definer, authenticated)"
```

---

### Task 2: Domain `collab` service + `createDomain` wiring

Implement `makeCollabService(ctx)` and the standalone `resolveShareLink(ctx, token)` in `packages/domain/src/collab.ts`; add `InboxItem` + `CollabService` to `types.ts` and extend `Domain`; wire the `collab` service into `createDomain` (the collab collections are `internal` and are NOT wired as generic `CollectionService`s); export from `index.ts`. The test is the domain integration test (requires the local stack + Part A tables).

**Files:**
- Create: `packages/domain/src/collab.ts`
- Edit: `packages/domain/src/types.ts`, `packages/domain/src/domain.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/collab.integration.test.ts`

**Interfaces produced:** `makeCollabService(ctx: DomainCtx): CollabService`; `resolveShareLink(ctx: DomainCtx, token: string): Promise<{entity_type, entity_id, workspace_id} | null>`; `Domain.collab`; `InboxItem`, `CollabService` types. (No generic `Domain.{comment,reaction,saved_item,mention,share_link}` CollectionServices — those collections are `internal`.)

- [ ] **Step 1: Write the failing integration test**

`packages/domain/test/collab.integration.test.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDomain, resolveShareLink } from '../src/index.ts'

const env = {
  url: process.env.SUPABASE_URL!,
  anon: process.env.SUPABASE_ANON_KEY!,
  serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY!,
}
const admin = { apikey: env.serviceRole, Authorization: `Bearer ${env.serviceRole}`, 'content-type': 'application/json' }

function serviceClient(): SupabaseClient {
  return createClient(env.url, env.serviceRole, { auth: { persistSession: false } })
}
function userClient(token: string): SupabaseClient {
  return createClient(env.url, env.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}
async function assertOk(res: Response, label: string): Promise<Response> {
  if (!res.ok) throw new Error(`${label} failed: ${res.status} ${await res.text()}`)
  return res
}
async function makeUser(): Promise<{ id: string; token: string }> {
  const email = `collab-${crypto.randomUUID()}@example.test`
  const password = 'Passw0rd!1'
  const cu = await (await assertOk(
    await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true }),
    }),
    'create user',
  )).json()
  const si = await (await assertOk(
    await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: env.anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    'sign in',
  )).json()
  return { id: cu.id as string, token: si.access_token as string }
}
async function makeWorkspace(name: string): Promise<string> {
  const rows = await (await assertOk(
    await fetch(`${env.url}/rest/v1/workspace`, {
      method: 'POST', headers: { ...admin, Prefer: 'return=representation' }, body: JSON.stringify({ name }),
    }),
    'create workspace',
  )).json()
  return rows[0].id as string
}
async function addMember(ws: string, userId: string): Promise<void> {
  await assertOk(
    await fetch(`${env.url}/rest/v1/workspace_membership`, {
      method: 'POST', headers: admin, body: JSON.stringify({ workspace_id: ws, user_id: userId, role: 'member' }),
    }),
    'add member',
  )
}

describe('collab integration', () => {
  it('comment+mention -> inbox, react/save, share resolve, atomic rollback, cross-ws isolation', async () => {
    const ws1 = await makeWorkspace('Collab WS')
    const ws2 = await makeWorkspace('Other WS')
    const author = await makeUser()
    const mentioned = await makeUser()
    await addMember(ws1, author.id)
    await addMember(ws1, mentioned.id)

    const authorDomain = createDomain({ db: userClient(author.token), userId: author.id })
    const mentionedDomain = createDomain({ db: userClient(mentioned.token), userId: mentioned.id })
    const adminDb = serviceClient()

    const note = await authorDomain.note.create({ workspace_id: ws1, title: 'Collab note', body: 'hello' })

    // comment mentioning the 2nd user; workspace_id is derived from the note
    const comment = await authorDomain.collab.comment.create({
      entityType: 'note', entityId: note.id, body: 'great work', mentions: [mentioned.id],
    })
    expect(comment.entity_id).toBe(note.id)
    expect(comment.author_id).toBe(author.id)

    const page = await authorDomain.collab.comment.listByEntity({
      workspaceId: ws1, entityType: 'note', entityId: note.id,
    })
    expect(page.items.map((c) => c.id)).toContain(comment.id)

    // the mentioned member sees it in their inbox
    const inbox = await mentionedDomain.collab.inbox({ workspaceId: ws1, tab: 'mentions' })
    expect(inbox.some((i) => i.entity_id === note.id && i.kind === 'user.mentioned')).toBe(true)

    // react + save; saved tab reflects the save
    await authorDomain.collab.react({ entityType: 'note', entityId: note.id, kind: 'like' })
    await authorDomain.collab.save({ entityType: 'note', entityId: note.id })
    const saved = await authorDomain.collab.inbox({ workspaceId: ws1, tab: 'saved' })
    expect(saved.some((i) => i.entity_id === note.id)).toBe(true)
    await authorDomain.collab.unreact({ entityType: 'note', entityId: note.id, kind: 'like' })

    // share link: raw token once; resolve returns the entity ref
    const { token } = await authorDomain.collab.createShareLink({ entityType: 'note', entityId: note.id })
    expect(typeof token).toBe('string')
    const resolved = await resolveShareLink({ db: userClient(author.token), userId: author.id }, token)
    expect(resolved).toMatchObject({ entity_type: 'note', entity_id: note.id, workspace_id: ws1 })

    // atomicity: a comment whose mention is disallowed/invalid (an unknown user id)
    // rolls back the WHOLE create — no orphan comment persists. Count under the
    // service client (RLS-bypassing) before and after the failing create.
    const before = await adminDb.from('comment').select('id').eq('entity_id', note.id)
    const beforeCount = (before.data ?? []).length
    await expect(
      authorDomain.collab.comment.create({
        entityType: 'note', entityId: note.id, body: 'bad mention', mentions: [crypto.randomUUID()],
      }),
    ).rejects.toThrow()
    const after = await adminDb.from('comment').select('id').eq('entity_id', note.id)
    expect((after.data ?? []).length).toBe(beforeCount)

    // cross-workspace isolation: an entity the author cannot read -> commenting rejects
    const foreign = await adminDb.from('note').insert({ workspace_id: ws2, title: 'Foreign', body: 'x' }).select('id').single()
    const foreignId = (foreign.data as { id: string }).id
    await expect(
      authorDomain.collab.comment.create({ entityType: 'note', entityId: foreignId, body: 'sneaky' }),
    ).rejects.toThrow(/entity not found or inaccessible/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (with the local stack up — `supabase start` beforehand):
```bash
supabase db reset && pnpm --filter @movp/domain exec vitest run collab
```
Expected: FAIL — `'"../src/index.ts"' has no exported member 'resolveShareLink'` (and `createDomain` has no `collab`).

- [ ] **Step 3: Implement `collab.ts`**

`packages/domain/src/collab.ts`:
```ts
import type { CommentRow } from './generated/types.ts'
import type { CollabService, DomainCtx, InboxItem, Page } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (id: string) => btoa(id)
const decodeCursor = (cursor: string) => atob(cursor)

// Web Crypto SHA-256 hex. Global `crypto.subtle` exists on Node >= 20 and Deno —
// resolve it at call time, never a Node-only import.
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Standalone (NOT on CollabService by contract). Surfaces call this to resolve a
// raw share token: it hashes the token and asks the DEFINER RPC for the entity ref.
export async function resolveShareLink(
  ctx: DomainCtx,
  token: string,
): Promise<{ entity_type: string; entity_id: string; workspace_id: string } | null> {
  const { data, error } = await ctx.db.rpc('resolve_share_link', { p_token_hash: await sha256Hex(token) })
  if (error) throw new Error(`domain.collab.resolveShareLink failed [${error.code ?? 'unknown'}]`)
  return (data as { entity_type: string; entity_id: string; workspace_id: string } | null) ?? null
}

export function makeCollabService(ctx: DomainCtx): CollabService {
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.collab.${op} failed [${code ?? 'unknown'}]`)
  }

  // Derive an entity's workspace from the entity row under the CALLER's RLS-bound
  // client. This doubles as an access check: an entity the user cannot read yields
  // null, so we fail loudly instead of writing an orphan collab row.
  async function workspaceOf(entityType: string, entityId: string): Promise<string> {
    const { data, error } = await ctx.db.from(entityType).select('workspace_id').eq('id', entityId).maybeSingle()
    if (error) fail('resolveEntity', error.code)
    const ws = (data as { workspace_id?: string } | null)?.workspace_id
    if (!ws) throw new Error('domain.collab: entity not found or inaccessible')
    return ws
  }

  return {
    comment: {
      async create(input) {
        // workspaceOf doubles as the access check: an entity the caller cannot read
        // yields null -> we throw before writing anything.
        const ws = await workspaceOf(input.entityType, input.entityId)
        const mentions = [...new Set(input.mentions ?? [])]
        // Single transactional RPC (SECURITY INVOKER): the comment + its mention rows
        // commit atomically under the caller's RLS. If any mention is disallowed, the
        // whole insert rolls back — no orphan comment. Do NOT split this back into a
        // comment insert + a separate mention insert (the non-atomic bug this fixes).
        const { data, error } = await ctx.db.rpc('create_comment_with_mentions', {
          ws,
          p_entity_type: input.entityType,
          p_entity_id: input.entityId,
          p_body: input.body,
          p_parent_id: input.parentId ?? null,
          p_mentions: mentions,
        })
        if (error) fail('comment.create', error.code)
        return data as CommentRow
      },

      async listByEntity(a) {
        const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
        let q = ctx.db
          .from('comment')
          .select('*')
          .eq('workspace_id', a.workspaceId)
          .eq('entity_type', a.entityType)
          .eq('entity_id', a.entityId)
          .order('id', { ascending: true })
          .limit(first + 1)
        if (a.after) q = q.gt('id', decodeCursor(a.after))
        const { data, error } = await q
        if (error) fail('comment.listByEntity', error.code)
        const rows = (data ?? []) as CommentRow[]
        const items = rows.length > first ? rows.slice(0, first) : rows
        const last = items.at(-1)
        return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
      },
    },

    async react(i) {
      const ws = await workspaceOf(i.entityType, i.entityId)
      const { error } = await ctx.db.from('reaction').insert({
        workspace_id: ws, user_id: ctx.userId, entity_type: i.entityType, entity_id: i.entityId, kind: i.kind,
      })
      if (error) fail('react', error.code)
    },

    async unreact(i) {
      const { error } = await ctx.db
        .from('reaction')
        .delete()
        .eq('user_id', ctx.userId)
        .eq('entity_type', i.entityType)
        .eq('entity_id', i.entityId)
        .eq('kind', i.kind)
      if (error) fail('unreact', error.code)
    },

    async save(i) {
      const ws = await workspaceOf(i.entityType, i.entityId)
      const { error } = await ctx.db.from('saved_item').insert({
        workspace_id: ws, user_id: ctx.userId, entity_type: i.entityType, entity_id: i.entityId,
      })
      if (error) fail('save', error.code)
    },

    async unsave(i) {
      const { error } = await ctx.db
        .from('saved_item')
        .delete()
        .eq('user_id', ctx.userId)
        .eq('entity_type', i.entityType)
        .eq('entity_id', i.entityId)
      if (error) fail('unsave', error.code)
    },

    async createShareLink(i) {
      const ws = await workspaceOf(i.entityType, i.entityId)
      const token = crypto.randomUUID() // raw token returned ONCE to the caller
      const expiresAt = i.expiresInHours
        ? new Date(Date.now() + i.expiresInHours * 3_600_000).toISOString()
        : null
      const { error } = await ctx.db.from('share_link').insert({
        workspace_id: ws,
        entity_type: i.entityType,
        entity_id: i.entityId,
        token_hash: await sha256Hex(token), // only the hash is persisted
        // Part A's share_link.scope enum is ['view']; do NOT use 'read' (CHECK violation).
        scope: 'view',
        created_by: ctx.userId,
        expires_at: expiresAt,
      })
      if (error) fail('createShareLink', error.code)
      return { token }
    },

    async inbox(a) {
      const { data, error } = await ctx.db.rpc('inbox_feed', {
        ws: a.workspaceId, tab: a.tab, lim: clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE),
      })
      if (error) fail('inbox', error.code)
      return (data ?? []) as InboxItem[]
    },
  }
}
```

- [ ] **Step 4: Extend `types.ts`**

In `packages/domain/src/types.ts`, extend the generated-types import to add `CommentRow` (the only collab row the `CollabService` contract references — `comment.create` returns it and `listByEntity` pages it) and add the interfaces. Replace the first import line:
```ts
import type { NoteCreate, NoteRow, NoteUpdate, TagCreate, TagRow, TagUpdate } from './generated/types.ts'
```
with:
```ts
import type {
  CommentRow,
  NoteCreate, NoteRow, NoteUpdate,
  TagCreate, TagRow, TagUpdate,
} from './generated/types.ts'
```
Add these interfaces (place before `export interface Domain`):
```ts
export interface InboxItem {
  kind: string
  entity_type: string
  entity_id: string
  ref_id: string
  created_at: string
  payload: Record<string, unknown>
}

export interface CollabService {
  comment: {
    create(input: {
      entityType: string
      entityId: string
      body: string
      parentId?: string
      mentions?: string[]
    }): Promise<CommentRow>
    listByEntity(a: {
      workspaceId: string
      entityType: string
      entityId: string
      first?: number
      after?: string | null
    }): Promise<Page<CommentRow>>
  }
  react(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  unreact(i: { entityType: string; entityId: string; kind: 'like' | 'dislike' }): Promise<void>
  save(i: { entityType: string; entityId: string }): Promise<void>
  unsave(i: { entityType: string; entityId: string }): Promise<void>
  createShareLink(i: { entityType: string; entityId: string; expiresInHours?: number }): Promise<{ token: string }>
  inbox(a: { workspaceId: string; tab: 'all' | 'mentions' | 'saved' | 'assigned'; first?: number }): Promise<InboxItem[]>
}
```
Then replace the existing `Domain` interface body with (the collab collections are `internal` — reached only through `collab`, NOT as generic `CollectionService`s, so they are absent here):
```ts
export interface Domain {
  note: CollectionService<NoteRow, NoteCreate, NoteUpdate>
  tag: CollectionService<TagRow, TagCreate, TagUpdate>
  search(a: SearchArgs): Promise<SearchHit[]>
  graph: GraphService
  collab: CollabService
}
```

- [ ] **Step 5: Wire `domain.ts`**

Replace the entire body of `packages/domain/src/domain.ts` with:
```ts
import type {
  NoteCreate, NoteRow, NoteUpdate,
  TagCreate, TagRow, TagUpdate,
} from './generated/types.ts'
import { makeCollabService } from './collab.ts'
import { makeCollectionService } from './collection.ts'
import { makeGraphService } from './graph.ts'
import { runSearch } from './search.ts'
import type { Domain, DomainCtx, EmbeddingProvider } from './types.ts'

export function createDomain(ctx: DomainCtx, opts: { embedder?: EmbeddingProvider } = {}): Domain {
  return {
    note: makeCollectionService<NoteRow, NoteCreate, NoteUpdate>(ctx, { table: 'note' }),
    tag: makeCollectionService<TagRow, TagCreate, TagUpdate>(ctx, { table: 'tag' }),
    // The 5 collab collections are `internal: true` (Part A): the schema-driven
    // GraphQL/MCP/CLI builders SKIP them, so they are deliberately NOT wired as
    // generic CollectionServices here. They are reached ONLY through the custom
    // `collab` service below (which uses ctx.db.from('comment')… and the
    // create_comment_with_mentions RPC internally). Wiring them generically would
    // re-expose the broken generic CRUD this fix removes.
    search: (args) => runSearch(ctx, opts.embedder, args),
    graph: makeGraphService(ctx),
    collab: makeCollabService(ctx),
  }
}
```

- [ ] **Step 6: Export from `index.ts`**

Edit `packages/domain/src/index.ts`. Add after the existing `export { runSearch } from './search.ts'` line:
```ts
export { makeCollabService, resolveShareLink } from './collab.ts'
```
Add `CollabService` and `InboxItem` to the type export block from `./types.ts` (alphabetical, alongside `CollectionService`, `Domain`, etc.):
```ts
export type {
  CollabService,
  CollectionService,
  Domain,
  DomainCtx,
  EmbeddingProvider,
  GraphService,
  InboxItem,
  ListArgs,
  Page,
  SearchArgs,
  SearchHit,
} from './types.ts'
```
And extend the generated-types re-export line to include `CommentRow` (the only collab row in the public `CollabService` contract; the other collab `*Row`/`*Create`/`*Update` types are still generated by codegen but are consumed only internally by `collab.ts`, so they need no public re-export):
```ts
export type {
  CommentRow,
  NoteCreate, NoteRow, NoteUpdate,
  TagCreate, TagRow, TagUpdate,
} from './generated/types.ts'
```

- [ ] **Step 7: Run the test + typecheck**

Run:
```bash
supabase db reset && pnpm --filter @movp/domain exec vitest run collab && pnpm --filter @movp/domain typecheck
```
Expected: PASS — `collab.integration.test.ts` (1 test) green; `tsc --noEmit` clean.

- [ ] **Step 8: Commit**
```bash
git add packages/domain
git commit -m "feat(domain): collab service (comment/mention/react/save/share/inbox) + createDomain wiring"
```

---

### Task 3: Notify worker — resolve `recipient_user_id` to an email

Generalize the `notify` branch of `packages/flows/src/flows-worker.ts`: **one recipient per notify job.** When the payload carries a singular `recipient_user_id`, resolve it to an email via the service-role admin API and send exactly once; otherwise fall back to the existing `payload.email` path (note.created). Pure unit test — no DB.

> **Fan-out is at emission time, not in the worker.** Multi-recipient events fan out by emitting **one notify job per recipient** (each idempotent via its own `idempotency_key`) — consistent with Part A's mention trigger, which emits one `user.mentioned` event (one `recipient_user_id`) per mention row, so `emit_event` already enqueues one job per recipient. The worker therefore never loops over recipients: a `recipient_user_ids[]` array + in-loop send would re-email an already-notified recipient when a later iteration fails and the job retries. Do NOT reintroduce a recipient array.

**Files:**
- Edit: `packages/flows/src/flows-worker.ts`
- Test: `packages/flows/test/flows-worker.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/flows/test/flows-worker.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationProvider } from '@movp/notifications'
import { runFlowsWorker } from '../src/flows-worker.ts'

// A fake supabase client: claim_jobs returns the given notify jobs (and [] for
// webhook), complete_job records, and auth.admin.getUserById stubs the lookup.
function fakeDb(notifyJobs: Array<Record<string, unknown>>) {
  const getUserById = vi.fn(async (id: string) => ({ data: { user: { id, email: `${id}@example.test` } }, error: null }))
  const completed: Array<Record<string, unknown>> = []
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'claim_jobs') return { data: args.job_kind === 'notify' ? notifyJobs : [], error: null }
      if (fn === 'complete_job') {
        completed.push(args)
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }),
    auth: { admin: { getUserById } },
  }
  return { db: db as unknown as SupabaseClient, completed, getUserById }
}

function fakeNotifier() {
  const sent: Array<{ to: string; subject: string; html: string }> = []
  const notifier: NotificationProvider = {
    send: vi.fn(async (m) => {
      sent.push({ to: m.to, subject: m.subject, html: m.html })
      return { id: 'e1' }
    }),
  }
  return { notifier, sent }
}

const baseJob = { kind: 'notify', attempts: 1, max_attempts: 8, status: 'running', workspace_id: 'w' }

describe('runFlowsWorker notify recipient resolution', () => {
  it('resolves recipient_user_id -> email for a user.mentioned job', async () => {
    const { db, completed, getUserById } = fakeDb([
      { ...baseJob, id: 'j1', idempotency_key: 'user.mentioned:c1',
        payload: { event: 'user.mentioned', recipient_user_id: 'u2', title: 'You were mentioned' } },
    ])
    const { notifier, sent } = fakeNotifier()
    const res = await runFlowsWorker(db, notifier, 10)
    expect(getUserById).toHaveBeenCalledWith('u2')
    // Exactly one lookup + one send: the worker does NOT loop over recipients.
    expect(getUserById).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('u2@example.test')
    expect(res.processed).toBe(1)
    expect(completed[0]).toMatchObject({ ok: true })
  })

  it('still sends to payload.email for a note.created job (existing path preserved)', async () => {
    const { db } = fakeDb([
      { ...baseJob, id: 'j2', idempotency_key: 'note.created:n1',
        payload: { event: 'note.created', email: 'owner@example.test', title: 'Hi' } },
    ])
    const { notifier, sent } = fakeNotifier()
    await runFlowsWorker(db, notifier, 10)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('owner@example.test')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/flows exec vitest run flows-worker
```
Expected: FAIL — the current worker throws `notify_missing_email` for the `user.mentioned` job (no `payload.email`), so `sent` is empty / `getUserById` never called.

- [ ] **Step 3: Implement — edit the notify branch**

In `packages/flows/src/flows-worker.ts`, add this helper just below the existing `stringField` helper:
```ts
// Resolve a user id -> email via the service-role admin API. NEVER log the email.
async function emailForUser(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error) return null
  const email = data.user?.email
  return typeof email === 'string' && email.length > 0 ? email : null
}
```
Then replace the entire `notify` for-loop body (the `for (const job of await claimDueJobs(db, 'notify', limit)) { ... }` block) with:
```ts
  for (const job of await claimDueJobs(db, 'notify', limit)) {
    try {
      const payload = job.payload
      const event = stringField(payload.event) ?? 'event'
      const title = escapeHtml(stringField(payload.title) ?? event)
      const subject = `MOVP ${event}`
      const html = `<p>${title}</p>`
      // ONE recipient per notify job. Multi-recipient events fan out at emission
      // time (one job per recipient, each with its own idempotency_key), so the
      // worker resolves + sends EXACTLY once. Do NOT loop over a recipient array:
      // a mid-loop failure marks the job failed and re-emails earlier recipients
      // on retry. There is deliberately no recipient_user_ids[] path here.
      const recipientUserId = stringField(payload.recipient_user_id)
      let to: string | null
      if (recipientUserId) {
        to = await emailForUser(db, recipientUserId)
        if (!to) throw new Error('notify_recipient_no_email')
      } else {
        // Existing single-recipient path (e.g. note.created carries payload.email).
        to = stringField(payload.email) ?? null
        if (!to) throw new Error('notify_missing_email')
      }
      await notifier.send({ to, subject, html })
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      failed++
    }
  }
```
Leave the `webhook` loop and the rest of the file unchanged. `SupabaseClient` is already imported at the top of the file.

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/flows exec vitest run flows-worker && pnpm --filter @movp/flows typecheck
```
Expected: PASS — both cases green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/flows/src/flows-worker.ts packages/flows/test/flows-worker.test.ts
git commit -m "feat(flows): notify worker resolves a single recipient_user_id to email; email fallback preserved"
```

---

### Task 4: GraphQL surface — `inbox` query + collab mutations

Add a custom `inbox` query plus `addComment`, `toggleReaction`, `toggleSave`, `createShareLink`, `resolveShareLink` mutations to `packages/graphql/src/schema.ts`, mirroring the hand-written `search` queryField. Gate the whole block behind `refs.has('comment')` so schemas without the collab collections (the test's `recursive` fixture) are unaffected.

**Files:**
- Edit: `packages/graphql/src/schema.ts`
- Test: `packages/graphql/test/collab.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/graphql/test/collab.test.ts`:
```ts
import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'

const mocks = vi.hoisted(() => ({
  commentCreate: vi.fn(async (i: { entityType: string; entityId: string; body: string }) => ({
    id: 'c1', workspace_id: 'w', entity_type: i.entityType, entity_id: i.entityId,
    body: i.body, author_id: 'u', parent_id: null, created_at: 't', updated_at: 't',
  })),
  react: vi.fn(async () => undefined),
  unreact: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
  createShareLink: vi.fn(async () => ({ token: 'raw-token' })),
  inbox: vi.fn(async () => [
    { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: { body: 'hi' } },
  ]),
  resolveShareLink: vi.fn(async () => ({ entity_type: 'note', entity_id: 'n1', workspace_id: 'w' })),
}))

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    collab: {
      comment: { create: mocks.commentCreate, listByEntity: vi.fn() },
      react: mocks.react, unreact: mocks.unreact, save: mocks.save, unsave: vi.fn(),
      createShareLink: mocks.createShareLink, inbox: mocks.inbox,
    },
  }),
  resolveShareLink: mocks.resolveShareLink,
}))

const ctx = { db: {} as never, userId: 'u' }

describe('collab GraphQL surface', () => {
  it('addComment routes to collab.comment.create with mentions', async () => {
    const res = await graphql({
      schema: buildSchema(movpSchema),
      source: 'mutation { addComment(entityType: "note", entityId: "n1", body: "hi", mentions: ["u2"]) { id entity_id } }',
      contextValue: ctx,
    })
    expect(res.errors).toBeUndefined()
    expect(mocks.commentCreate).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', body: 'hi', parentId: undefined, mentions: ['u2'] })
    expect((res.data as { addComment: { id: string } }).addComment.id).toBe('c1')
  })

  it('toggleReaction on:true calls react; on:false calls unreact', async () => {
    mocks.react.mockClear()
    mocks.unreact.mockClear()
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { toggleReaction(entityType: "note", entityId: "n1", kind: "like", on: true) }', contextValue: ctx })
    expect(mocks.react).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', kind: 'like' })
    await graphql({ schema: buildSchema(movpSchema), source: 'mutation { toggleReaction(entityType: "note", entityId: "n1", kind: "like", on: false) }', contextValue: ctx })
    expect(mocks.unreact).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', kind: 'like' })
  })

  it('inbox returns items with a stringified payload', async () => {
    const res = await graphql({ schema: buildSchema(movpSchema), source: 'query { inbox(workspaceId: "w", tab: "mentions") { kind entity_id payload } }', contextValue: ctx })
    expect(res.errors).toBeUndefined()
    expect(mocks.inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: 20 })
    const item = (res.data as { inbox: Array<{ kind: string; payload: string }> }).inbox[0]
    expect(item.kind).toBe('user.mentioned')
    expect(JSON.parse(item.payload).body).toBe('hi')
  })

  it('createShareLink returns the raw token; resolveShareLink returns the entity ref', async () => {
    const c = await graphql({ schema: buildSchema(movpSchema), source: 'mutation { createShareLink(entityType: "note", entityId: "n1") { token } }', contextValue: ctx })
    expect((c.data as { createShareLink: { token: string } }).createShareLink.token).toBe('raw-token')
    const r = await graphql({ schema: buildSchema(movpSchema), source: 'mutation { resolveShareLink(token: "raw-token") { entity_id workspace_id } }', contextValue: ctx })
    expect((r.data as { resolveShareLink: { entity_id: string } }).resolveShareLink.entity_id).toBe('n1')
    expect(mocks.resolveShareLink).toHaveBeenCalledWith({ db: ctx.db, userId: 'u' }, 'raw-token')
  })

  it('surfaces the custom collab ops but NO generic CRUD for the internal collab collections', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    // custom collab ops ARE present
    expect(sdl).toMatch(/\baddComment\(/)
    expect(sdl).toMatch(/\binbox\(/)
    expect(sdl).toMatch(/\btoggleReaction\(/)
    expect(sdl).toMatch(/\bcreateShareLink\(/)
    // the 5 collab collections are `internal` -> no generic type / query / mutation.
    // (`type Comment` DOES exist — the collab surface implements it for addComment's
    // return — but the reaction/mention/etc. object types never do.)
    expect(sdl).not.toMatch(/\bcreateComment\(/)
    expect(sdl).not.toMatch(/\bcreateReaction\(/)
    expect(sdl).not.toMatch(/\bcreateMention\(/)
    expect(sdl).not.toMatch(/type Reaction\b/)
    expect(sdl).not.toMatch(/type Mention\b/)
    expect(sdl).not.toMatch(/\bcomments\(/)
    expect(sdl).not.toMatch(/\breactions\(/)
    // note/tag stay fully surfaced
    expect(sdl).toContain('createNote(')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run collab
```
Expected: FAIL — `Cannot query field "addComment" on type "Mutation"` (the collab ops don't exist yet); the new SDL test also fails (`addComment` absent from the printed schema).

- [ ] **Step 3: Implement — edit `schema.ts`**

Update the `@movp/domain` import to add the `resolveShareLink` value and the `InboxItem` type:
```ts
import { createDomain, resolveShareLink, type CollectionService, type Domain, type InboxItem, type SearchHit } from '@movp/domain'
```
**Skip the internal collab collections in BOTH generic loops.** At the very top of the object-building loop body — the `for (const c of schema.collections as CollectionDef[]) {` that calls `ref.implement(...)` and builds `pages` + `inputs` — add:
```ts
    if (c.internal) continue
```
and add the same guard at the very top of the second `for (const c of schema.collections as CollectionDef[]) {` — the query/mutation-registration loop that registers `builder.queryField(c.name, …)`, `plural`, and `create${pascal(c.name)}`:
```ts
    if (c.internal) continue
```
This keeps `note`/`tag` fully surfaced while the five `internal: true` collab collections get **no** generic object type, `Page`, `CreateInput`, `comment`/`comments` query, or `createComment` mutation. Leave the one-line ref-creation loop `for (const c of schema.collections) refs.set(...)` UNCHANGED — `refs.has('comment')` still detects the collab collections for the guarded block below, and the `comment` objectRef it creates (but the skipped object-building loop never implements) is implemented in that block. (Pothos 4.13: an objectRef created but never implemented AND never referenced builds fine and stays out of the SDL — so `reaction`/`saved_item`/`mention`/`share_link` refs are harmless; a referenced-but-unimplemented ref throws — so `comment`, referenced by `addComment`, MUST be implemented.)

Add three object refs immediately after the `searchHit` ref definition (still inside `buildSchema`, before `const pages = new Map...`):
```ts
  const inboxItem = builder.objectRef<InboxItem>('InboxItem').implement({
    fields: (t) => ({
      kind: t.exposeString('kind'),
      entity_type: t.exposeString('entity_type'),
      entity_id: t.exposeID('entity_id'),
      ref_id: t.exposeID('ref_id'),
      created_at: t.exposeString('created_at'),
      // No JSON scalar in this schema; expose the payload as a JSON string.
      payload: t.string({ resolve: (i) => JSON.stringify(i.payload) }),
    }),
  })
  const shareLinkToken = builder.objectRef<{ token: string }>('ShareLinkToken').implement({
    fields: (t) => ({ token: t.exposeString('token') }),
  })
  const resolvedShareLink = builder
    .objectRef<{ entity_type: string; entity_id: string; workspace_id: string }>('ResolvedShareLink')
    .implement({
      fields: (t) => ({
        entity_type: t.exposeString('entity_type'),
        entity_id: t.exposeID('entity_id'),
        workspace_id: t.exposeID('workspace_id'),
      }),
    })
```
Add the collab query + mutations just before `return builder.toSchema()` (after the `search` queryField). Guarded by `refs.has('comment')` so collab-less schemas are untouched:
```ts
  // Collaboration surface — only when the collab collections are present (Part A).
  // The object-building loop SKIPPED `comment` (it is `internal: true`), so its
  // objectRef was created (the refs map is built for every collection) but never
  // implemented. `addComment` returns the Comment type, so the collab surface owns
  // and implements it here. (Pothos: a referenced-but-unimplemented ref throws at
  // build; create-then-implement-later is fine.)
  if (refs.has('comment')) {
    const commentRef = refs.get('comment')
    commentRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        entity_type: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.entity_type == null ? null : String(r.entity_type)) }),
        entity_id: t.exposeID('entity_id', { complexity: 0 }),
        body: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.body == null ? null : String(r.body)) }),
        author_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.author_id == null ? null : String(r.author_id)) }),
        parent_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.parent_id == null ? null : String(r.parent_id)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.exposeString('updated_at', { complexity: 0 }),
      }),
    })

    builder.queryField('inbox', (t: any) =>
      t.field({
        type: [inboxItem],
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          tab: t.arg.string({ required: false }),
          first: t.arg.int({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).collab.inbox({
            workspaceId: String(args.workspaceId),
            tab: (args.tab ?? 'all') as 'all' | 'mentions' | 'saved' | 'assigned',
            first: clampPageSize(args.first),
          }),
      }),
    )

    builder.mutationField('addComment', (t: any) =>
      t.field({
        type: commentRef,
        complexity: 10,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          body: t.arg.string({ required: true }),
          parentId: t.arg.id({ required: false }),
          mentions: t.arg.stringList({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).collab.comment.create({
            entityType: String(args.entityType),
            entityId: String(args.entityId),
            body: String(args.body),
            parentId: args.parentId ?? undefined,
            mentions: args.mentions ?? undefined,
          }),
      }),
    )

    builder.mutationField('toggleReaction', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          kind: t.arg.string({ required: true }),
          on: t.arg.boolean({ required: true }),
        },
        resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
          const collab = domainFrom(ctx).collab
          const i = { entityType: String(args.entityType), entityId: String(args.entityId), kind: String(args.kind) as 'like' | 'dislike' }
          if (args.on) await collab.react(i)
          else await collab.unreact(i)
          return true
        },
      }),
    )

    builder.mutationField('toggleSave', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          on: t.arg.boolean({ required: true }),
        },
        resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
          const collab = domainFrom(ctx).collab
          const i = { entityType: String(args.entityType), entityId: String(args.entityId) }
          if (args.on) await collab.save(i)
          else await collab.unsave(i)
          return true
        },
      }),
    )

    builder.mutationField('createShareLink', (t: any) =>
      t.field({
        type: shareLinkToken,
        complexity: 5,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          expiresInHours: t.arg.int({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).collab.createShareLink({
            entityType: String(args.entityType),
            entityId: String(args.entityId),
            expiresInHours: args.expiresInHours ?? undefined,
          }),
      }),
    )

    builder.mutationField('resolveShareLink', (t: any) =>
      t.field({
        type: resolvedShareLink,
        nullable: true,
        complexity: 1,
        args: { token: t.arg.string({ required: true }) },
        // resolveShareLink is a standalone domain export, not a CollabService method.
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          resolveShareLink({ db: ctx.db, userId: ctx.userId }, String(args.token)),
      }),
    )
  }
```

- [ ] **Step 4: Run the test + typecheck + the existing schema gate**

Run:
```bash
pnpm --filter @movp/graphql exec vitest run && pnpm --filter @movp/graphql typecheck
```
Expected: PASS — `collab.test.ts` (5) AND the existing `schema.test.ts` (4) + `relations.test.ts` still green (the `if (c.internal) continue` guards leave `note`/`tag` untouched, and the `refs.has('comment')` guard keeps the collab-less `recursive` fixture collab-free); `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/graphql/src/schema.ts packages/graphql/test/collab.test.ts
git commit -m "feat(graphql): inbox query + addComment/toggleReaction/toggleSave/createShareLink/resolveShareLink"
```

---

### Task 5: MCP surface — collab tools

Add `inbox.list`, `comment.add`, `reaction.toggle`, `save.toggle`, `share.create` to `packages/mcp/src/server.ts` via `registerTool`, and skip `internal` collections in the generated-tool loop so the five collab collections get **no** generic `comment.create`/`mention.create`/etc. tool. With the `if (c.internal) continue` guard placed BEFORE `service(domain, c.name)`, `buildMcpServer` resolves a service only for the non-`internal` collections (`note`/`tag`); it never demands one for the collab collections. So the test mock needs a create-bearing service only for `note`/`tag`, plus a `collab` stub for the custom tools (mirroring how `search`/`graph` are stubbed).

**Files:**
- Edit: `packages/mcp/src/server.ts`
- Edit: `packages/mcp/test/server.test.ts`

- [ ] **Step 1: Update + extend the test (red)**

Replace the whole `vi.mock('@movp/domain', …)` block and add a collab assertion. The mock now provides a CRUD stub for every collection (so build-time `service()` succeeds) plus a `collab` object:
```ts
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { schema } from '@movp/core-schema'
import { buildMcpServer } from '../src/index.ts'

const created = { id: 'n1', workspace_id: 'w', title: 'Hello' }
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 1 }])
const commentAdd = vi.fn(async () => ({ id: 'c1', body: 'hi' }))
const inbox = vi.fn(async () => [
  { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: {} },
])

function crud() {
  return {
    create: vi.fn(async () => created),
    get: vi.fn(async () => created),
    list: vi.fn(async () => ({ items: [created], nextCursor: null })),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

vi.mock('@movp/domain', () => ({
  createDomain: () => ({
    // buildMcpServer resolves service(domain, c.name) only for NON-internal
    // collections (the loop `continue`s past `internal: true` ones BEFORE calling
    // service()), so only note/tag need a create-bearing service. The 5 collab
    // collections are internal — no generic tool is registered for them; the custom
    // collab tools use `collab`.
    note: crud(),
    tag: crud(),
    search,
    graph: { link: vi.fn(async () => undefined), traverse: vi.fn() },
    collab: {
      comment: { create: commentAdd, listByEntity: vi.fn() },
      react: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      unsave: vi.fn(async () => undefined),
      createShareLink: vi.fn(async () => ({ token: 'raw-token' })),
      inbox,
    },
  }),
}))

describe('buildMcpServer', () => {
  it('lists generated tools and calls note create/search', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['note.create', 'note.search', 'tag.create']))

    const createRes = await client.callTool({ name: 'note.create', arguments: { workspace_id: 'w', title: 'Hello' } })
    expect(JSON.stringify(createRes.content)).toContain('Hello')

    const searchRes = await client.callTool({ name: 'note.search', arguments: { workspaceId: 'w', query: 'Hello' } })
    expect(JSON.stringify(searchRes.content)).toContain('n1')
  })

  it('registers and calls the collab tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['inbox.list', 'comment.add', 'reaction.toggle', 'save.toggle', 'share.create']))
    // internal collab collections get NO generic CRUD tools
    expect(names).not.toContain('comment.create')
    expect(names).not.toContain('mention.create')
    expect(names).not.toContain('reaction.create')
    expect(names).not.toContain('saved_item.create')
    expect(names).not.toContain('share_link.create')

    const addRes = await client.callTool({ name: 'comment.add', arguments: { entityType: 'note', entityId: 'n1', body: 'hi', mentions: ['u2'] } })
    expect(commentAdd).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', body: 'hi', parentId: undefined, mentions: ['u2'] })
    expect(JSON.stringify(addRes.content)).toContain('c1')

    const inboxRes = await client.callTool({ name: 'inbox.list', arguments: { workspaceId: 'w', tab: 'mentions' } })
    expect(inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: undefined })
    expect(JSON.stringify(inboxRes.content)).toContain('user.mentioned')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/mcp exec vitest run server
```
Expected: FAIL — with the trimmed mock (services only for `note`/`tag`) and no `if (c.internal) continue` guard yet, `buildMcpServer` still resolves `service(domain, c.name)` for the collab collections and throws `no domain service for collection: comment` at build, so both `it` blocks error. (Adding the guard in Step 3 makes the loop skip the collab collections, and only then does the `collab tools` assertion become the meaningful check.)

- [ ] **Step 3: Implement — edit `server.ts`**

In `packages/mcp/src/server.ts`, first skip `internal` collections in the generated-tool loop. At the very top of the `for (const c of schema.collections) {` body — BEFORE `const svc = service(domain, c.name)` — add:
```ts
    if (c.internal) continue
```
This must precede the `service(domain, c.name)` call so an internal collection never resolves a service or registers `${c.name}.create`/`.get`/`.list`/`.search`/`.link`. Then add the collab tools after that loop and before `return server`:
```ts
  // Collaboration tools (custom, non-CRUD). domain.collab is provided by createDomain.
  server.registerTool(
    'inbox.list',
    {
      title: 'List inbox',
      description: 'List the current user inbox feed for a workspace',
      inputSchema: {
        workspaceId: z.string(),
        tab: z.enum(['all', 'mentions', 'saved', 'assigned']).optional(),
        first: z.number().optional(),
      },
    },
    async ({ workspaceId, tab, first }) => text(await domain.collab.inbox({ workspaceId, tab: tab ?? 'all', first })),
  )

  server.registerTool(
    'comment.add',
    {
      title: 'Add comment',
      description: 'Add a comment to an entity, optionally mentioning users',
      inputSchema: {
        entityType: z.string(),
        entityId: z.string(),
        body: z.string(),
        parentId: z.string().optional(),
        mentions: z.array(z.string()).optional(),
      },
    },
    async ({ entityType, entityId, body, parentId, mentions }) =>
      text(await domain.collab.comment.create({ entityType, entityId, body, parentId, mentions })),
  )

  server.registerTool(
    'reaction.toggle',
    {
      title: 'Toggle reaction',
      description: 'Add or remove a like/dislike on an entity',
      inputSchema: { entityType: z.string(), entityId: z.string(), kind: z.enum(['like', 'dislike']), on: z.boolean() },
    },
    async ({ entityType, entityId, kind, on }) => {
      if (on) await domain.collab.react({ entityType, entityId, kind })
      else await domain.collab.unreact({ entityType, entityId, kind })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'save.toggle',
    {
      title: 'Toggle save',
      description: 'Save or unsave an entity for the current user',
      inputSchema: { entityType: z.string(), entityId: z.string(), on: z.boolean() },
    },
    async ({ entityType, entityId, on }) => {
      if (on) await domain.collab.save({ entityType, entityId })
      else await domain.collab.unsave({ entityType, entityId })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'share.create',
    {
      title: 'Create share link',
      description: 'Mint a share link token for an entity (returned once)',
      inputSchema: { entityType: z.string(), entityId: z.string(), expiresInHours: z.number().optional() },
    },
    async ({ entityType, entityId, expiresInHours }) =>
      text(await domain.collab.createShareLink({ entityType, entityId, expiresInHours })),
  )
```

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/mcp exec vitest run && pnpm --filter @movp/mcp typecheck
```
Expected: PASS — both `it` blocks green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/mcp/src/server.ts packages/mcp/test/server.test.ts
git commit -m "feat(mcp): collab tools (inbox.list, comment.add, reaction.toggle, save.toggle, share.create)"
```

---

### Task 6: CLI surface — `inbox` + `comment add`

Add `movp inbox --workspace <ws> [--tab]` and `movp comment add …` to `packages/cli/src/program.ts`, using `createDomain(resolveCtx()).collab`.

**Files:**
- Edit: `packages/cli/src/program.ts`
- Edit: `packages/cli/test/program.test.ts`

- [ ] **Step 1: Extend the test (red)**

In `packages/cli/test/program.test.ts`, add two shared fakes at the top (next to the existing `noteCreate`/`noteList`/`search` consts):
```ts
const commentCreate = vi.fn(async () => ({ id: 'c1', body: 'hi' }))
const inbox = vi.fn(async () => [
  { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: {} },
])
```
Add a `collab` object to the mocked `createDomain` return (alongside `note`, `tag`, `search`, `graph`):
```ts
    collab: {
      comment: { create: commentCreate, listByEntity: vi.fn() },
      react: vi.fn(), unreact: vi.fn(), save: vi.fn(), unsave: vi.fn(),
      createShareLink: vi.fn(), inbox,
    },
```
Add two test cases inside `describe('movp CLI', …)`:
```ts
  it('inbox prints the feed for a workspace/tab', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'inbox', '--workspace', 'w', '--tab', 'mentions'])
    expect(inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: undefined })
    expect(out[0]).toContain('user.mentioned')
  })

  it('comment add routes to collab.comment.create with mentions', async () => {
    const { cmd, out } = program()
    await cmd.parseAsync(['node', 'movp', 'comment', 'add', '--entity-type', 'note', '--entity-id', 'n1', '--body', 'hi', '--mention', 'u2'])
    expect(commentCreate).toHaveBeenCalledWith({ entityType: 'note', entityId: 'n1', body: 'hi', parentId: undefined, mentions: ['u2'] })
    expect(out[0]).toContain('c1')
  })

  it('does not surface generic CRUD commands for the internal collab collections', () => {
    const { cmd } = program()
    const top = cmd.commands.map((c) => c.name())
    // whole generic groups absent for the FK-relation collab collections
    expect(top).not.toContain('mention')
    expect(top).not.toContain('reaction')
    expect(top).not.toContain('saved_item')
    expect(top).not.toContain('share_link')
    // note/tag stay fully surfaced; the custom inbox + comment groups exist
    expect(top).toEqual(expect.arrayContaining(['note', 'tag', 'inbox', 'comment']))
    // the `comment` group is the CUSTOM one: only `add`, no generic create/get/list
    const comment = cmd.commands.find((c) => c.name() === 'comment')
    expect(comment?.commands.map((s) => s.name())).toEqual(['add'])
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @movp/cli exec vitest run program
```
Expected: FAIL — the three new cases fail: commander errors on the unknown `inbox` command (`error: unknown command 'inbox'`) and on the unknown `comment add` subcommand (the pre-fix generic `comment` group has `create/get/list`, not `add`), and the no-generic-CRUD assertion still sees the generic `mention`/`reaction`/`saved_item`/`share_link` groups.

- [ ] **Step 3: Implement — edit `program.ts`**

In `packages/cli/src/program.ts`, first skip `internal` collections in the generated-command loop. At the very top of the `for (const c of schema.collections as CollectionDef[]) {` body add:
```ts
    if (c.internal) continue
```
so the five `internal: true` collab collections get no generic `movp <collection> create/get/list` group — in particular no generic `movp comment` group that would collide with the custom `comment add` command below. Then add these commands after that loop and before `program.command('search <query>')`:
```ts
  program
    .command('inbox')
    .description('List the current user inbox feed')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--tab <tab>', 'all | mentions | saved | assigned', 'all')
    .option('--first <n>', 'max items', (v) => parseInt(v, 10))
    .action(async (o: { workspace: string; tab?: string; first?: number }) => {
      const domain = createDomain(resolveCtx())
      out(
        JSON.stringify(
          await domain.collab.inbox({
            workspaceId: o.workspace,
            tab: (o.tab ?? 'all') as 'all' | 'mentions' | 'saved' | 'assigned',
            first: o.first,
          }),
        ),
      )
    })

  const commentCmd = program.command('comment').description('Collaborate with comments')
  commentCmd
    .command('add')
    .requiredOption('--entity-type <type>', 'entity type, e.g. note')
    .requiredOption('--entity-id <id>', 'entity id')
    .requiredOption('--body <text>', 'comment body')
    .option('--parent <id>', 'parent comment id')
    .option('--mention <userId...>', 'user ids to mention (repeatable)')
    .action(async (o: { entityType: string; entityId: string; body: string; parent?: string; mention?: string[] }) => {
      const domain = createDomain(resolveCtx())
      out(
        JSON.stringify(
          await domain.collab.comment.create({
            entityType: o.entityType,
            entityId: o.entityId,
            body: o.body,
            parentId: o.parent,
            mentions: o.mention,
          }),
        ),
      )
    })
```

- [ ] **Step 4: Run the test + typecheck**

Run:
```bash
pnpm --filter @movp/cli exec vitest run && pnpm --filter @movp/cli typecheck
```
Expected: PASS — the three new cases (inbox, comment add, no-generic-collab-CRUD) plus the existing 4 = 7 green; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add packages/cli/src/program.ts packages/cli/test/program.test.ts
git commit -m "feat(cli): movp inbox + movp comment add"
```

---

### Task 7: End-to-end collaboration slice + static gates

Extend `scripts/slice-e2e.sh` with a collaboration slice: create a note, add a comment mentioning a second member, assert the mentioned user sees it via `inbox(tab:"mentions")`, toggle a reaction + save, create + resolve a share link, and assert a `user.mentioned` notify job carries `recipient_user_id`. Then run the full slice + the static gates.

**Files:**
- Edit: `scripts/slice-e2e.sh`

- [ ] **Step 1: Insert the collab slice**

In `scripts/slice-e2e.sh`, insert the following block immediately AFTER the `== [4] MCP: tools/list …` block (the one that greps for `note`) and BEFORE the `== [8] internal not exposed via PostgREST API ==` block. It reuses `$WS`, `$TOKEN`, `$API_URL`, `$ANON_KEY`, `$SERVICE_ROLE_KEY`, `$DB_URL`, and the existing `post_graphql` / `json_get` helpers:
```bash
echo "== [collab] define a token-scoped GraphQL helper + a 2nd member =="
post_graphql_as() {
  curl -sS "$API_URL/functions/v1/graphql" \
    -H "Authorization: Bearer $1" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d "$2"
}
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-collab2@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN2="$(
  curl -sS "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H "content-type: application/json" \
    -d '{"email":"e2e-collab2@example.com","password":"Passw0rd!1"}' | json_get access_token
)"
[ -n "$TOKEN2" ] || { echo "failed to mint 2nd token"; exit 1; }
USER2_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN2")"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER2_ID','member') on conflict do nothing;"

echo "== [collab] create a note, add a comment mentioning the 2nd user =="
NOTE="$(post_graphql "{\"query\":\"mutation(\$i:NoteCreateInput!){createNote(input:\$i){id}}\",\"variables\":{\"i\":{\"workspace_id\":\"$WS\",\"title\":\"Collab note\",\"body\":\"collab body\"}}}")"
NOTE_ID="$(echo "$NOTE" | json_get data.createNote.id)"
[ -n "$NOTE_ID" ] || { echo "collab note create failed: $NOTE"; exit 1; }
ADD="$(post_graphql "{\"query\":\"mutation{addComment(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\", body:\\\"welcome\\\", mentions:[\\\"$USER2_ID\\\"]){id entity_id}}\"}")"
echo "$ADD" | grep -q "$NOTE_ID" || { echo "addComment failed: $ADD"; exit 1; }

echo "== [collab] mentioned user sees it in inbox(mentions) =="
INBOX="$(post_graphql_as "$TOKEN2" "{\"query\":\"query{inbox(workspaceId:\\\"$WS\\\", tab:\\\"mentions\\\"){kind entity_id}}\"}")"
echo "$INBOX" | grep -q "$NOTE_ID" || { echo "inbox mentions missing note: $INBOX"; exit 1; }

echo "== [collab] toggle a reaction and a save =="
post_graphql "{\"query\":\"mutation{toggleReaction(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\", kind:\\\"like\\\", on:true)}\"}" | grep -q 'true' || { echo "toggleReaction failed"; exit 1; }
post_graphql "{\"query\":\"mutation{toggleSave(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\", on:true)}\"}" | grep -q 'true' || { echo "toggleSave failed"; exit 1; }

echo "== [collab] create + resolve a share link =="
SHARE="$(post_graphql "{\"query\":\"mutation{createShareLink(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\"){token}}\"}")"
SHARE_TOKEN="$(echo "$SHARE" | json_get data.createShareLink.token)"
[ -n "$SHARE_TOKEN" ] || { echo "createShareLink failed: $SHARE"; exit 1; }
RES="$(post_graphql "{\"query\":\"mutation{resolveShareLink(token:\\\"$SHARE_TOKEN\\\"){entity_id workspace_id}}\"}")"
echo "$RES" | grep -q "$NOTE_ID" || { echo "resolveShareLink failed: $RES"; exit 1; }

echo "== [collab] a user.mentioned notify job carries recipient_user_id =="
MENTION_JOBS="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_jobs where kind='notify' and payload->>'event'='user.mentioned' and payload ? 'recipient_user_id';")"
[ "$(echo "$MENTION_JOBS" | tr -d '[:space:]')" -ge 1 ] || { echo "no user.mentioned notify job with recipient_user_id (got $MENTION_JOBS)"; exit 1; }
```

- [ ] **Step 2: Run the full slice + static gates**

Ensure `supabase start` has run, then:
```bash
bash scripts/slice-e2e.sh && bash scripts/check-boundary.sh && node scripts/check-definer-audit.mjs
```
Expected: the script prints each `== [collab] …` step, then `slice-e2e: PASS`; boundary prints `boundary: clean`; definer-audit prints `… all definers pinned`. A failure prints the offending step's diagnostic and exits non-zero.

- [ ] **Step 3: Commit**
```bash
git add scripts/slice-e2e.sh
git commit -m "test(e2e): collaboration slice — comment/mention/inbox/reaction/save/share + notify job"
```

---

## Final reconciliation checklist

- [ ] `CollabService` in `packages/domain/src/types.ts` is byte-identical to the "Inputs consumed from Part A → CollabService interface" block (no added/renamed methods).
- [ ] `createDomain` exposes NO generic collab keys — the collab collections are `internal: true` and reached only through `collab`. The `collab` service's internal table references (`comment/reaction/saved_item/mention/share_link` via `ctx.db.from(...)` and `create_comment_with_mentions`) match Part A's collection names AND DB table names (the naming invariant). If Part A diverged, reconcile before merge.
- [ ] Every SECURITY DEFINER function in `20260701000007_collaboration_rpcs.sql` has `set search_path = ''` and is granted to `authenticated` only (`node scripts/check-definer-audit.mjs` green).
- [ ] NO generic `create<CollabCollection>` mutation / tool / command exists — the GraphQL/MCP/CLI builders each `if (c.internal) continue`, so the SDL has no `createComment`, `tools/list` has no `comment.create`, and the CLI tree has no `movp comment create`. The ONLY collab write/read paths are the custom `collab` ops, which set `author_id`/`user_id`/`workspace_id` server-side and route comment+mentions through the atomic `create_comment_with_mentions` RPC.
- [ ] `templates/` untouched (`bash scripts/check-boundary.sh` green).
- [ ] Full suite: `pnpm test` (turbo) + `bash scripts/slice-e2e.sh` green.
