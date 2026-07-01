-- Collaboration RPCs: two SECURITY DEFINER reads (inbox_feed, resolve_share_link)
-- plus one SECURITY INVOKER write (create_comment_with_mentions, defined last).
-- movp_internal is not exposed to PostgREST, so the inbox feed that reads
-- movp_internal.movp_events must be a public SECURITY DEFINER RPC scoped inside
-- by is_workspace_member + auth.uid().

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
  -- Membership gate: a non-member or unauthenticated caller sees nothing.
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
    -- 'assigned' is a future Task seam; unknown tabs are empty.
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

-- User-facing DEFINER reads: authenticated only.
revoke all on function public.inbox_feed(uuid, text, int) from public, anon;
revoke all on function public.resolve_share_link(text) from public, anon;
grant execute on function public.inbox_feed(uuid, text, int) to authenticated;
grant execute on function public.resolve_share_link(text) to authenticated;

-- Atomic comment + mentions under caller RLS.
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

-- INVOKER write RPC: authenticated only.
revoke all on function public.create_comment_with_mentions(uuid, text, uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.create_comment_with_mentions(uuid, text, uuid, text, uuid, uuid[]) to authenticated;
