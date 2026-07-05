-- Part D — bounded, read-only predicate preview for the rule builder (custom READ RPC).
-- SECURITY DEFINER + explicit membership guard: the definer bypasses RLS, so we authorize the
-- caller against the segment's workspace ourselves. It compiles the AD-HOC predicate through the
-- SAME typed-DSL compiler public.evaluate_segment uses (a parameterized set-based query) and does
-- NOT concatenate the predicate into SQL. It returns a CAPPED count and writes nothing.
create or replace function public.preview_segment_predicate(seg_id uuid, predicate jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws  uuid;
  cnt integer;
  cap constant integer := 10000;   -- least-cap: preview is an order-of-magnitude, not an exact audience
begin
  select workspace_id into ws from public.segment where id = seg_id;
  if ws is null then
    return 0;
  end if;
  if not public.is_workspace_member(ws) then          -- definer bypasses RLS → gate explicitly
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Part C exposes EXACTLY movp_internal.segment_match_subjects(ws uuid, predicate jsonb) returns setof
  -- text — the AD-HOC evaluator that reuses Part C's compile_predicate (the SAME injection-safe compiler
  -- evaluate_segment uses). We call THAT set-returning function; we author NO new compiler, NO EXECUTE,
  -- and NO format() — the predicate is passed as a jsonb PARAMETER, never concatenated into SQL.
  select least(count(*), cap)::int into cnt
  from (
    select 1
    from movp_internal.segment_match_subjects(ws, predicate)   -- ← Part C's injection-safe ad-hoc compiler
    limit cap
  ) s;
  return coalesce(cnt, 0);
end;
$$;

revoke all on function public.preview_segment_predicate(uuid, jsonb) from public;
grant execute on function public.preview_segment_predicate(uuid, jsonb) to authenticated;

-- Part D — serialized rule-version writer for the rule builder.
-- The GraphQL layer must not read max(version)+1 and insert in application code: two
-- concurrent saves can race. Keep version assignment in the database under a per-segment
-- advisory transaction lock, and backstop it with a unique index.
alter table public.segment_rule
  drop constraint if exists segment_rule_segment_version_key;
alter table public.segment_rule
  add constraint segment_rule_segment_version_key unique (segment_id, version);

create or replace function public.create_segment_rule_version(seg_id uuid, predicate jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
  next_version numeric;
  created_id uuid;
begin
  select workspace_id into ws from public.segment where id = seg_id;
  if ws is null then
    return null;
  end if;
  if not public.is_workspace_member(ws) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(seg_id::text));
  select coalesce(max(version), 0) + 1 into next_version
    from public.segment_rule
   where segment_id = seg_id;

  insert into public.segment_rule (workspace_id, segment_id, predicate, version, active)
    values (ws, seg_id, predicate, next_version, true)
    returning id into created_id;

  return jsonb_build_object('id', created_id, 'version', next_version);
end;
$$;

revoke all on function public.create_segment_rule_version(uuid, jsonb) from public;
grant execute on function public.create_segment_rule_version(uuid, jsonb) to authenticated;
