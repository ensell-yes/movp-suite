create table if not exists movp_internal.movp_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  workspace_id uuid references public.workspace(id) on delete cascade,
  payload jsonb not null default '{}',
  trace_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists movp_internal.webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  event_type text not null,
  url text not null,
  secret text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table movp_internal.movp_events enable row level security;
alter table movp_internal.webhooks enable row level security;
revoke all on movp_internal.movp_events from anon, authenticated;
revoke all on movp_internal.webhooks from anon, authenticated;
grant all on movp_internal.movp_events to service_role;
grant all on movp_internal.webhooks to service_role;

create or replace function public.enqueue_job(job_kind text, idem_key text, payload jsonb, ws uuid)
returns void language sql security definer set search_path = '' as $$
  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values (job_kind, idem_key, payload, ws)
  on conflict (kind, idempotency_key) do nothing;
$$;

create or replace function public.claim_jobs(job_kind text, lim int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare claimed jsonb;
begin
  with updated as (
    update movp_internal.movp_jobs j
       set status = 'running',
           locked_by = coalesce(current_setting('application_name', true), 'rpc'),
           locked_at = now(),
           lease_expires_at = now() + interval '5 minutes',
           attempts = j.attempts + 1,
           updated_at = now()
     where j.id in (
       select c.id
         from movp_internal.movp_jobs c
        where c.kind = job_kind
          and ((c.status in ('pending','failed') and c.next_run_at <= now())
               or (c.status = 'running' and c.lease_expires_at < now()))
        order by c.next_run_at
        for update skip locked
        limit lim
     )
     returning j.id, j.kind, j.idempotency_key, j.payload, j.attempts, j.max_attempts,
               j.status, j.workspace_id, j.locked_by, j.locked_at, j.lease_expires_at
  )
  select coalesce(jsonb_agg(to_jsonb(updated)), '[]'::jsonb) into claimed from updated;
  return claimed;
end;
$$;

create or replace function public.complete_job(job_id uuid, ok boolean, err_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j movp_internal.movp_jobs;
begin
  select * into j from movp_internal.movp_jobs where id = job_id;
  if not found then return; end if;
  if ok then
    update movp_internal.movp_jobs set status='done', last_error_code=null, updated_at=now() where id=job_id;
  elsif j.attempts >= j.max_attempts then
    update movp_internal.movp_jobs set status='dead', last_error_code=err_code, updated_at=now() where id=job_id;
  else
    update movp_internal.movp_jobs
       set status='failed',
           last_error_code=err_code,
           next_run_at = now() + (interval '1 second' * power(2, j.attempts)),
           updated_at=now()
     where id=job_id;
  end if;
end;
$$;

create or replace function public.dead_job(job_id uuid, err_code text)
returns void language sql security definer set search_path = '' as $$
  update movp_internal.movp_jobs
     set status='dead', last_error_code=err_code, updated_at=now()
   where id=job_id;
$$;

create or replace function public.replay_jobs(job_kind text, only_dead boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update movp_internal.movp_jobs
     set status='pending', next_run_at=now(), locked_by=null, locked_at=null, lease_expires_at=null, updated_at=now()
   where (job_kind is null or kind = job_kind)
     and (case when only_dead then status='dead' else status in ('dead','failed') end);
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.reindex_collection(coll text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int := 0;
begin
  if coll = 'note' then
    insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    select 'embed',
           'note:' || nt.id::text || ':body:' || encode(extensions.digest(coalesce(nt.body,''),'sha256'),'hex'),
           jsonb_build_object('source_table','note','source_id',nt.id,'field','body',
             'content_hash', encode(extensions.digest(coalesce(nt.body,''),'sha256'),'hex')),
           nt.workspace_id
      from public.note nt
      on conflict (kind, idempotency_key) do nothing;
    get diagnostics n = row_count;
  end if;
  return n;
end;
$$;

create or replace function public.replace_search_chunks(
  src_table text, src_id uuid, src_field text, ws uuid, hash text, chunks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.search_chunk
   where source_table = src_table and source_id = src_id and field = src_field;

  insert into public.search_chunk
    (workspace_id, source_table, source_id, field, chunk_index, content, embedding, content_hash)
  select ws, src_table, src_id, src_field, r.chunk_index, r.content, r.embedding::extensions.vector(384), hash
    from jsonb_to_recordset(chunks) as r(chunk_index int, content text, embedding text);
end;
$$;

create or replace function public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into movp_internal.movp_events (type, workspace_id, payload, trace_id)
  values (ev_type, ws, payload, coalesce(trace, gen_random_uuid()::text));

  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values ('notify', ev_type || ':' || coalesce(payload->>'id', gen_random_uuid()::text),
          payload || jsonb_build_object('event', ev_type), ws)
  on conflict (kind, idempotency_key) do nothing;

  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  select 'webhook',
         ev_type || ':' || coalesce(payload->>'id','') || ':' || w.id::text,
         payload || jsonb_build_object('event', ev_type, 'url', w.url, 'secret', w.secret),
         ws
    from movp_internal.webhooks w
   where w.workspace_id = ws and w.event_type = ev_type and w.active
  on conflict (kind, idempotency_key) do nothing;
end;
$$;

create or replace function public.register_webhook(ws uuid, ev_type text, hook_url text, hook_secret text)
returns void language sql security definer set search_path = '' as $$
  insert into movp_internal.webhooks (workspace_id, event_type, url, secret)
  values (ws, ev_type, hook_url, hook_secret);
$$;

create or replace function public.note_created_emit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.emit_event(
    'note.created',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'title', new.title),
    gen_random_uuid()::text
  );
  return new;
end;
$$;

drop trigger if exists note_created_emit_event_tg on public.note;
create trigger note_created_emit_event_tg
  after insert on public.note
  for each row execute function public.note_created_emit_event();

revoke all on function public.enqueue_job(text,text,jsonb,uuid) from public, anon, authenticated;
revoke all on function public.claim_jobs(text,int) from public, anon, authenticated;
revoke all on function public.complete_job(uuid,boolean,text) from public, anon, authenticated;
revoke all on function public.dead_job(uuid,text) from public, anon, authenticated;
revoke all on function public.replay_jobs(text,boolean) from public, anon, authenticated;
revoke all on function public.reindex_collection(text) from public, anon, authenticated;
revoke all on function public.replace_search_chunks(text,uuid,text,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.emit_event(text,uuid,jsonb,text) from public, anon, authenticated;
revoke all on function public.register_webhook(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.note_created_emit_event() from public, anon, authenticated;

grant execute on function public.enqueue_job(text,text,jsonb,uuid) to service_role;
grant execute on function public.claim_jobs(text,int) to service_role;
grant execute on function public.complete_job(uuid,boolean,text) to service_role;
grant execute on function public.dead_job(uuid,text) to service_role;
grant execute on function public.replay_jobs(text,boolean) to service_role;
grant execute on function public.reindex_collection(text) to service_role;
grant execute on function public.replace_search_chunks(text,uuid,text,uuid,text,jsonb) to service_role;
grant execute on function public.emit_event(text,uuid,jsonb,text) to service_role;
grant execute on function public.register_webhook(uuid,text,text,text) to service_role;
