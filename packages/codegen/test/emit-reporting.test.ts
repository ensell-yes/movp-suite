import { schema } from '@movp/core-schema'
import type { CollectionDef } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { emitReportingSql, emitReportingViewSql } from '../src/emit-reporting.ts'

const sql = emitReportingSql(schema)

describe('emitReportingSql (C4a.2)', () => {
  it('creates the reporting schema with usage grants', () => {
    expect(sql).toContain('create schema if not exists reporting;')
    expect(sql).toContain('grant usage on schema reporting to authenticated, service_role;')
  })

  it('emits one security-invoker view per collection with reporting metadata', () => {
    expect((sql.match(/create or replace view reporting\.v_/g) ?? []).length).toBe(26)
    expect((sql.match(/with \(security_invoker = true\)/g) ?? []).length).toBe(26)
  })

  it('selects the campaign metric star-schema columns in declaration order', () => {
    expect(sql).toContain(
      'create or replace view reporting.v_campaign_metric\n' +
        'with (security_invoker = true) as\n' +
        'select id, workspace_id, campaign_id, deliverable_id, channel_id, metric_key, value, unit, measured_at, created_at, updated_at\n' +
        'from public.campaign_metric;',
    )
  })

  it('maps the workflow run FK dimension and keeps enum dimensions', () => {
    expect(sql).toContain(
      'create or replace view reporting.v_workflow_run\n' +
        'with (security_invoker = true) as\n' +
        'select id, workspace_id, event_type, automation_rule_id, action_type, outcome, created_at, updated_at\n' +
        'from public.workflow_run;',
    )
  })

  it('omits workspace_id for the global event type catalog', () => {
    expect(sql).toContain(
      'create or replace view reporting.v_event_type\n' +
        'with (security_invoker = true) as\n' +
        'select id, key, domain, created_at, updated_at\n' +
        'from public.event_type;',
    )
  })

  it('emits no view for collections without reporting metadata', () => {
    expect(sql).not.toContain('reporting.v_task\n')
  })

  it('grants select on every view to authenticated and service_role', () => {
    expect((sql.match(/grant select on reporting\.v_[a-z_]+ to authenticated, service_role;/g) ?? []).length).toBe(26)
  })

  it('rejects a reporting role on a many-to-many relation', () => {
    const bad: CollectionDef = {
      name: 'bad_collection',
      label: 'Bad',
      labelPlural: 'Bads',
      workspaceScoped: true,
      fields: {
        tags: {
          type: 'relation',
          label: 'Tags',
          target: 'note',
          cardinality: 'many-to-many',
          reporting: { role: 'dimension' },
        },
      },
    }
    expect(() => emitReportingViewSql(bad)).toThrow(/non-FK relation/)
  })
})
