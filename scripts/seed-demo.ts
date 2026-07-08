import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

type LocalEnv = {
  API_URL: string
  SERVICE_ROLE_KEY: string
  DB_URL: string
}

const DEMO = {
  workspaceId: '33333333-3333-3333-3333-333333333333',
  noteId: '10000000-0000-0000-0000-000000000001',
  taskId: '20000000-0000-0000-0000-000000000001',
  contentTypeId: '30000000-0000-0000-0000-000000000001',
  contentItemId: '30000000-0000-0000-0000-000000000002',
  contentRevisionId: '30000000-0000-0000-0000-000000000003',
  marketingPlanId: '40000000-0000-0000-0000-000000000001',
  campaignId: '40000000-0000-0000-0000-000000000002',
  segmentId: '50000000-0000-0000-0000-000000000001',
  segmentRuleId: '50000000-0000-0000-0000-000000000002',
  internalWebhookId: '60000000-0000-0000-0000-000000000001',
  webhookSubscriptionId: '60000000-0000-0000-0000-000000000002',
  automationRuleId: '70000000-0000-0000-0000-000000000001',
  workflowRunId: '70000000-0000-0000-0000-000000000002',
} as const

function readSupabaseEnv(): Partial<LocalEnv> {
  try {
    const out = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const cleanValue = (value: string) => value.replace(/^"|"$/g, '')
    return Object.fromEntries(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('='))
        .map((line) => {
          const eq = line.indexOf('=')
          return [line.slice(0, eq), cleanValue(line.slice(eq + 1))]
        }),
    ) as Partial<LocalEnv>
  } catch {
    return {}
  }
}

const statusEnv = readSupabaseEnv()

function requireEnv(name: keyof LocalEnv): string {
  const value = process.env[name] ?? statusEnv[name]
  if (!value) throw new Error(`missing_env:${name}`)
  return value
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function jsonLiteral(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`
}

const apiUrl = requireEnv('API_URL')
const serviceRoleKey = requireEnv('SERVICE_ROLE_KEY')
const dbUrl = requireEnv('DB_URL')
const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function upsertDemoUser(email: string, password: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { source: 'movp_demo_seed' },
  })
  if (!error && created.user) return created.user.id

  const { data: users, error: listError } = await admin.auth.admin.listUsers()
  if (listError) throw listError
  const existing = users.users.find((u) => u.email === email)
  if (!existing) throw error ?? new Error(`demo_user_missing:${email}`)
  return existing.id
}

function psql(sql: string): void {
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], {
    stdio: 'inherit',
  })
}

const ownerId = await upsertDemoUser('demo-owner@example.test', 'MovpDemo123!')
const memberId = await upsertDemoUser('demo-member@example.test', 'MovpDemo123!')

psql(`
  insert into public.workspace (id, name)
  values (${sqlLiteral(DEMO.workspaceId)}, 'MOVP Demo')
  on conflict (id) do update set name = excluded.name;

  insert into public.workspace_membership (workspace_id, user_id, role)
  values
    (${sqlLiteral(DEMO.workspaceId)}, ${sqlLiteral(ownerId)}, 'owner'),
    (${sqlLiteral(DEMO.workspaceId)}, ${sqlLiteral(memberId)}, 'member')
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  insert into public.note (id, workspace_id, title, body, status)
  values (${sqlLiteral(DEMO.noteId)}, ${sqlLiteral(DEMO.workspaceId)}, 'Welcome to MOVP', 'This local demo note is safe to edit.', 'draft')
  on conflict (id) do update set title = excluded.title, body = excluded.body, status = excluded.status;

  insert into public.task (id, workspace_id, title, start_date, due_date, status_id, priority_id, dependency_blocked)
  select ${sqlLiteral(DEMO.taskId)}, ${sqlLiteral(DEMO.workspaceId)}, 'Review the demo workspace', current_date, current_date + 7, s.id, p.id, false
  from public.task_status_option s, public.task_priority_option p
  where s.workspace_id = ${sqlLiteral(DEMO.workspaceId)}
    and s.is_default
    and p.workspace_id = ${sqlLiteral(DEMO.workspaceId)}
    and p.is_default
  limit 1
  on conflict (id) do update set title = excluded.title, due_date = excluded.due_date, status_id = excluded.status_id, priority_id = excluded.priority_id;

  insert into public.content_type (id, workspace_id, key, label, field_schema, moderation_policy, approval_policy)
  values (
    ${sqlLiteral(DEMO.contentTypeId)},
    ${sqlLiteral(DEMO.workspaceId)},
    'article',
    'Article',
    ${jsonLiteral([
      { name: 'headline', type: 'text', label: 'Headline', required: true },
      { name: 'body', type: 'richtext', label: 'Body' },
      { name: 'featured', type: 'bool', label: 'Featured' },
    ])},
    'pre',
    'single'
  )
  on conflict (id) do update set label = excluded.label, field_schema = excluded.field_schema;

  insert into public.content_item (id, workspace_id, content_type_id, slug, status, search_text, search_body)
  values (${sqlLiteral(DEMO.contentItemId)}, ${sqlLiteral(DEMO.workspaceId)}, ${sqlLiteral(DEMO.contentTypeId)}, 'welcome-article', 'draft', 'Welcome article', 'Demo article body')
  on conflict (id) do update set slug = excluded.slug, status = excluded.status, search_text = excluded.search_text, search_body = excluded.search_body;

  insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id)
  values (
    ${sqlLiteral(DEMO.contentRevisionId)},
    ${sqlLiteral(DEMO.workspaceId)},
    ${sqlLiteral(DEMO.contentItemId)},
    1,
    ${jsonLiteral({ headline: 'Welcome article', body: 'Demo article body', featured: true })},
    encode(extensions.digest('welcome-article-v1', 'sha256'), 'hex'),
    ${sqlLiteral(ownerId)}
  )
  on conflict (id) do nothing;

  update public.content_item
  set current_revision_id = ${sqlLiteral(DEMO.contentRevisionId)}
  where id = ${sqlLiteral(DEMO.contentItemId)};

  insert into public.marketing_plan (id, workspace_id, name, description, period_start, period_end, goals, owner_id, status)
  values (${sqlLiteral(DEMO.marketingPlanId)}, ${sqlLiteral(DEMO.workspaceId)}, 'MOVP Demo Marketing Plan', 'Local-only launch plan.', current_date, current_date + 30, ${jsonLiteral([{ metric: 'signups', target: 100 }])}, ${sqlLiteral(ownerId)}, 'active')
  on conflict (id) do update set name = excluded.name, description = excluded.description, goals = excluded.goals, owner_id = excluded.owner_id, status = excluded.status;

  insert into public.campaign (id, workspace_id, name, brief, start_date, end_date, owner_id, goal_metrics, priority, rank, status, marketing_plan_id)
  values (${sqlLiteral(DEMO.campaignId)}, ${sqlLiteral(DEMO.workspaceId)}, 'MOVP Demo Campaign', 'Coordinate the local demo launch.', current_date, current_date + 30, ${sqlLiteral(ownerId)}, ${jsonLiteral([{ metricKey: 'signups', targetValue: 100, unit: 'count' }])}, 'high', 1, 'active', ${sqlLiteral(DEMO.marketingPlanId)})
  on conflict (id) do update set name = excluded.name, brief = excluded.brief, owner_id = excluded.owner_id, goal_metrics = excluded.goal_metrics, status = excluded.status, marketing_plan_id = excluded.marketing_plan_id;

  insert into public.segment (id, workspace_id, name, description, owner_ref, active, mode)
  values (${sqlLiteral(DEMO.segmentId)}, ${sqlLiteral(DEMO.workspaceId)}, 'Demo Members', 'People included in the local demo.', ${sqlLiteral(ownerId)}, true, 'dynamic')
  on conflict (id) do update set name = excluded.name, description = excluded.description, active = excluded.active, mode = excluded.mode;

  insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active, description)
  values (${sqlLiteral(DEMO.segmentRuleId)}, ${sqlLiteral(DEMO.workspaceId)}, ${sqlLiteral(DEMO.segmentId)}, ${jsonLiteral({ field: 'event_type', op: 'eq', value: 'registration.completed' })}, 1, true, 'Demo registration rule')
  on conflict (id) do update set predicate = excluded.predicate, version = excluded.version, active = excluded.active, description = excluded.description;

  insert into movp_internal.webhooks (id, workspace_id, event_type, url, secret, active, managed_by)
  values (${sqlLiteral(DEMO.internalWebhookId)}, ${sqlLiteral(DEMO.workspaceId)}, 'task.completed', 'http://127.0.0.1:65535/demo-webhook', 'demo-secret-not-for-production', false, 'workflow_subscription')
  on conflict (id) do update set url = excluded.url, active = excluded.active, managed_by = excluded.managed_by;

  insert into public.webhook_subscription (id, workspace_id, event_type_id, url, filter, active, secret_set, secret_last_rotated_at, internal_webhook_id)
  select ${sqlLiteral(DEMO.webhookSubscriptionId)}, ${sqlLiteral(DEMO.workspaceId)}, et.id, 'http://127.0.0.1:65535/demo-webhook', ${jsonLiteral({ field: 'event', op: 'eq', value: 'task.completed' })}, false, true, now(), ${sqlLiteral(DEMO.internalWebhookId)}
  from public.event_type et
  where et.key = 'task.completed'
  on conflict (id) do update set active = excluded.active, filter = excluded.filter, internal_webhook_id = excluded.internal_webhook_id;

  insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config, enabled, priority)
  select ${sqlLiteral(DEMO.automationRuleId)}, ${sqlLiteral(DEMO.workspaceId)}, et.id, ${jsonLiteral({ field: 'event_type', op: 'eq', value: 'task.completed' })}, 'notify', ${jsonLiteral({ recipient_user_id: memberId })}, false, 10
  from public.event_type et
  where et.key = 'task.completed'
  on conflict (id) do update set condition = excluded.condition, action_config = excluded.action_config, enabled = excluded.enabled, priority = excluded.priority;

  do $$
  declare
    v_event_id uuid;
  begin
    select id into v_event_id
    from movp_internal.movp_events
    where trace_id = 'demo-seed'
    order by created_at asc
    limit 1;

    if v_event_id is null then
      perform public.emit_event(
        'task.completed',
        ${sqlLiteral(DEMO.workspaceId)}::uuid,
        jsonb_build_object('entity_id', ${sqlLiteral(DEMO.taskId)}, 'actor_id', ${sqlLiteral(ownerId)}),
        'demo-seed'
      );

      select id into v_event_id
      from movp_internal.movp_events
      where trace_id = 'demo-seed'
      order by created_at asc
      limit 1;
    end if;

    insert into public.workflow_run (id, workspace_id, source_event_id, event_type, matched, action_type, outcome, trace_id, automation_rule_id)
    values (${sqlLiteral(DEMO.workflowRunId)}, ${sqlLiteral(DEMO.workspaceId)}, v_event_id, 'task.completed', true, 'notify', 'skipped', 'demo-seed', ${sqlLiteral(DEMO.automationRuleId)})
    on conflict (id) do update set source_event_id = excluded.source_event_id, matched = excluded.matched, outcome = excluded.outcome, trace_id = excluded.trace_id;
  end
  $$;
`)

console.log('demo seed complete: MOVP Demo workspace, users, and sample records are ready')
