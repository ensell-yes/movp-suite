# MOVP Stage C2 — Admin Console & Operations

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code samples verbatim — they are grounded in the real
> committed code (line-verified 2026-07-08). Precondition: **C1 merged (PR #8 `7f65eff`)**.
> This plan is bite-sized TDD, expanded from `2026-07-07-movp-stage-c-tdd-breakdown.md` (C2)
> and `2026-07-07-movp-stage-c-oss-roadmap.md` (C2 section).

**Goal:** a workspace owner/admin can administer members, ingest API keys, background jobs,
and any non-internal collection from the Astro admin UI — backed by RLS-safe, role-gated
`SECURITY DEFINER` RPCs — without ever touching psql or the service-role key.

**Architecture:** C2 adds (1) an `is_workspace_admin()` role helper mirroring the existing
`has_content_capability` precedent; (2) additive migrations with admin/member-gated RPCs
over `public.workspace_membership`, a new `movp_internal.workspace_invite`, the existing
`movp_internal.ingest_key`, and `movp_internal.movp_jobs`; (3) one bespoke `admin` domain
service; (4) hand-written GraphQL/MCP/CLI custom surfaces; (5) server-rendered Astro admin
pages mirroring `templates/frontend-astro/src/pages/workflows/*.astro`; (6) an `[admin]`
slice-e2e gate. No codegen change, no generated-file edit, no new client dependency.

**Tech stack:** Postgres 17 + pgTAP, Supabase CLI (migrations, `supabase test db`), Deno
edge (unchanged), `@movp/domain` (TS), `@movp/graphql` (Pothos/yoga), `@movp/mcp`,
`@movp/cli` (commander), Astro 6 + Cloudflare adapter, Playwright.

---

## Global Constraints (every task inherits these)

- **TDD, failing test first.** Each task adds its failing test/gate and proves the expected
  failure *before* implementation.
- **Forward-only migrations.** Last frozen migration is `20260706000001`. New C2 migrations
  are dated `20260708000001`…`20260708000005` (today is 2026-07-08; these sort strictly
  after). **Never** edit a merged migration or `20260701000002_movp_generated.sql`. Guard:
  `pnpm test:forward-only-migrations` (only status `A` allowed).
- **No codegen change.** C2 must not modify `packages/codegen/*` or regenerate
  `20260701000002_movp_generated.sql` (that needs the C4.1 generated-delta strategy, out of
  scope). The `internal` filter for the collection browser (C2.5) is applied from the
  in-memory `MovpSchema` in the GraphQL layer, **not** by altering `movp_collections`.
- **Every `SECURITY DEFINER` function:** `language … security definer set search_path = ''`,
  schema-qualify every object (`public.`, `movp_internal.`, `auth.`, `extensions.`),
  `revoke all on function … from public, anon;` then `grant execute … to authenticated`
  (or `to service_role` for privileged). The `definer-audit` gate fails any definer block
  lacking `set search_path =`. There is **no** pinned definer count to update.
- **`movp_internal` is reached only through `public` definer RPCs.** `anon`/`authenticated`
  get `42501` on direct access (pinned by `internal_access_test.sql`).
- **Role gating:** member-management + ingest-key ops are **admin-gated** (`is_workspace_admin`,
  raise `42501` otherwise). Jobs/DLQ read+replay and the generic browser are **member-gated**
  (`is_workspace_member`, matching the `replay_workflow_jobs` precedent). Reads never return
  secrets or raw payload values.
- **Client/server boundary.** `scripts/check-boundary.sh` forbids, under `templates/`, any
  import of `@movp/auth`/`@movp/domain` or the strings `service_role`/`SERVICE_ROLE_KEY`/
  `SUPABASE_SERVICE_ROLE`. Admin pages reach the backend **only** via `gqlRequest` (Bearer
  user token from `getSessionToken`). Query strings + **types only** live in
  `src/lib/admin-queries.ts`.
- **Env on workerd:** in any Astro/Worker file use `readServerEnv()` (from `src/lib/env.ts`,
  backed by `cloudflare:workers`), **never** `process.env`.
- **Per-request deps at call time:** domain services resolve `ctx.db` per request; never
  capture a client/env in module scope (workerd has no per-request module instance).
- **Observability:** C2 surfaces propagate stable, bounded error codes (`42501`, `P0001`,
  `22023`) and never log or render secrets, raw email, payload values, or raw keys. The
  existing CLI catch-all (`packages/cli/src/bin.ts`) emits CLI failures via `@movp/obs`;
  GraphQL/MCP do **not** add new per-operation obs instrumentation in C2. Frontend renders
  payload **keys** only (mirror `runs.astro` `eventSummary()`).
- **Per-task gate + one commit per task.** A task is done only when its gate passes.
  Phase done only when C2.1–C2.7 all land, `[admin]` slice green, review ≥ 9.2.

## File Structure

```text
supabase/migrations/
  20260708000001_admin_role_helper.sql     # C2.1  is_workspace_admin()
  20260708000002_member_admin.sql          # C2.2  workspace_invite + member RPCs
  20260708000003_ingest_key_admin.sql      # C2.3  admin-facing ingest-key RPCs
  20260708000004_admin_jobs.sql            # C2.4  job counts / dead-job list / replay
  20260708000005_workspace_settings.sql    # C2.6  workspace_settings RPC
supabase/tests/
  admin_role_test.sql                      # C2.1
  member_admin_test.sql                    # C2.2
  ingest_key_admin_test.sql                # C2.3
  admin_jobs_test.sql                      # C2.4
  admin_collections_test.sql              # C2.5 (generic update RLS + internal-suppression)
  workspace_settings_test.sql              # C2.6
packages/domain/src/
  admin.ts                                 # NEW makeAdminService
  types.ts                                 # MODIFY: AdminService interface + Domain.admin
  index.ts                                 # MODIFY: export makeAdminService + types
  domain.ts                                # MODIFY: admin: makeAdminService(ctx)
packages/graphql/src/schema.ts             # MODIFY: admin queries/mutations + generic update<Pascal> + collectionsMeta
packages/mcp/src/server.ts                 # MODIFY: admin.* tools
packages/cli/src/program.ts                # MODIFY: `admin` command group
templates/frontend-astro/src/
  lib/admin-queries.ts                     # NEW query strings + types (types only from @movp)
  pages/admin/index.astro                  # NEW dashboard hub
  pages/admin/members.astro                # C2.2
  pages/admin/api-keys.astro               # C2.3
  pages/admin/jobs.astro                   # C2.4
  pages/admin/collections.astro           # C2.5 list of collections
  pages/admin/collections/[name].astro    # C2.5 grid + create/edit
  pages/admin/settings.astro               # C2.6
  pages/auth/accept-invite.astro           # C2.2 invite acceptance
templates/frontend-astro/tests/e2e/
  admin.spec.ts                            # C2.2–C2.6 page states
  mock/graphql-mock.mjs                    # MODIFY: admin fixtures + operation handlers
scripts/slice-e2e.sh                       # MODIFY: [admin] section (C2.7)
```

---

## Task C2.1: `is_workspace_admin()` role helper + enforcement seed

**Files**
- Create: `supabase/migrations/20260708000001_admin_role_helper.sql`
- Create: `supabase/tests/admin_role_test.sql`

**Interfaces (produced)**
```sql
public.is_workspace_admin(ws uuid) returns boolean   -- true iff caller's membership role in ('owner','admin')
```

**Context (grounded):** `workspace_membership.role` ALREADY EXISTS
(`check (role in ('owner','admin','member'))`, default `member`) — do NOT add it. The only
membership helper today is `public.is_workspace_member(ws)`. The role-gate precedent to copy
is `public.has_content_capability(ws, cap)` in `20260701000013_cms_workflow.sql:4-21`.

**TDD steps**

- [ ] **Step 1 — write the failing pgTAP test** `supabase/tests/admin_role_test.sql`:

```sql
begin;
select plan(5);

insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'admin'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

select has_function('public', 'is_workspace_admin', array['uuid'], 'is_workspace_admin exists');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'owner is admin');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select ok(public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'admin is admin');
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select ok(not public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'member is not admin');
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd"}';
select ok(not public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'non-member is not admin');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect FAIL** (function missing):
Run: `supabase test db`
Expected: FAIL — `admin_role_test` errors `function public.is_workspace_admin(uuid) does not exist` (other 22 files still pass).

- [ ] **Step 3 — write the migration** `supabase/migrations/20260708000001_admin_role_helper.sql`
  (copy the `has_content_capability` shape — note `set search_path = ''` and the revoke/grant):

```sql
-- C2.1 admin role helper. workspace_membership.role already exists (owner/admin/member).
create or replace function public.is_workspace_admin(ws uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_membership m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;
revoke all on function public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.is_workspace_admin(uuid) to authenticated;
```

- [ ] **Step 4 — run it, expect PASS**:
Run: `supabase db reset && supabase test db`
Expected: PASS — `admin_role_test ... ok` (plan 5); all 24 files green (533 + 5 = 538 planned).

- [ ] **Step 5 — gate + commit**:
Run: `node scripts/check-definer-audit.mjs && supabase db diff` (definers pinned; diff empty)
Expected: `definer-audit: … all definers pinned`; empty diff.

```bash
git add supabase/migrations/20260708000001_admin_role_helper.sql supabase/tests/admin_role_test.sql
git commit -m "feat(admin): add is_workspace_admin role helper"
```

---

## Task C2.2: Workspace & member administration (invite → accept → role/remove)

**Files**
- Create: `supabase/migrations/20260708000002_member_admin.sql`
- Create: `supabase/tests/member_admin_test.sql`
- Create: `templates/frontend-astro/src/pages/admin/members.astro`,
  `templates/frontend-astro/src/pages/auth/accept-invite.astro`
- Modify: `packages/domain/src/{admin.ts,types.ts,index.ts,domain.ts}`,
  `packages/graphql/src/schema.ts`, `src/lib/admin-queries.ts`

**Interfaces (produced) — all `SECURITY DEFINER`, `set search_path = ''`:**
```sql
public.create_workspace(name text) returns public.workspace                 -- any authenticated; creator becomes owner
public.list_workspace_members(ws uuid) returns setof jsonb                  -- member-gated; {user_id, role, created_at}
public.invite_member(ws uuid, email text, role text) returns jsonb          -- ADMIN-gated; {invite_id, token} once
public.accept_invite(token text) returns public.workspace_membership        -- invitee (email claim must match)
public.set_member_role(ws uuid, target_user_id uuid, role text) returns public.workspace_membership  -- ADMIN; last-owner guard
public.remove_member(ws uuid, target_user_id uuid) returns void             -- ADMIN; last-owner guard
```

**Invariants (state + atomic unit):**
- `create_workspace` writes BOTH the `workspace` row AND an `owner` membership for the caller
  (atomic — one txn). Post: caller `is_workspace_admin(new ws) = true`.
- **Last-owner guard:** `set_member_role`(demote) and `remove_member` MUST fail (`raise …
  P0001`) if they would leave the workspace with zero `owner` memberships.
- Invite: `invite_member` inserts a `pending` invite + returns a one-time token (hash stored,
  raw returned once — mirror the webhook-secret pattern). `accept_invite` requires the JWT
  email claim to equal the invite email; it creates the membership and marks the invite
  `accepted` atomically; a used/expired/revoked token is rejected (`22023`/`P0001`).

**External assumption + fallback:** `accept_invite` reads the caller email via
`(auth.jwt() ->> 'email')`. *Check:* `member_admin_test.sql` sets
`request.jwt.claims = '{"sub":"…","email":"invitee@example.test"}'` and asserts a matching
accept succeeds and a mismatched email is rejected. *Fallback:* if the deployed JWT lacks an
`email` claim, `accept_invite` may instead take the invitee's `user_id` and be called by an
admin-approved link — but default to email-match (Supabase magic-link JWTs carry `email`).

**TDD steps**

- [ ] **Step 1 — failing pgTAP** `supabase/tests/member_admin_test.sql` (plan 13, complete):

```sql
begin;
select plan(13);

-- (1) owner can create a workspace; (2) creator is owner/admin
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"owner@example.test"}';
select lives_ok($$select public.create_workspace('Acme')$$, 'owner can create workspace');
create temp table _ws as select id from public.workspace where name = 'Acme' limit 1;
select ok((select public.is_workspace_admin((select id from _ws))), 'creator is owner/admin');

-- (3) admin invite returns a one-time token (capture it for the accept assertions)
create temp table _inv as
  select public.invite_member((select id from _ws), 'invitee@example.test', 'member') as r;
select ok((select r ? 'token' from _inv), 'invite returns one-time token');

-- add a plain member for the negative-gate checks (membership writes need table-owner privs)
reset role;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ((select id from _ws), 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

-- (4) a non-admin member cannot invite
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","email":"member@example.test"}';
select throws_ok(
  format($$select public.invite_member(%L, 'x@example.test', 'member')$$, (select id from _ws)),
  '42501', null, 'non-admin cannot invite');

-- (5) accept with a MISMATCHED email is denied
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"wrong@example.test"}';
select throws_ok(
  format($$select public.accept_invite(%L)$$, (select r->>'token' from _inv)),
  '42501', null, 'accept denied on email mismatch');

-- (6) accept with the MATCHING email creates the membership; (7) row is present with the invited role
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"invitee@example.test"}';
select lives_ok(
  format($$select public.accept_invite(%L)$$, (select r->>'token' from _inv)),
  'matching email accepts the invite');
reset role;
select is(
  (select role from public.workspace_membership
     where workspace_id = (select id from _ws) and user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  'member', 'invitee is now a member');

-- (8) the accepted token cannot be reused
set local role authenticated;
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"invitee@example.test"}';
select throws_ok(
  format($$select public.accept_invite(%L)$$, (select r->>'token' from _inv)),
  'P0001', null, 'accepted invite cannot be reused');

-- (9) an admin can promote a member; (10) a non-admin cannot set roles
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"owner@example.test"}';
select lives_ok(
  format($$select public.set_member_role(%L, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'admin')$$, (select id from _ws)),
  'admin promotes a member to admin');
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"invitee@example.test"}';
select throws_ok(
  format($$select public.set_member_role(%L, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member')$$, (select id from _ws)),
  '42501', null, 'non-admin cannot set roles');

-- (11) demoting and (12) removing the last owner are both rejected
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"owner@example.test"}';
select throws_ok(
  format($$select public.set_member_role(%L, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member')$$, (select id from _ws)),
  'P0001', null, 'cannot demote the last owner');
select throws_ok(
  format($$select public.remove_member(%L, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$, (select id from _ws)),
  'P0001', null, 'cannot remove the last owner');

-- (13) an admin can remove a non-owner member
select lives_ok(
  format($$select public.remove_member(%L, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$$, (select id from _ws)),
  'admin removes a non-owner member');

select * from finish();
rollback;
```

- [ ] **Step 2 — run, expect FAIL** (`function public.create_workspace(text) does not exist`):
Run: `supabase test db` → Expected: FAIL on `member_admin_test`.

- [ ] **Step 3 — write the migration** `supabase/migrations/20260708000002_member_admin.sql`.
  Key bodies (transcribe; each is `security definer set search_path = ''`):

```sql
-- pending invites live in movp_internal (closed to authenticated); RPCs are the only surface
create table if not exists movp_internal.workspace_invite (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  email        text not null,
  role         text not null default 'member' check (role in ('owner','admin','member')),
  token_hash   text not null unique,
  status       text not null default 'pending' check (status in ('pending','accepted','revoked')),
  invited_by   uuid not null,
  created_at   timestamptz not null default now()
);
alter table movp_internal.workspace_invite enable row level security; -- no policies = closed
revoke all on movp_internal.workspace_invite from anon, authenticated;
grant all on movp_internal.workspace_invite to service_role;

create or replace function public.create_workspace(name text)
returns public.workspace language plpgsql security definer set search_path = ''
as $$
declare w public.workspace;
begin
  if (select auth.uid()) is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  insert into public.workspace (name) values (create_workspace.name) returning * into w;
  insert into public.workspace_membership (workspace_id, user_id, role)
    values (w.id, (select auth.uid()), 'owner');
  return w;
end;
$$;
revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

create or replace function public.invite_member(ws uuid, email text, role text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_token text := encode(extensions.gen_random_bytes(32), 'hex'); v_id uuid;
begin
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  if role not in ('owner','admin','member') then raise exception 'bad role' using errcode = '22023'; end if;
  insert into movp_internal.workspace_invite (workspace_id, email, role, token_hash, invited_by)
    values (ws, lower(invite_member.email), invite_member.role,
            encode(extensions.digest(v_token, 'sha256'), 'hex'), (select auth.uid()))
    returning id into v_id;
  return jsonb_build_object('invite_id', v_id, 'token', v_token);
end;
$$;
revoke all on function public.invite_member(uuid, text, text) from public, anon;
grant execute on function public.invite_member(uuid, text, text) to authenticated;

create or replace function public.accept_invite(token text)
returns public.workspace_membership language plpgsql security definer set search_path = ''
as $$
declare v_inv movp_internal.workspace_invite; v_email text := lower(coalesce(auth.jwt() ->> 'email', '')); m public.workspace_membership;
begin
  select * into v_inv from movp_internal.workspace_invite
    where token_hash = encode(extensions.digest(accept_invite.token, 'sha256'), 'hex') and status = 'pending';
  if not found then raise exception 'invite not found or used' using errcode = 'P0001'; end if;
  if v_email = '' or v_email <> v_inv.email then raise exception 'invite email mismatch' using errcode = '42501'; end if;
  insert into public.workspace_membership (workspace_id, user_id, role)
    values (v_inv.workspace_id, (select auth.uid()), v_inv.role)
    on conflict (workspace_id, user_id) do update set role = excluded.role
    returning * into m;
  update movp_internal.workspace_invite set status = 'accepted' where id = v_inv.id;
  return m;
end;
$$;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;

create or replace function public.set_member_role(ws uuid, target_user_id uuid, role text)
returns public.workspace_membership language plpgsql security definer set search_path = ''
as $$
declare m public.workspace_membership;
begin
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  if role not in ('owner','admin','member') then raise exception 'bad role' using errcode = '22023'; end if;
  -- last-owner guard: demoting the final owner is forbidden
  if role <> 'owner' and (select count(*) from public.workspace_membership
       where workspace_id = ws and role = 'owner') = 1
     and exists (select 1 from public.workspace_membership
       where workspace_id = ws and user_id = set_member_role.target_user_id and role = 'owner')
  then raise exception 'cannot demote the last owner' using errcode = 'P0001'; end if;
  update public.workspace_membership set role = set_member_role.role
    where workspace_id = ws and user_id = set_member_role.target_user_id returning * into m;
  if not found then raise exception 'member not found' using errcode = 'P0001'; end if;
  return m;
end;
$$;
revoke all on function public.set_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;

create or replace function public.remove_member(ws uuid, target_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  if exists (select 1 from public.workspace_membership
       where workspace_id = ws and user_id = remove_member.target_user_id and role = 'owner')
     and (select count(*) from public.workspace_membership where workspace_id = ws and role = 'owner') = 1
  then raise exception 'cannot remove the last owner' using errcode = 'P0001'; end if;
  delete from public.workspace_membership where workspace_id = ws and user_id = remove_member.target_user_id;
end;
$$;
revoke all on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

create or replace function public.list_workspace_members(ws uuid)
returns setof jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('user_id', m.user_id, 'role', m.role, 'created_at', m.created_at)
  from public.workspace_membership m
  where m.workspace_id = ws and public.is_workspace_member(ws)
  order by m.created_at;
$$;
revoke all on function public.list_workspace_members(uuid) from public, anon;
grant execute on function public.list_workspace_members(uuid) to authenticated;
```

- [ ] **Step 4 — run, expect PASS**: `supabase db reset && supabase test db` → `member_admin_test` ok (plan 13).

- [ ] **Step 5 — domain service** (create `packages/domain/src/admin.ts`; wire in 4 spots).
  Follow the `makeWorkflowService` factory (fail/rpcRow). Add these methods (types from
  `packages/domain/src/generated/types.ts` where a table row exists):

```ts
// packages/domain/src/admin.ts (excerpt — factory style mirrors workflows.ts)
import type { DomainCtx } from './types.ts'

function fail(op: string, code?: string): never {
  throw new Error(`domain.admin.${op} failed [${code ?? 'unknown'}]`)
}
async function rpc<T>(ctx: DomainCtx, name: string, args: Record<string, unknown>, op: string): Promise<T> {
  const { data, error } = await ctx.db.rpc(name, args)
  if (error) fail(op, error.code)
  return data as T
}

export function makeAdminService(ctx: DomainCtx) {
  return {
    createWorkspace: (name: string) => rpc(ctx, 'create_workspace', { name }, 'createWorkspace'),
    listMembers: (workspaceId: string) => rpc(ctx, 'list_workspace_members', { ws: workspaceId }, 'listMembers'),
    invite: (a: { workspaceId: string; email: string; role: string }) =>
      rpc<{ invite_id: string; token: string }>(ctx, 'invite_member',
        { ws: a.workspaceId, email: a.email, role: a.role }, 'invite'),
    acceptInvite: (token: string) => rpc(ctx, 'accept_invite', { token }, 'acceptInvite'),
    setMemberRole: (a: { workspaceId: string; targetUserId: string; role: string }) =>
      rpc(ctx, 'set_member_role', { ws: a.workspaceId, target_user_id: a.targetUserId, role: a.role }, 'setMemberRole'),
    removeMember: (a: { workspaceId: string; targetUserId: string }) =>
      rpc(ctx, 'remove_member', { ws: a.workspaceId, target_user_id: a.targetUserId }, 'removeMember'),
    // C2.3/C2.4/C2.6 methods appended in later tasks
  }
}
export type AdminService = ReturnType<typeof makeAdminService>
```
  Wire: `packages/domain/src/types.ts` → add `admin: AdminService` to the `Domain` interface
  (import the type); `packages/domain/src/index.ts` → `export { makeAdminService } from './admin.ts'`
  and `export type { AdminService } from './admin.ts'`; `packages/domain/src/domain.ts` →
  add `admin: makeAdminService(ctx),` inside the `createDomain` return object.

- [ ] **Step 6 — GraphQL surface** (`packages/graphql/src/schema.ts`, custom section, mirror
  the workflows mutations at lines ~361-375). Add mutations `createWorkspace(name)`,
  `inviteMember(workspaceId, email, role)` → `{ inviteId, token }`, `acceptInvite(token)`,
  `setMemberRole(workspaceId, targetUserId, role)`, `removeMember(workspaceId, targetUserId)`,
  and query `workspaceMembers(workspaceId)`. Each resolver: `domainFrom(ctx).admin.<method>(…)`.

- [ ] **Step 7 — frontend** `src/pages/admin/members.astro` (server-rendered, mirror
  `workflows/webhooks.astro` multi-action POST pattern: `getSessionToken`, `readServerEnv`,
  `state: 'auth'|'error'|'empty'|'ok'`, `action` hidden field dispatch for
  `invite`/`set-role`/`remove`, one-time invite token rendered once via `role="status"`),
  and `src/pages/auth/accept-invite.astro` (reads `?token=`, POSTs `acceptInvite`, redirects
  `/` on success else `/login?error=…`). Add query/mutation strings + row types to
  `src/lib/admin-queries.ts` (types-only imports; **no `@movp/*` runtime import**).

- [ ] **Step 8 — e2e** `tests/e2e/admin.spec.ts` (mirror `workflows.spec.ts`): unauth → `auth-failure`;
  seeded → members table renders; invite action shows one-time token once and not on reload.
  Extend `tests/mock/graphql-mock.mjs` with `query WorkspaceMembers` + the mutations + a
  `members` fixture, and per-token scenario short-circuits.

- [ ] **Step 9 — gate + commit**:
Run: `supabase test db && node scripts/check-definer-audit.mjs && supabase db diff && pnpm --filter @movp/graphql exec vitest run schema && pnpm --filter @movp/frontend-astro typecheck && pnpm --filter @movp/frontend-astro e2e -- admin && bash scripts/check-boundary.sh`
Expected: all PASS; `boundary: clean`; empty diff.
```bash
git add supabase/migrations/20260708000002_member_admin.sql supabase/tests/member_admin_test.sql packages/domain/src packages/graphql/src/schema.ts templates/frontend-astro/src/pages/admin/members.astro templates/frontend-astro/src/pages/auth/accept-invite.astro templates/frontend-astro/src/lib/admin-queries.ts templates/frontend-astro/tests/e2e/admin.spec.ts templates/frontend-astro/tests/mock/graphql-mock.mjs
git commit -m "feat(admin): workspace + member administration"
```

---

## Task C2.3: Ingest API-key management

**Files**
- Create: `supabase/migrations/20260708000003_ingest_key_admin.sql`,
  `supabase/tests/ingest_key_admin_test.sql`
- Create: `templates/frontend-astro/src/pages/admin/api-keys.astro`
- Modify: `packages/domain/src/admin.ts`, `packages/graphql/src/schema.ts`,
  `packages/mcp/src/server.ts`, `packages/cli/src/program.ts`, `src/lib/admin-queries.ts`,
  `tests/e2e/admin.spec.ts`, `tests/mock/graphql-mock.mjs`

**Context (grounded):** `movp_internal.ingest_key(id, workspace_id, key_hash, label, active,
created_at)` exists; keys are HASHED (`encode(extensions.digest(raw,'sha256'),'hex')`, raw =
48 hex, hash = 64 hex). Only `mint_ingest_key(ws, label)` exists and it is **service-role-only**
by design ("a member must NOT self-issue"). C2.3 adds **admin-gated** create/rotate/revoke/list
so an owner/admin can manage keys from the UI. Reads never return `key_hash`.

**Invariants:** create/rotate return the raw key **exactly once**; only the hash is persisted;
`list_ingest_keys` returns `{id, label, active, created_at}` only (no hash, no raw). revoke =
`active = false` (never delete — preserves audit).

**TDD steps**

- [ ] **Step 1 — failing pgTAP** `supabase/tests/ingest_key_admin_test.sql` (plan 9, complete;
  mirrors the `segmentation_ingest_test.sql` length checks + admin/member gating):

```sql
begin;
select plan(9);
insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','member');

-- (1) admin creates a key: raw returned once, 48 hex (capture id for later ops)
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
create temp table _key as
  select public.create_ingest_key('11111111-1111-1111-1111-111111111111','ci') as r;
select is(length((select r->>'raw_key' from _key)), 48, 'raw key is 48 hex chars');

-- (2) the STORED value is the 64-hex hash, not the raw key (read internal as table owner)
reset role;
select is(
  (select length(key_hash) from movp_internal.ingest_key where id = (select (r->>'key_id')::uuid from _key)),
  64, 'stored key_hash is 64 hex chars');

-- (3) list exposes label but NEVER the hash
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(
  public.list_ingest_keys('11111111-1111-1111-1111-111111111111')::text not like '%key_hash%'
  and (public.list_ingest_keys('11111111-1111-1111-1111-111111111111') -> 0 ? 'label'),
  'list exposes label, never key_hash');

-- (4-7) a plain member is DENIED (42501) on every ingest-key op — including list (not empty-array)
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select throws_ok($$select public.create_ingest_key('11111111-1111-1111-1111-111111111111','x')$$,
  '42501', null, 'member cannot create key');
select throws_ok($$select public.list_ingest_keys('11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'member cannot list keys (denied, not empty)');
select throws_ok(
  format($$select public.rotate_ingest_key(%L, '11111111-1111-1111-1111-111111111111')$$, (select r->>'key_id' from _key)),
  '42501', null, 'member cannot rotate key');
select throws_ok(
  format($$select public.revoke_ingest_key(%L, '11111111-1111-1111-1111-111111111111')$$, (select r->>'key_id' from _key)),
  '42501', null, 'member cannot revoke key');

-- (8) admin rotate on a missing key raises P0001
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok(
  $$select public.rotate_ingest_key('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111')$$,
  'P0001', null, 'rotate on a missing key raises P0001');

-- (9) revoke deactivates the key
select public.revoke_ingest_key((select (r->>'key_id')::uuid from _key), '11111111-1111-1111-1111-111111111111');
reset role;
select is(
  (select active from movp_internal.ingest_key where id = (select (r->>'key_id')::uuid from _key)),
  false, 'revoke deactivates the key');

select * from finish();
rollback;
```

- [ ] **Step 2 — run, expect FAIL** (`create_ingest_key` missing): `supabase test db`.

- [ ] **Step 3 — migration** `20260708000003_ingest_key_admin.sql` (admin-gated; mirror
  `mint_ingest_key` hashing but gate on `is_workspace_admin`):

```sql
create or replace function public.create_ingest_key(ws uuid, label text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare raw_key text := encode(extensions.gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  insert into movp_internal.ingest_key (workspace_id, key_hash, label)
    values (ws, encode(extensions.digest(raw_key, 'sha256'), 'hex'), create_ingest_key.label)
    returning id into v_id;
  return jsonb_build_object('key_id', v_id, 'raw_key', raw_key);
end;
$$;
revoke all on function public.create_ingest_key(uuid, text) from public, anon;
grant execute on function public.create_ingest_key(uuid, text) to authenticated;

create or replace function public.rotate_ingest_key(key_id uuid, ws uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare raw_key text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  update movp_internal.ingest_key set key_hash = encode(extensions.digest(raw_key,'sha256'),'hex'), active = true
    where id = rotate_ingest_key.key_id and workspace_id = ws;
  if not found then raise exception 'key not found' using errcode = 'P0001'; end if;
  return jsonb_build_object('key_id', key_id, 'raw_key', raw_key);
end;
$$;
revoke all on function public.rotate_ingest_key(uuid, uuid) from public, anon;
grant execute on function public.rotate_ingest_key(uuid, uuid) to authenticated;

create or replace function public.revoke_ingest_key(key_id uuid, ws uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  update movp_internal.ingest_key set active = false where id = revoke_ingest_key.key_id and workspace_id = ws;
end;
$$;
revoke all on function public.revoke_ingest_key(uuid, uuid) from public, anon;
grant execute on function public.revoke_ingest_key(uuid, uuid) to authenticated;

create or replace function public.list_ingest_keys(ws uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  -- deny loudly (42501), not silently as an empty list, so "not allowed" != "no keys"
  if not public.is_workspace_admin(ws) then raise exception 'not a workspace admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', k.id, 'label', k.label, 'active', k.active, 'created_at', k.created_at) order by k.created_at)
    from movp_internal.ingest_key k where k.workspace_id = ws), '[]'::jsonb);
end;
$$;
revoke all on function public.list_ingest_keys(uuid) from public, anon;
grant execute on function public.list_ingest_keys(uuid) to authenticated;
```
  ⚠ Gotcha: `list_ingest_keys` must NEVER select `key_hash`. The pgTAP asserts the returned
  JSON has no `key_hash` key.

- [ ] **Step 4 — run, expect PASS**: `supabase db reset && supabase test db`.
- [ ] **Step 5 — domain** append to `makeAdminService`: `createIngestKey`/`rotateIngestKey`/
  `revokeIngestKey`/`listIngestKeys` (rpc wrappers, same shape as C2.2).
- [ ] **Step 6 — surfaces:** GraphQL mutations `createIngestKey`/`rotateIngestKey`/
  `revokeIngestKey` (return `{ keyId, rawKey }` / void) + query `ingestKeys(workspaceId)`;
  MCP tools `admin.ingest_key.create/rotate/revoke/list` (mirror `workflow.webhook.register`
  at server.ts:483-492, dotted name, `text(await domain.admin.…)`); CLI group
  `admin ingest-key create|rotate|revoke|list` (mirror the `workflows webhooks` group at
  program.ts:443-482).
- [ ] **Step 7 — frontend** `src/pages/admin/api-keys.astro`: mirror `workflows/webhooks.astro`
  exactly for the **one-time secret reveal** (render `rawKey` once via `role="status"`,
  strip from history with the inline `history.replaceState`, `null` on next GET).
- [ ] **Step 8 — e2e** extend `admin.spec.ts`: create-key shows the raw key once and NOT on
  reload; member scenario → keys section shows an authorization/empty state. Extend the mock.
- [ ] **Step 9 — gate + commit** (same gate set as C2.2 + `pnpm --filter @movp/mcp exec vitest run` and `pnpm --filter @movp/cli exec vitest run`):
```bash
git commit -am "feat(admin): ingest API-key management"
```

---

## Task C2.4: Jobs & DLQ operations

**Files**
- Create: `supabase/migrations/20260708000004_admin_jobs.sql`, `supabase/tests/admin_jobs_test.sql`
- Create: `templates/frontend-astro/src/pages/admin/jobs.astro`
- Modify: domain `admin.ts`, `schema.ts`, `admin-queries.ts`, `admin.spec.ts`, mock

**Context (grounded):** `movp_internal.movp_jobs` status ∈ `pending|running|done|failed|dead`
(DLQ = `dead`). No count/list RPC exists. `replay_workflow_jobs(ws, only_dead)` replays only
`kind='automate'`. `movp_internal` is closed to `authenticated`, so all three surfaces below
are **definer, member-gated** (matching `replay_workflow_jobs`).

**Invariants:** the dead-job list returns payload **keys only** (never values); replay resets
**`dead`** → `pending` (clears lease) for the workspace, optionally filtered by kind. `failed`
jobs are **left untouched** — they are still in the auto-retry pipeline and resetting them
would clobber their backoff; the DLQ view lists only `dead`, so the function name, the list,
and the replay all agree on **dead-only** (this matches the `replay_workflow_jobs` default
`only_dead=true`).

**TDD steps**

- [ ] **Step 1 — failing pgTAP** `admin_jobs_test.sql` (plan 8, complete):

```sql
begin;
select plan(8);
insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','member');

-- seed (as table owner): one DEAD job carrying a secret-bearing payload, one FAILED job
insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id, status) values
  ('webhook','k-dead','{"secret_url":"https://evil.example/leak"}','11111111-1111-1111-1111-111111111111','dead'),
  ('webhook','k-failed','{}','11111111-1111-1111-1111-111111111111','failed');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
-- (1) the dead-job listing NEVER leaks payload values
select ok(public.workspace_dead_jobs('11111111-1111-1111-1111-111111111111', 50)::text not like '%evil.example%',
  'dead-job listing does not leak payload values');
-- (2) but it DOES expose payload keys
select ok(public.workspace_dead_jobs('11111111-1111-1111-1111-111111111111', 50) -> 0 -> 'payload_keys' ? 'secret_url',
  'dead-job listing exposes payload keys');
-- (3) counts report dead=1
select is((public.workspace_job_counts('11111111-1111-1111-1111-111111111111') ->> 'dead')::int, 1, 'counts dead=1');

-- (4-6) a non-member is denied on all three surfaces
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd"}';
select throws_ok($$select public.workspace_job_counts('11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'non-member denied job counts');
select throws_ok($$select public.workspace_dead_jobs('11111111-1111-1111-1111-111111111111', 50)$$,
  '42501', null, 'non-member denied dead-job list');
select throws_ok($$select public.replay_dead_jobs('11111111-1111-1111-1111-111111111111', null)$$,
  '42501', null, 'non-member denied replay');

-- (7) a member replay resets EXACTLY the 1 dead job; (8) the failed job is left untouched (dead-only)
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.replay_dead_jobs('11111111-1111-1111-1111-111111111111', null), 1, 'replay resets exactly the 1 dead job');
reset role;
select is((select status from movp_internal.movp_jobs where idempotency_key = 'k-failed'),
  'failed', 'replay leaves failed jobs untouched (dead-only contract)');

select * from finish();
rollback;
```

- [ ] **Step 2 — run, expect FAIL** (`workspace_job_counts` missing): `supabase test db`.

- [ ] **Step 3 — migration** `20260708000004_admin_jobs.sql`:

```sql
create or replace function public.workspace_job_counts(ws uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.is_workspace_member(ws)
    then raise exception 'not a workspace member' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(status, c) from (
    select status, count(*) c from movp_internal.movp_jobs where workspace_id = ws group by status) s), '{}'::jsonb);
end;
$$;
revoke all on function public.workspace_job_counts(uuid) from public, anon;
grant execute on function public.workspace_job_counts(uuid) to authenticated, service_role;

create or replace function public.workspace_dead_jobs(ws uuid, lim int default 50)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.is_workspace_member(ws)
    then raise exception 'not a workspace member' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', j.id, 'kind', j.kind, 'attempts', j.attempts, 'last_error_code', j.last_error_code,
      'updated_at', j.updated_at,
      'payload_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(j.payload) k))
    order by j.updated_at desc)
    from (select * from movp_internal.movp_jobs
          where workspace_id = ws and status = 'dead' order by updated_at desc
          limit least(greatest(lim,1),200)) j), '[]'::jsonb);
end;
$$;
revoke all on function public.workspace_dead_jobs(uuid, int) from public, anon;
grant execute on function public.workspace_dead_jobs(uuid, int) to authenticated, service_role;

create or replace function public.replay_dead_jobs(ws uuid, job_kind text default null)
returns int language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.is_workspace_member(ws)
    then raise exception 'not a workspace member' using errcode = '42501'; end if;
  update movp_internal.movp_jobs
     set status='pending', next_run_at=now(), locked_by=null, locked_at=null, lease_expires_at=null, updated_at=now()
   where workspace_id = ws and status = 'dead'
     and (replay_dead_jobs.job_kind is null or kind = replay_dead_jobs.job_kind);
  get diagnostics n = row_count; return n;
end;
$$;
revoke all on function public.replay_dead_jobs(uuid, text) from public, anon;
grant execute on function public.replay_dead_jobs(uuid, text) to authenticated, service_role;
```
  ⚠ Gotcha: keep `workspace_dead_jobs` payload-keys-only — the `jsonb_object_keys` subselect
  emits keys; never `select payload`. The pgTAP `not like '%evil.example%'` pins this.

- [ ] **Step 4 — run, expect PASS**; **Step 5 — domain** `jobCounts`/`deadJobs`/`replayDeadJobs`;
  **Step 6 — GraphQL** query `jobCounts`/`deadJobs`, mutation `replayDeadJobs`; **Step 7 —**
  `admin/jobs.astro` (single-action replay button per `runs.astro:85-89` + counts + dead-job
  table rendering `payload_keys` only — mirror `runs.astro` redaction); **Step 8 — e2e**
  asserts counts render, replay shows a notice, and the leaked-value string never appears in
  the DOM (mirror `workflows.spec.ts:59-73`).
- [ ] **Step 9 — gate + commit** `feat(admin): jobs and DLQ operations`.

---

## Task C2.5: Generic collection browser

**Files**
- Modify: `packages/graphql/src/schema.ts` (add `collectionsMeta` query + generic
  `update<Pascal>` mutation), `src/lib/admin-queries.ts`
- Create: `templates/frontend-astro/src/pages/admin/collections.astro`,
  `templates/frontend-astro/src/pages/admin/collections/[name].astro`,
  `supabase/tests/admin_collections_test.sql`
- Modify: `admin.spec.ts`, `tests/mock/graphql-mock.mjs`

**Context (grounded):** `movp_collections`/`movp_fields` are globally readable to
`authenticated` but have **no `internal` column and no RLS** — so the `internal` filter MUST
come from the in-memory `MovpSchema` in the GraphQL layer (which already does
`if (c.internal) continue`). Generic GraphQL exposes `get`/`list`/`create` per non-internal
collection but **no generic `update`**. The generated per-collection RLS is
`<name>_rw for all … using/with check (is_workspace_member(workspace_id))` — so a member
UPDATE is already permitted; adding a generic `update<Pascal>` mutation needs **no migration**.

**TDD steps**

- [ ] **Step 1a — failing GraphQL shape test** (`packages/graphql/test/schema.test.ts`, the
  `test:graphql-shape` suite): assert the built schema HAS a `collectionsMeta` query and an
  `updateNote` mutation, and does NOT expose `updateTask` (task is `internal`).
Run: `pnpm --filter @movp/graphql exec vitest run schema` → Expected: FAIL (no `collectionsMeta`/`updateNote`).

- [ ] **Step 1b — failing pgTAP** `supabase/tests/admin_collections_test.sql` (plan 4, complete)
  — proves the generic `<name>_rw` policy already permits a member UPDATE (so no migration is
  needed) and that a foreign-workspace member cannot:

```sql
begin;
select plan(4);
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1'),
  ('22222222-2222-2222-2222-222222222222','W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','member'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','member');
-- seed a note in W1 (title is required on `note`); table-owner insert bypasses RLS
insert into public.note (id, workspace_id, title) values
  ('dd000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','original');

-- (1) a member CAN update a note in their own workspace (the generated `note_rw` policy is `for all`)
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
update public.note set title = 'edited' where id = 'dd000000-0000-0000-0000-000000000001';
reset role;
select is((select title from public.note where id = 'dd000000-0000-0000-0000-000000000001'),
  'edited', 'member updates a note in their own workspace');

-- (2) a member of ANOTHER workspace cannot update it (RLS matches 0 rows -> unchanged)
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
update public.note set title = 'hacked' where id = 'dd000000-0000-0000-0000-000000000001';
reset role;
select is((select title from public.note where id = 'dd000000-0000-0000-0000-000000000001'),
  'edited', 'foreign-workspace member cannot update the note');

-- (3)/(4) both collections exist in the metadata registry; internal suppression is enforced
-- in the GraphQL layer (pinned by the schema.test in Step 1a), not by movp_collections
select ok((select count(*) from public.movp_collections where name = 'note') = 1, 'note is in metadata');
select ok((select count(*) from public.movp_collections where name = 'task') = 1,
  'task is in metadata (API suppression is a GraphQL-layer concern, pinned in schema.test)');

select * from finish();
rollback;
```

- [ ] **Step 2 — implement in `schema.ts`:**
  - `collectionsMeta` query returning, from the in-memory schema,
    `schema.collections.filter(c => !c.internal).map(c => ({ name, label, labelPlural, fields:
    Object.entries(c.fields).filter(([,f]) => f.type !== 'relation').map(...) }))` — a pure
    schema read, no DB, no secrets.
  - In the existing generic mutation loop (`schema.ts:378-420`, guarded by
    `if (c.internal) continue`), add alongside `create<Pascal>` a
    `update<Pascal>(id: ID!, input: <Pascal>Input!)` resolver → `service(domain, c.name).update(args.id, args.input)`.
    Reuse the existing `<Pascal>Input` (edit form pre-fills current values before submit).
  ⚠ Gotcha 1: keep the `if (c.internal) continue` guard on the update mutation too, or internal
    collections leak a write surface.
  ⚠ Gotcha 2: strip `id` and `workspace_id` from the patch before `service.update` — a generic
    edit must not rewrite a row's id or move it across workspaces:
    `const { id: _i, workspace_id: _w, ...patch } = args.input; return service(domain, c.name).update(args.id, patch)`.
    **RLS does NOT catch this move**: a user who belongs to BOTH W1 and W2 passes `using`
    (old ws = W1) AND `with check` (new ws = W2), so the row would relocate. The resolver strip
    is the ONLY guard — it MUST be pinned by the resolver-level test in Step 1c below, NOT by a
    pgTAP RLS test (pgTAP cannot exercise a GraphQL resolver's argument sanitization; the
    Step 1b pgTAP only proves the underlying table RLS, not the strip).

- [ ] **Step 1c — failing resolver test** in `packages/graphql/test/schema.test.ts` (pins
  Gotcha 2). Use the established `vi.mocked(createDomain)` spy pattern (as the CMS asset-ctx
  tests did): mock `@movp/domain` so `note.update` is a spy; execute the mutation
  `updateNote(id: "dd000000-0000-0000-0000-000000000001", input: { workspace_id: "22222222-2222-2222-2222-222222222222", title: "edited" })`
  against the built schema; assert the spy was called with `("dd000000-…", { title: "edited" })`
  — i.e. **no `workspace_id` and no `id` in the patch**.
Run: `pnpm --filter @movp/graphql exec vitest run schema`
Expected: FAIL — the resolver passes `args.input` through unstripped, so the spy sees
`{ workspace_id, title }`. Passes only once Gotcha 2's strip is implemented.

- [ ] **Step 3 — run, expect PASS** on the shape test (1a), the RLS pgTAP (1b via
  `supabase test db`), and the resolver strip test (1c).

- [ ] **Step 4 — frontend.** `admin/collections.astro`: list `collectionsMeta` (links to each).
  `admin/collections/[name].astro`: read `<name>s(workspaceId, first)` into a metadata-driven
  grid (columns from `collectionsMeta.fields`), a create form, and an edit form (pre-fills a
  row, submits `update<Pascal>`). All server-rendered POST forms (mirror `webhooks.astro`).
  Add the query/mutation strings + types to `admin-queries.ts`. ⚠ Boundary: build the field
  list from the `collectionsMeta` GraphQL response, NOT by importing `@movp/core-schema`.

- [ ] **Step 5 — e2e** (`admin.spec.ts`): browse `note`, create then edit a note (value
  changes), and assert the collections list does NOT include `task` (internal). Extend mock
  with `collectionsMeta` + `updateNote`.

- [ ] **Step 6 — gate + commit**:
Run: `pnpm --filter @movp/graphql exec vitest run schema && supabase test db && pnpm --filter @movp/frontend-astro e2e -- admin && bash scripts/check-boundary.sh`
```bash
git commit -am "feat(admin): generic collection browser"
```

---

## Task C2.6: Settings & retention status

**Files**
- Create: `supabase/migrations/20260708000005_workspace_settings.sql`,
  `supabase/tests/workspace_settings_test.sql`, `templates/frontend-astro/src/pages/admin/settings.astro`
- Modify: domain `admin.ts`, `schema.ts`, `admin-queries.ts`, `admin.spec.ts`, mock

**Context:** `workspace` has no GraphQL surface (it is a tenancy table, not a config-first
collection). Retention (`prune_internal_retention`) is a deploy-time schedule with no DB
state, so "status" is advisory. Provide one member-gated summary RPC.

**TDD steps**

- [ ] **Step 1 — failing pgTAP** `supabase/tests/workspace_settings_test.sql` (plan 5, complete):

```sql
begin;
select plan(5);
insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111','Acme');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('11111111-1111-1111-1111-111111111111','cccccccc-cccc-cccc-cccc-cccccccccccc','member');

select has_function('public','workspace_settings',array['uuid'],'workspace_settings exists');

-- (2)/(3) an owner reads name + member_count for their own workspace
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.workspace_settings('11111111-1111-1111-1111-111111111111') ->> 'name', 'Acme', 'settings returns name');
select is((public.workspace_settings('11111111-1111-1111-1111-111111111111') ->> 'member_count')::int, 2, 'settings returns member count');

-- (4) a non-member is denied
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd"}';
select throws_ok($$select public.workspace_settings('11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'non-member denied settings');

-- (5) a plain member (non-admin) CAN read settings (member-gated, not admin-gated)
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((public.workspace_settings('11111111-1111-1111-1111-111111111111') ->> 'member_count')::int, 2,
  'a non-admin member can read settings');

select * from finish();
rollback;
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — migration** `20260708000005_workspace_settings.sql`:

```sql
create or replace function public.workspace_settings(ws uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_workspace_member(ws) then raise exception 'not a workspace member' using errcode = '42501'; end if;
  return jsonb_build_object(
    'workspace_id', ws,
    'name', (select w.name from public.workspace w where w.id = ws),
    'member_count', (select count(*) from public.workspace_membership m where m.workspace_id = ws));
end;
$$;
revoke all on function public.workspace_settings(uuid) from public, anon;
grant execute on function public.workspace_settings(uuid) to authenticated;
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — domain** `settings(workspaceId)`; **GraphQL** query `workspaceSettings(workspaceId)`.
- [ ] **Step 6 — frontend** `admin/settings.astro`: workspace name + member count, a link to
  the event catalog (`/workflows/rules`), and a **static retention advisory** ("Retention
  prune is a deploy-time pg_cron schedule — see `docs/`; not managed from the UI."). Add to
  `admin/index.astro` hub links: Members, API Keys, Jobs, Collections, Settings.
- [ ] **Step 7 — e2e** settings renders name + member count.
- [ ] **Step 8 — gate + commit** `feat(admin): settings and retention status`.

---

## Task C2.7: `[admin]` slice + phase close

**Files**
- Modify: `scripts/slice-e2e.sh` (add `[admin]` section), `.github/workflows/ci.yml` if the
  admin e2e is not already covered by the `frontend-ux` job (`pnpm --filter … e2e` runs the
  whole Playwright suite, so `admin.spec.ts` is picked up automatically — verify).

**TDD steps**

- [ ] **Step 1 — add a failing `[admin]` slice section** to `scripts/slice-e2e.sh` that, against
  the live local stack, drives the real RPC chain end-to-end (mirror the existing slice
  sections): as an owner token — `create_workspace` → `invite_member` → `accept_invite`
  (second user) → `create_ingest_key` (assert 48-hex raw once) → seed+`workspace_job_counts`/
  `replay_dead_jobs` → generic `note` create+`updateNote`. Assert each step's success shape.
  Keep the existing edge-runtime cleanup behavior (opt-in `pkill` only in CI /
  `MOVP_CLEAN_EDGE_RUNTIME=1`).
Run: `bash scripts/slice-e2e.sh` → Expected: FAIL at the new `[admin]` section until C2.1–C2.6 are merged.

- [ ] **Step 2 — make it pass** (all prior tasks landed).
Run: `bash scripts/slice-e2e.sh` → Expected: `slice-e2e: PASS` including `[admin]`.

- [ ] **Step 3 — full gate + commit**:
Run:
```sh
pnpm install --frozen-lockfile
pnpm build && pnpm test && pnpm typecheck
supabase db reset && supabase test db && supabase db diff
node scripts/check-definer-audit.mjs
pnpm test:forward-only-migrations
pnpm test:graphql-shape && pnpm test:redaction && pnpm test:jobs && pnpm test:event-catalog
bash scripts/check-boundary.sh
pnpm --filter @movp/frontend-astro e2e
bash scripts/slice-e2e.sh
```
Expected: all PASS; `supabase test db` plan total = 533 base + the C2 files
(admin_role 5 + member_admin 13 + ingest_key_admin 9 + admin_jobs 8 + admin_collections 4 +
workspace_settings 5 = 44) → **577 across 29 files**.
```bash
git commit -am "test(admin): [admin] slice-e2e gate"
```

- [ ] **Step 4 — open PR, get CI green, request review ≥ 9.2.** Update the Stage C status
  table in `docs/superpowers/plans/README.md` (C2 → ✅ MERGED) and the Monday board (C2 +
  C2.1–C2.7 → Done) in the same PR / on merge.

---

## Cross-cutting acceptance criteria (verify before requesting review)

- **Correctness:** every RPC's admin-vs-member gate matches this plan (admin: invite/role/
  remove, ingest-key create/rotate/revoke/list; member: jobs, generic browse, settings).
  spec ↔ migration ↔ pgTAP agree.
- **Safety:** no secret/raw payload leaves a read RPC (ingest-key list has no `key_hash`;
  dead-job list is payload-keys-only — both pinned by pgTAP `not like`/`? key` assertions).
  `movp_internal.workspace_invite` closed to authenticated. The generic `update<Pascal>`
  resolver strips `id`/`workspace_id` so a dual-workspace member cannot relocate a row (RLS
  can't catch this — pinned by the C2.5 Step 1c **resolver** test, not pgTAP). Boundary grep
  clean (no `@movp/domain|auth`/`service_role` under `templates/`).
- **Reliability:** last-owner guard proven (demote/remove → `P0001`); invite token single-use
  (accepted invite can't be reused); every definer has `set search_path = ''`.
- **Observability:** every RPC raises **stable, bounded error codes** — `42501`
  (unauthorized), `P0001` (invariant: last-owner / not-found / used-invite), `22023` (bad arg)
  — which propagate as typed GraphQL/MCP/CLI errors (`gqlRequest` maps 401/403 → `auth_error`).
  The existing CLI obs catch-all (`packages/cli/src/bin.ts` `emit`) covers CLI failures. **No
  new per-operation `@movp/obs` instrumentation is added:** `@movp/graphql` and `@movp/mcp` do
  not emit per-op today (verified — only CLI does), so adding it is a cross-cutting
  observability change out of scope for C2 (track it as its own task if wanted). Reads never
  log secrets or payload values (pinned by the keys-only pgTAP in C2.3/C2.4).
- **Performance:** list/count RPCs bound rows (`least(lim,200)`); pages request `first ≤ 100`.
- **Simplicity/Usability:** server-rendered POST forms (no new island/api-route unless a page
  needs interactivity); one-time-secret UX mirrors `webhooks.astro`; a11y states
  (`auth-failure`/`error`/`empty`) reused; `[admin]` slice proves the operator path.

## Self-check (author, satisfied)
1. Every state-changing RPC names its pre/post invariant + atomic unit (create_workspace,
   invite/accept, last-owner guard). ✅
2. Every verification step is a command with expected output. ✅
3. In-scope items are load-bearing for "operator can administer from the UI"; the docs-site,
   full RBAC matrix, field-level permissions, and audit-log viewer are Deferred (C4/later). ✅
4. Single source of truth: role gating defined once (`is_workspace_admin`, C2.1) and reused. ✅
5. External assumption (JWT `email` claim for `accept_invite`) carries a check + fallback. ✅
6. Load-bearing behavior (secret one-time, keys-only, last-owner, admin gate) has
   positive+negative pgTAP. ✅
7. Preconditions written as preconditions (C1 merged; C2.1 before C2.2/C2.3). ✅
8. Migration numbering + no-codegen-change constraint stated; only additive `A` migrations. ✅
9. Cross-cutting hardening (untrusted-input bounds on list limits; no secret in logs; internal
   trust boundary) spelled out with pinning tests. ✅
