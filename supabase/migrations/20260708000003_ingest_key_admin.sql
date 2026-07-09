-- C2.3 admin-facing ingest API-key management.

create or replace function public.create_ingest_key(ws uuid, label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_key text := encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;
  if length(btrim(coalesce(label, ''))) = 0 then
    raise exception 'ingest_key_label_required' using errcode = '22023';
  end if;

  insert into movp_internal.ingest_key (workspace_id, key_hash, label)
    values (ws, encode(extensions.digest(raw_key, 'sha256'), 'hex'), btrim(label))
    returning id into v_id;

  return jsonb_build_object('key_id', v_id, 'raw_key', raw_key);
end;
$$;

create or replace function public.rotate_ingest_key(key_id uuid, ws uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_key text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;

  update movp_internal.ingest_key
     set key_hash = encode(extensions.digest(raw_key, 'sha256'), 'hex')
   where id = rotate_ingest_key.key_id
     and workspace_id = ws
     and active;

  if not found then
    raise exception 'ingest_key_not_found' using errcode = 'P0001';
  end if;

  return jsonb_build_object('key_id', key_id, 'raw_key', raw_key);
end;
$$;

create or replace function public.revoke_ingest_key(key_id uuid, ws uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;

  update movp_internal.ingest_key
     set active = false
   where id = revoke_ingest_key.key_id
     and workspace_id = ws;

  if not found then
    raise exception 'ingest_key_not_found' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.list_ingest_keys(ws uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_workspace_admin(ws) then
    raise exception 'not_workspace_admin' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', k.id,
        'label', k.label,
        'active', k.active,
        'created_at', k.created_at
      )
      order by k.created_at, k.id
    )
    from movp_internal.ingest_key k
    where k.workspace_id = ws
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.create_ingest_key(uuid, text) from public, anon, authenticated;
revoke all on function public.rotate_ingest_key(uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_ingest_key(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_ingest_keys(uuid) from public, anon, authenticated;

grant execute on function public.create_ingest_key(uuid, text) to authenticated;
grant execute on function public.rotate_ingest_key(uuid, uuid) to authenticated;
grant execute on function public.revoke_ingest_key(uuid, uuid) to authenticated;
grant execute on function public.list_ingest_keys(uuid) to authenticated;
