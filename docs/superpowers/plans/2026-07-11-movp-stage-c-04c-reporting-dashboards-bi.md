# MOVP Stage C4c — Admin Dashboards + External BI Seam

> **Execution status:** completed. Post-review hardening preserves partial GraphQL data,
> renders per-section failures, makes the BI guard assertion load-bearing, and bounds chart
> geometry. Committed source and tests are authoritative over intermediate samples.

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code samples verbatim — they are grounded in the real
> committed code (line-verified 2026-07-11). Precondition: **C4a + C4b landed** (the
> `reporting` views, the 8 RPCs, `domain.reporting`, and the 8 GraphQL reads exist).
> This plan is the last of three (`c4a`…`c4c`), expanding breakdown tasks C4.6 + C4.7.

**Goal:** a member opens `/admin/reports` in the C2 console shell and sees six non-empty
dashboard families (task throughput & cycle time, content pipeline funnel, campaign
metrics, segment growth, workflow run health, ingestion volume — plus internal event/job
trends) rendered with **zero new dependencies**; an operator can point Metabase/Cube at a
documented, grants-audited, read-only BI surface.

**Architecture:** the repo has **no chart library and none may be added** (repo rule: no
new dependencies without approval; verified — the web app's only runtime deps are astro,
@astrojs/cloudflare, @astrojs/react, react, react-dom). Charts are server-rendered
accessible HTML/SVG: a CSS-bar **table** (`BarChart.astro`), an SVG polyline with a data
table fallback (`TrendChart.astro`), and `<dl>` stat tiles (the `admin/jobs.astro:73-80`
precedent). Data arrives via ONE GraphQL document over the existing SSR `gqlRequest`
pattern with the canonical `auth | error | empty | ok` state machine. The BI seam cannot
reuse the security-invoker views (an external Postgres role fails BOTH the invoker
privilege check and claim-based RLS), so a shipped-but-inert `reporting.setup_bi_mirror()`
function materializes owner (definer-style) mirror views in a `reporting_bi` schema that
**deliberately bypass RLS** — operator-invoked, granted to nobody by default, pinned by a
pgTAP grants audit.

**Tech stack:** Astro 6 (SSR, Cloudflare adapter), vitest (pure helpers), Playwright +
`@axe-core/playwright` against the stateful GraphQL mock, Postgres 17 + pgTAP.

---

## Baselines (state so Codex knows the expected deltas)

| Gate | Baseline after C4b | After C4c |
|---|---|---|
| pgTAP (`supabase test db`) | **657 tests / 32 files** | **666 / 33** (+9 in `reporting_bi_grants_test.sql`) |
| definer-audit (`node scripts/check-definer-audit.mjs`) | **187 function blocks** | **188** (+1 `setup_bi_mirror`) |
| frontend (`pnpm --filter @movp/frontend-astro build && test && e2e`) | green | green (+chart-scale units, +`reports.spec.ts`) |
| boundary (`bash scripts/check-boundary.sh`) | `boundary: clean` | `boundary: clean` |
| migrations | `…000002_reporting_analytics.sql` | +1 hand migration `20260711000003_reporting_bi.sql` |

## Global Constraints (every task inherits these)

- **TDD, failing test first**; one commit per task; a task is done only when its gate passes.
- **Migration timestamp pre-flight (before the first apply).** Fetch `main`; if
  `supabase/migrations/` on `main` contains any filename sorting after
  `20260711000003_reporting_bi.sql`, re-timestamp C4's three migration filenames so
  they remain consecutive and sort last, and update every matching reference —
  including the reporting entry in `GENERATED_DELTAS` — before running codegen or
  applying a migration. Once any C4 migration merges, it is forward-only and must not
  be renamed; a later change gets a new migration.
- **No new dependencies.** Charts are hand-rolled HTML/SVG. Do not add a charting,
  date, or utility package.
- **Client/server boundary.** `scripts/check-boundary.sh` greps ALL of `templates/` for
  `@movp/(auth|domain)`, `service_role`, `SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE` —
  the new page/components/lib reach the backend ONLY via `gqlRequest` (Bearer user
  token); query strings + TS types live in `src/lib/reporting-queries.ts` with no
  `@movp/*` import. The grep walks the whole tree, so new files are covered automatically.
- **Web env on workerd:** read env via the committed no-arg `readServerEnv()` from
  `src/lib/env.ts` — never `process.env`.
- **State machine:** every page state renders one of the four shared components
  (`AuthFailure` / `ErrorRetry` / `EmptyState` / inline ok markup) with their stable
  `data-testid`s (`auth-failure` / `error` / `empty`).
- **A11y:** every chart is readable without vision or pointer — real `<table>` data,
  `figure/figcaption` labeling, `role="img"` + `aria-label` on SVG; new routes join the
  axe smoke loop (zero serious/critical violations).
- **BI mirror safety invariant:** `reporting_bi` views bypass RLS BY DESIGN and see all
  workspaces. The migration must grant them to NO role (anon/authenticated/public get
  nothing); only the operator's own role receives grants, manually, per the docs recipe.
  pgTAP pins this as the grants audit.
- **Forward-only migrations**; C4c's only migration is `20260711000003_reporting_bi.sql`.

## File Structure

```text
templates/frontend-astro/src/
  lib/chart-scale.ts                       # C4c.1 pure scaling/rollup helpers
  lib/reporting-queries.ts                 # C4c.1 GraphQL document + TS types
  components/reporting/BarChart.astro      # C4c.1 CSS-bar table chart
  components/reporting/TrendChart.astro    # C4c.1 SVG polyline + table fallback
  pages/admin/reports.astro                # C4c.2 the dashboards page
  pages/admin/index.astro                  # C4c.2 MODIFY: add Reports nav item
templates/frontend-astro/tests/
  chart-scale.test.ts                      # C4c.1 vitest units
  mock/graphql-mock.mjs                    # C4c.2 MODIFY: ReportingDashboards fixture
  e2e/reports.spec.ts                      # C4c.2 Playwright + axe
  e2e/admin.spec.ts                        # C4c.2 MODIFY: add /admin/reports to axe loop
supabase/migrations/
  20260711000003_reporting_bi.sql          # C4c.3 setup_bi_mirror()
supabase/tests/
  reporting_bi_grants_test.sql             # C4c.3 pgTAP grants audit (plan 9)
docs/
  reporting.md                             # C4c.3 dashboards + BI quickstart
docs/superpowers/plans/README.md           # C4c.4 MODIFY: Stage C table row
CLAUDE.md                                  # C4c.4 MODIFY: reporting invariants
```

---

## Task C4c.1: Chart primitives (pure helpers first)

**Files**
- Create: `templates/frontend-astro/tests/chart-scale.test.ts`
- Create: `templates/frontend-astro/src/lib/chart-scale.ts`
- Create: `templates/frontend-astro/src/lib/reporting-queries.ts`
- Create: `templates/frontend-astro/src/components/reporting/BarChart.astro`
- Create: `templates/frontend-astro/src/components/reporting/TrendChart.astro`

**TDD steps**

- [ ] **Step 1 — write the failing unit test** `templates/frontend-astro/tests/chart-scale.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dayTotals, rollup, scaleBars, trendPolyline } from '../src/lib/chart-scale.ts'

describe('scaleBars', () => {
  it('scales to the max value as 100%', () => {
    expect(scaleBars([
      { label: 'draft', value: 2 },
      { label: 'published', value: 4 },
    ])).toEqual([
      { label: 'draft', value: 2, pct: 50 },
      { label: 'published', value: 4, pct: 100 },
    ])
  })
  it('handles empty input and all-zero values without dividing by zero', () => {
    expect(scaleBars([])).toEqual([])
    expect(scaleBars([{ label: 'x', value: 0 }])).toEqual([{ label: 'x', value: 0, pct: 0 }])
  })
})

describe('trendPolyline', () => {
  it('returns empty for an empty series', () => {
    expect(trendPolyline([])).toBe('')
  })
  it('plots a single point at the left edge and highest count at the top', () => {
    expect(trendPolyline([{ day: '2026-07-10', count: 5 }], 320, 80, 4)).toBe('4,4')
  })
  it('spreads points across the width in series order', () => {
    const pts = trendPolyline(
      [
        { day: '2026-07-09', count: 0 },
        { day: '2026-07-10', count: 10 },
      ],
      320, 80, 4,
    ).split(' ')
    expect(pts).toHaveLength(2)
    expect(pts[0]).toBe('4,76')   // zero count sits on the baseline
    expect(pts[1]).toBe('316,4')  // max count sits at the top-right
  })
})

describe('rollup / dayTotals', () => {
  it('rollup sums values by label', () => {
    expect(rollup(
      [
        { kind: 'embed', status: 'done', count: 2 },
        { kind: 'embed', status: 'failed', count: 1 },
        { kind: 'embed', status: 'done', count: 3 },
      ],
      (r) => `${r.kind}/${r.status}`,
      (r) => r.count,
    )).toEqual([
      { label: 'embed/done', value: 5 },
      { label: 'embed/failed', value: 1 },
    ])
  })
  it('dayTotals sums per day and sorts ascending', () => {
    expect(dayTotals([
      { day: '2026-07-10', count: 2 },
      { day: '2026-07-09', count: 1 },
      { day: '2026-07-10', count: 3 },
    ])).toEqual([
      { day: '2026-07-09', count: 1 },
      { day: '2026-07-10', count: 5 },
    ])
  })
})
```

- [ ] **Step 2 — run, expect RED:**

```sh
pnpm --filter @movp/frontend-astro exec vitest run chart-scale
```
Expected: **FAIL** — `Cannot find module '../src/lib/chart-scale.ts'`.

- [ ] **Step 3 — create `templates/frontend-astro/src/lib/chart-scale.ts`:**

```ts
export interface BarDatum {
  label: string
  value: number
}

export interface ScaledBar extends BarDatum {
  pct: number
}

export interface TrendPoint {
  day: string
  count: number
}

export function scaleBars(data: BarDatum[]): ScaledBar[] {
  const max = Math.max(0, ...data.map((d) => d.value))
  return data.map((d) => ({ ...d, pct: max === 0 ? 0 : Math.round((d.value / max) * 100) }))
}

// SVG polyline coordinates for a day series. Y is inverted (SVG origin is top-left):
// the max count sits at y=pad, a zero count at y=height-pad.
export function trendPolyline(series: TrendPoint[], width = 320, height = 80, pad = 4): string {
  if (series.length === 0) return ''
  const max = Math.max(1, ...series.map((p) => p.count))
  const stepX = series.length === 1 ? 0 : (width - pad * 2) / (series.length - 1)
  return series
    .map((p, i) => {
      const x = Math.round((pad + i * stepX) * 10) / 10
      const y = Math.round((height - pad - (p.count / max) * (height - pad * 2)) * 10) / 10
      return `${x},${y}`
    })
    .join(' ')
}

export function rollup<T>(rows: T[], labelOf: (r: T) => string, valueOf: (r: T) => number): BarDatum[] {
  const m = new Map<string, number>()
  for (const r of rows) {
    const label = labelOf(r)
    m.set(label, (m.get(label) ?? 0) + valueOf(r))
  }
  return [...m.entries()].map(([label, value]) => ({ label, value }))
}

export function dayTotals(rows: { day: string; count: number }[]): TrendPoint[] {
  return rollup(rows, (r) => r.day, (r) => r.count)
    .sort((a, b) => (a.label < b.label ? -1 : 1))
    .map((r) => ({ day: r.label, count: r.value }))
}
```

- [ ] **Step 4 — run, expect GREEN:** `pnpm --filter @movp/frontend-astro exec vitest run chart-scale` → **PASS** (7 tests).

- [ ] **Step 5 — the two chart components** (server-rendered, scoped styles, no JS):

`templates/frontend-astro/src/components/reporting/BarChart.astro`:

```astro
---
import { scaleBars, type BarDatum } from '../../lib/chart-scale.ts'

interface Props {
  title: string
  data: BarDatum[]
  testId: string
}
const { title, data, testId } = Astro.props
const bars = scaleBars(data)
---
<figure data-testid={testId} class="report-chart">
  <figcaption>{title}</figcaption>
  {bars.length === 0 ? (
    <p>No data yet.</p>
  ) : (
    <table>
      <thead><tr><th scope="col">Label</th><th scope="col">Value</th></tr></thead>
      <tbody>
        {bars.map((b) => (
          <tr>
            <th scope="row">{b.label}</th>
            <td>
              <span class="bar" style={`inline-size:${Math.max(b.pct, 2)}%`} aria-hidden="true"></span>
              <span>{b.value}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</figure>
<style>
  .report-chart table { inline-size: 100%; border-collapse: collapse; }
  .report-chart td { inline-size: 100%; }
  .bar {
    display: inline-block;
    block-size: 0.75rem;
    margin-inline-end: 0.5rem;
    background: currentColor;
    opacity: 0.55;
    vertical-align: baseline;
  }
</style>
```

`templates/frontend-astro/src/components/reporting/TrendChart.astro`:

```astro
---
import { trendPolyline, type TrendPoint } from '../../lib/chart-scale.ts'

interface Props {
  title: string
  series: TrendPoint[]
  testId: string
}
const { title, series, testId } = Astro.props
const points = trendPolyline(series)
---
<figure data-testid={testId} class="report-chart">
  <figcaption>{title}</figcaption>
  {series.length === 0 ? (
    <p>No data yet.</p>
  ) : (
    <>
      <svg viewBox="0 0 320 80" role="img" aria-label={`${title} — ${series.length} data points`} preserveAspectRatio="none">
        <polyline points={points} fill="none" stroke="currentColor" stroke-width="2" />
      </svg>
      <details>
        <summary>Data table</summary>
        <table>
          <thead><tr><th scope="col">Day</th><th scope="col">Count</th></tr></thead>
          <tbody>
            {series.map((p) => (
              <tr><th scope="row">{p.day}</th><td>{p.count}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  )}
</figure>
<style>
  .report-chart svg { inline-size: 100%; block-size: 5rem; }
</style>
```

- [ ] **Step 6 — the query module** `templates/frontend-astro/src/lib/reporting-queries.ts`
  (pure strings + types; **no `@movp/*` import** — boundary):

```ts
export type ReportingDayCount = { day: string; count: number }
export type ReportingTaskThroughput = {
  avgCycleHours: number | null
  openCount: number
  series: ReportingDayCount[]
}
export type ReportingStatusCount = { status: string; count: number }
export type ReportingMetricTotal = { metricKey: string; total: number }
export type ReportingSegmentGrowth = {
  segmentId: string
  name: string
  points: { takenAt: string; memberCount: number }[]
}
export type ReportingOutcomeDayCount = { day: string; outcome: string; count: number }
export type ReportingSourceDayCount = { day: string; source: string; count: number }
export type ReportingTypeDayCount = { day: string; type: string; count: number }
export type ReportingJobDayCount = { day: string; kind: string; status: string; count: number }

export type ReportingDashboardsData = {
  reportingTaskThroughput: ReportingTaskThroughput
  reportingContentFunnel: ReportingStatusCount[]
  reportingCampaignMetrics: ReportingMetricTotal[]
  reportingSegmentGrowth: ReportingSegmentGrowth[]
  reportingWorkflowHealth: ReportingOutcomeDayCount[]
  reportingIngestVolume: ReportingSourceDayCount[]
  reportingEventDailyCounts: ReportingTypeDayCount[]
  reportingJobDailyCounts: ReportingJobDayCount[]
}

export const REPORTING_DASHBOARDS_QUERY = /* GraphQL */ `
  query ReportingDashboards($workspaceId: ID!, $days: Int!) {
    reportingTaskThroughput(workspaceId: $workspaceId, days: $days) {
      avgCycleHours
      openCount
      series { day count }
    }
    reportingContentFunnel(workspaceId: $workspaceId) { status count }
    reportingCampaignMetrics(workspaceId: $workspaceId, days: $days) { metricKey total }
    reportingSegmentGrowth(workspaceId: $workspaceId) { segmentId name points { takenAt memberCount } }
    reportingWorkflowHealth(workspaceId: $workspaceId, days: $days) { day outcome count }
    reportingIngestVolume(workspaceId: $workspaceId, days: $days) { day source count }
    reportingEventDailyCounts(workspaceId: $workspaceId, days: $days) { day type count }
    reportingJobDailyCounts(workspaceId: $workspaceId, days: $days) { day kind status count }
  }
`
```

- [ ] **Step 7 — gate + commit.**

```sh
pnpm --filter @movp/frontend-astro test        # vitest incl. chart-scale — Expected: pass
pnpm --filter @movp/frontend-astro typecheck   # node scripts/typecheck.mjs — Expected: pass
bash scripts/check-boundary.sh                 # Expected: boundary: clean
git add templates/frontend-astro/src/lib/chart-scale.ts templates/frontend-astro/src/lib/reporting-queries.ts \
        templates/frontend-astro/src/components/reporting templates/frontend-astro/tests/chart-scale.test.ts
git commit -m "feat(frontend): C4c.1 zero-dependency chart primitives + reporting query module"
```

---

## Task C4c.2: `/admin/reports` page + mock + Playwright + axe

**Files**
- Create: `templates/frontend-astro/tests/e2e/reports.spec.ts`
- Create: `templates/frontend-astro/src/pages/admin/reports.astro`
- Modify: `templates/frontend-astro/src/pages/admin/index.astro` (nav item)
- Modify: `templates/frontend-astro/tests/mock/graphql-mock.mjs` (fixture)
- Modify: `templates/frontend-astro/tests/e2e/admin.spec.ts` (axe loop path)

**TDD steps**

- [ ] **Step 1 — write the failing e2e** `templates/frontend-astro/tests/e2e/reports.spec.ts`
  (helper signatures verified against `tests/e2e/scenario.ts`: `seedSession(context)` sets
  the cookie + `scenario('ok')`; `scenario(name)` switches the mock per test token):

```ts
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { scenario, seedSession } from './scenario'

test('reports requires a session before rendering any dashboard', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/reports')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
  await expect(page.getByTestId('report-task-throughput')).toHaveCount(0)
})

test('reports renders all dashboard families with non-empty charts', async ({ page, context }) => {
  await seedSession(context)
  await page.goto('/admin/reports')
  for (const id of [
    'report-task-throughput',
    'report-content-funnel',
    'report-campaign-metrics',
    'report-segment-growth',
    'report-workflow-health',
    'report-ingest-volume',
    'report-event-trend',
    'report-job-health',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible()
  }
  await expect(page.getByTestId('chart-task-series').locator('svg polyline')).toBeVisible()
  await expect(page.getByTestId('chart-content-funnel').locator('tbody tr')).toHaveCount(2)
  await expect(page.getByTestId('report-task-throughput')).toContainText('Open tasks')
})

test('reports renders the shared empty state when every family is empty', async ({ page, context }) => {
  await seedSession(context)
  await scenario('empty')
  await page.goto('/admin/reports')
  await expect(page.getByTestId('empty')).toBeVisible()
})

test('reports renders the shared error state on a GraphQL failure', async ({ page, context }) => {
  await seedSession(context)
  await scenario('error')
  await page.goto('/admin/reports')
  await expect(page.getByTestId('error')).toBeVisible()
})

test('reports a11y smoke (authenticated, seeded data)', async ({ page, context }) => {
  await seedSession(context)
  await page.goto('/admin/reports')
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
})
```

- [ ] **Step 2 — run, expect RED:**

```sh
pnpm --filter @movp/frontend-astro build && pnpm --filter @movp/frontend-astro e2e -- reports
```
Expected: **FAIL** — `/admin/reports` 404s (page does not exist).

- [ ] **Step 3 — mock fixture.** In `templates/frontend-astro/tests/mock/graphql-mock.mjs`,
  next to the `query AdminJobs` branch, add:

```js
  if (query.includes('query ReportingDashboards')) {
    const empty = scenario === 'empty'
    return json(res, 200, {
      data: {
        reportingTaskThroughput: {
          avgCycleHours: empty ? null : 24,
          openCount: empty ? 0 : 3,
          series: empty ? [] : [{ day: '2026-07-09', count: 1 }, { day: '2026-07-10', count: 2 }],
        },
        reportingContentFunnel: empty ? [] : [{ status: 'draft', count: 2 }, { status: 'published', count: 1 }],
        reportingCampaignMetrics: empty ? [] : [{ metricKey: 'clicks', total: 100 }],
        reportingSegmentGrowth: empty
          ? []
          : [{ segmentId: 's-1', name: 'Registered', points: [
              { takenAt: '2026-07-09', memberCount: 3 },
              { takenAt: '2026-07-10', memberCount: 5 },
            ] }],
        reportingWorkflowHealth: empty
          ? []
          : [{ day: '2026-07-10', outcome: 'succeeded', count: 4 }, { day: '2026-07-10', outcome: 'failed', count: 1 }],
        reportingIngestVolume: empty ? [] : [{ day: '2026-07-10', source: 'internal', count: 7 }],
        reportingEventDailyCounts: empty ? [] : [{ day: '2026-07-10', type: 'task.completed', count: 5 }],
        reportingJobDailyCounts: empty ? [] : [{ day: '2026-07-10', kind: 'embed', status: 'done', count: 6 }],
      },
    })
  }
```

- [ ] **Step 4 — the page** `templates/frontend-astro/src/pages/admin/reports.astro`
  (open with the exact `<Base …>` idiom `admin/jobs.astro` uses — same layout import,
  same title-passing convention):

```astro
---
import Base from '../../layouts/Base.astro'
import AuthFailure from '../../components/states/AuthFailure.astro'
import ErrorRetry from '../../components/states/ErrorRetry.astro'
import EmptyState from '../../components/states/EmptyState.astro'
import BarChart from '../../components/reporting/BarChart.astro'
import TrendChart from '../../components/reporting/TrendChart.astro'
import { dayTotals, rollup } from '../../lib/chart-scale.ts'
import { readServerEnv } from '../../lib/env.ts'
import { gqlRequest } from '../../lib/graphql.ts'
import { getSessionToken } from '../../lib/session.ts'
import { REPORTING_DASHBOARDS_QUERY, type ReportingDashboardsData } from '../../lib/reporting-queries.ts'

const DAYS = 30
const token = getSessionToken(Astro.cookies)
let state: 'auth' | 'error' | 'empty' | 'ok' = 'auth'
let data: ReportingDashboardsData | null = null

if (token) {
  // Workspace comes from the Worker env (single-tenant deployment), token from the
  // session cookie — the RPC layer enforces membership; a non-member sees the error state.
  const { graphqlEndpoint, workspaceId } = readServerEnv()
  const result = await gqlRequest<ReportingDashboardsData>(
    { endpoint: graphqlEndpoint, token },
    REPORTING_DASHBOARDS_QUERY,
    { workspaceId, days: DAYS },
  )
  if (!result.ok && result.code === 'auth_error') state = 'auth'
  else if (!result.ok) state = 'error'
  else {
    data = result.data
    const allEmpty =
      data.reportingTaskThroughput.openCount === 0 &&
      data.reportingTaskThroughput.series.length === 0 &&
      data.reportingContentFunnel.length === 0 &&
      data.reportingCampaignMetrics.length === 0 &&
      data.reportingSegmentGrowth.length === 0 &&
      data.reportingWorkflowHealth.length === 0 &&
      data.reportingIngestVolume.length === 0 &&
      data.reportingEventDailyCounts.length === 0 &&
      data.reportingJobDailyCounts.length === 0
    state = allEmpty ? 'empty' : 'ok'
  }
}
---
<Base title="Reports">
  <h1>Reports</h1>
  <p><a href="/admin">Admin</a></p>
  {state === 'auth' && <AuthFailure resource="reports" />}
  {state === 'error' && <ErrorRetry message="Could not load reports." retryHref="/admin/reports" />}
  {state === 'empty' && <EmptyState message="No reporting data yet. Tasks, content, campaigns, and events will show up here." />}
  {state === 'ok' && data && (
    <div class="report-grid">
      <section data-testid="report-task-throughput" aria-labelledby="rep-task">
        <h2 id="rep-task">Task throughput</h2>
        <dl>
          <div><dt>Open tasks</dt><dd>{data.reportingTaskThroughput.openCount}</dd></div>
          <div><dt>Avg cycle (hours)</dt><dd>{data.reportingTaskThroughput.avgCycleHours ?? '—'}</dd></div>
        </dl>
        <TrendChart title={`Completed per day (last ${DAYS}d)`} series={data.reportingTaskThroughput.series} testId="chart-task-series" />
      </section>

      <section data-testid="report-content-funnel" aria-labelledby="rep-content">
        <h2 id="rep-content">Content pipeline</h2>
        <BarChart
          title="Items by status"
          data={data.reportingContentFunnel.map((r) => ({ label: r.status, value: r.count }))}
          testId="chart-content-funnel"
        />
      </section>

      <section data-testid="report-campaign-metrics" aria-labelledby="rep-campaign">
        <h2 id="rep-campaign">Campaign metrics</h2>
        <BarChart
          title={`Totals by metric (last ${DAYS}d)`}
          data={data.reportingCampaignMetrics.map((r) => ({ label: r.metricKey, value: r.total }))}
          testId="chart-campaign-metrics"
        />
      </section>

      <section data-testid="report-segment-growth" aria-labelledby="rep-segments">
        <h2 id="rep-segments">Segment growth</h2>
        {data.reportingSegmentGrowth.length === 0 ? (
          <p>No segments yet.</p>
        ) : (
          data.reportingSegmentGrowth.map((seg) => (
            <TrendChart
              title={seg.name}
              series={seg.points.map((p) => ({ day: p.takenAt, count: p.memberCount }))}
              testId={`chart-segment-${seg.segmentId}`}
            />
          ))
        )}
      </section>

      <section data-testid="report-workflow-health" aria-labelledby="rep-workflows">
        <h2 id="rep-workflows">Workflow run health</h2>
        <BarChart
          title={`Runs by outcome (last ${DAYS}d)`}
          data={rollup(data.reportingWorkflowHealth, (r) => r.outcome, (r) => r.count)}
          testId="chart-workflow-health"
        />
      </section>

      <section data-testid="report-ingest-volume" aria-labelledby="rep-ingest">
        <h2 id="rep-ingest">Ingestion volume</h2>
        <TrendChart title={`Platform events per day (last ${DAYS}d)`} series={dayTotals(data.reportingIngestVolume)} testId="chart-ingest-volume" />
      </section>

      <section data-testid="report-event-trend" aria-labelledby="rep-events">
        <h2 id="rep-events">Internal event trend</h2>
        <TrendChart title={`Domain events per day (last ${DAYS}d)`} series={dayTotals(data.reportingEventDailyCounts)} testId="chart-event-trend" />
      </section>

      <section data-testid="report-job-health" aria-labelledby="rep-jobs">
        <h2 id="rep-jobs">Job health</h2>
        <BarChart
          title={`Jobs by kind/status (last ${DAYS}d)`}
          data={rollup(data.reportingJobDailyCounts, (r) => `${r.kind}/${r.status}`, (r) => r.count)}
          testId="chart-job-health"
        />
      </section>
    </div>
  )}
</Base>
<style>
  .report-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: 1.5rem;
  }
</style>
```

- [ ] **Step 5 — nav + axe loop.** In `templates/frontend-astro/src/pages/admin/index.astro`,
  add to the `Admin sections` list (alongside `/admin/members` … `/admin/settings`):

```astro
      <li><a href="/admin/reports">Reports</a></li>
```

In `templates/frontend-astro/tests/e2e/admin.spec.ts`, add `'/admin/reports'` to the
existing a11y-smoke `for (const path of [...])` array.

- [ ] **Step 6 — run, expect GREEN:**

```sh
pnpm --filter @movp/frontend-astro build
pnpm --filter @movp/frontend-astro e2e -- reports admin
```
Expected: **PASS** — the 5 new report tests + the extended admin axe loop.

- [ ] **Step 7 — gates + commit.**

```sh
pnpm --filter @movp/frontend-astro test        # Expected: pass
bash scripts/check-boundary.sh                 # Expected: boundary: clean
git add templates/frontend-astro/src/pages/admin/reports.astro templates/frontend-astro/src/pages/admin/index.astro \
        templates/frontend-astro/tests/mock/graphql-mock.mjs templates/frontend-astro/tests/e2e/reports.spec.ts \
        templates/frontend-astro/tests/e2e/admin.spec.ts
git commit -m "feat(frontend): C4c.2 /admin/reports dashboards — six families, four states, axe-clean"
```

---

## Task C4c.3: External BI seam — `reporting_bi` mirror + grants audit + docs

**Design (why a mirror schema):** an external BI role cannot use `reporting.v_*`:
security-invoker views check BOTH table privileges and RLS **as the invoker**, and a raw
Postgres role has neither grants on `public.*` nor JWT claims for `auth.uid()`. The seam
is therefore `reporting.setup_bi_mirror()` — shipped inert, operator-invoked — creating
owner-style views `reporting_bi.v_*` (one per `reporting` view, same **projected columns
only**, so content bodies never leak) that bypass RLS via the table-owner exemption.
The initial nested-view assumption failed on the target stack: an owner view over a
security-invoker view still checked base-table privileges as the BI caller. The applied
fallback copies each reporting view's resolved `pg_get_viewdef` SQL into an owner view.
That SQL preserves the reporting view's explicit projection while binding its base-table
reads to the mirror owner; it never uses `select *` against a base table.

**Files**
- Create: `supabase/tests/reporting_bi_grants_test.sql`
- Create: `supabase/migrations/20260711000003_reporting_bi.sql`
- Create: `docs/reporting.md`

**TDD steps**

- [ ] **Step 1 — write the failing pgTAP** `supabase/tests/reporting_bi_grants_test.sql`:

```sql
-- C4c.3 BI seam grants audit: the mirror bypasses RLS BY DESIGN but is reachable ONLY
-- by an operator-granted role; app roles and the BI role stay walled out of everything else.
begin;
select plan(9);

-- seed two workspaces + one fact row each (as table owner)
insert into public.workspace (id, name) values
  ('c4c00000-0000-0000-0000-000000000001', 'BiW1'),
  ('c4c00000-0000-0000-0000-000000000002', 'BiW2');
insert into public.campaign (id, workspace_id, name, status) values
  ('c4c00000-0000-0000-0000-0000000000a1', 'c4c00000-0000-0000-0000-000000000001', 'A', 'active'),
  ('c4c00000-0000-0000-0000-0000000000a2', 'c4c00000-0000-0000-0000-000000000002', 'B', 'active');
insert into public.campaign_metric (workspace_id, campaign_id, metric_key, value, measured_at) values
  ('c4c00000-0000-0000-0000-000000000001', 'c4c00000-0000-0000-0000-0000000000a1', 'clicks', 10, current_date),
  ('c4c00000-0000-0000-0000-000000000002', 'c4c00000-0000-0000-0000-0000000000a2', 'clicks', 20, current_date);

-- operator invokes the mirror (pgTAP runs as postgres = session_user allowed)
select is(reporting.setup_bi_mirror(), 27, 'mirror creates one bi view per reporting view (26 generated + v_task_cycle)');

-- ── operator recipe (KEEP IN SYNC with docs/reporting.md "Create the BI role") ──
create role movp_bi_smoke;
grant movp_bi_smoke to postgres;
grant usage on schema extensions to movp_bi_smoke;
grant usage on schema reporting_bi to movp_bi_smoke;
grant select on all tables in schema reporting_bi to movp_bi_smoke;

set local role movp_bi_smoke;
select is((select count(*)::int from reporting_bi.v_campaign_metric), 2,
  'BI role sees BOTH workspaces via the mirror (cross-workspace BY DESIGN — document it)');
select throws_ok($$ select count(*) from reporting.v_campaign_metric $$, '42501', null,
  'BI role cannot read the app-facing reporting schema');
select throws_ok($$ select count(*) from public.campaign_metric $$, '42501', null,
  'BI role cannot read base tables');
select throws_ok($$ select count(*) from movp_internal.movp_jobs $$, '42501', null,
  'BI role cannot reach movp_internal');
reset role;

-- app roles get NOTHING on the bypassing mirror
select ok(not has_schema_privilege('authenticated', 'reporting_bi', 'usage'),
  'authenticated lacks usage on reporting_bi');
select ok(not has_schema_privilege('anon', 'reporting_bi', 'usage'),
  'anon lacks usage on reporting_bi');
select ok(not has_table_privilege('authenticated', 'reporting_bi.v_campaign_metric', 'select'),
  'authenticated cannot select the mirror');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4c0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select throws_ok($$ select reporting.setup_bi_mirror() $$, '42501', null,
  'authenticated cannot invoke the mirror setup');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2 — run, expect RED:**

```sh
supabase test db
```
Expected: **FAIL** — `function reporting.setup_bi_mirror() does not exist`.

- [ ] **Step 3 — create `supabase/migrations/20260711000003_reporting_bi.sql`:**

```sql
-- C4c.3 External BI seam. Shipped INERT: nothing is created until an operator runs
-- select reporting.setup_bi_mirror(); and nothing is granted until the operator grants
-- their own BI role (docs/reporting.md).
--
-- SAFETY: reporting_bi views run with their OWNER's rights (postgres) and therefore
-- BYPASS RLS — every workspace is visible. That is the point (an external BI role has
-- no JWT claims), and it is contained: the mirror projects ONLY the reporting views'
-- columns (dimensions/measures/join keys — never content bodies), lives in its own
-- schema, and is granted to no role by default. reporting_bi_grants_test.sql is the audit.

create or replace function reporting.setup_bi_mirror()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  view record;
  created_count int := 0;
begin
  -- Operator gate: a direct superuser/admin session. The reporting schema is not in
  -- config.toml [api].schemas, so the current deployment has no Data API route here.
  -- current_user is useless here (it is the DEFINER inside this function) — use
  -- session_user, the connection's real login role.
  if (select auth.role()) is distinct from 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'reserved_for_operator' using errcode = '42501';
  end if;

  execute 'create schema if not exists reporting_bi';
  execute 'revoke all on schema reporting_bi from public';

  for view in
    select c.relname as viewname, pg_catalog.pg_get_viewdef(c.oid, true) as definition
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'reporting'
       and c.relkind = 'v'
  loop
    execute pg_catalog.format(
      'create or replace view reporting_bi.%I as %s',
      view.viewname,
      view.definition
    );
    created_count := created_count + 1;
  end loop;
  return created_count;
end;
$$;
revoke all on function reporting.setup_bi_mirror() from public, anon, authenticated;
grant execute on function reporting.setup_bi_mirror() to service_role;
```

- [ ] **Step 4 — apply + run, expect GREEN:**

```sh
supabase db reset && supabase test db
```
Expected: **PASS — 666 tests across 33 files** (657 + 9). Execution initially returned
`permission denied for table campaign_metric`; the fallback above was applied and the
same cross-workspace assertion then passed without weakening the test.

- [ ] **Step 5 — write `docs/reporting.md`:**

```markdown
# Reporting & Dashboards

## What you get

- **`reporting` schema** — codegen-emitted, security-invoker views
  (`reporting.v_<collection>`) over every collection with `reporting` field metadata,
  plus the hand-authored `reporting.v_task_cycle`. RLS binds: a member queries them (via
  the app's RPCs) and sees only their workspaces.
- **Dashboard RPCs** — `reporting_task_throughput`, `reporting_content_funnel`,
  `reporting_campaign_metrics`, `reporting_segment_growth`, `reporting_workflow_health`,
  `reporting_ingest_volume`, `reporting_event_daily_counts`, `reporting_job_daily_counts`.
  All member-gated (`42501` otherwise), date-clamped to ≤90 days; the two `movp_internal`
  readers return counts + bounded classifiers only (never payload values).
- **`/admin/reports`** — the prebuilt dashboards page in the admin console.

## External BI quickstart (Metabase, Cube, any Postgres client)

The app-facing views cannot serve an external BI login (no JWT claims → RLS yields
nothing). Instead, mirror them once per deployment:

The `reporting` schema is not exposed through the Data API, so use a direct admin
database session as `postgres` or `supabase_admin`:

```sql
-- 1. create or refresh the mirror:
select reporting.setup_bi_mirror();

-- 2. create your read-only BI role
--    (KEEP IN SYNC with supabase/tests/reporting_bi_grants_test.sql "operator recipe"):
create role movp_bi login password '<generate-a-strong-password>';
grant usage on schema reporting_bi to movp_bi;
grant select on all tables in schema reporting_bi to movp_bi;
```

Point Metabase/Cube at your database with the `movp_bi` credentials and the
`reporting_bi` schema.

**Read this before granting access:**

- `reporting_bi` views **bypass RLS** and show **all workspaces**. Use one BI role per
  deployment you trust with that view, or filter by `workspace_id` downstream.
- The role can read **nothing else**: no base tables, no `movp_internal`, not even the
  app-facing `reporting` schema. `supabase/tests/reporting_bi_grants_test.sql` is the
  grants audit that pins this.
- Re-run `select reporting.setup_bi_mirror();` after a migration adds new reporting
  views, then re-run the `grant select on all tables in schema reporting_bi ...` line.

No BI tool is bundled; this seam is deliberately just SQL + docs.
```

- [ ] **Step 6 — gates + commit.**

```sh
node scripts/check-definer-audit.mjs      # Expected: 188 function blocks, all definers pinned (+1)
supabase db diff                          # Expected: clean
node scripts/check-forward-only-migrations.mjs   # Expected: pass
git add supabase/migrations/20260711000003_reporting_bi.sql supabase/tests/reporting_bi_grants_test.sql docs/reporting.md
git commit -m "feat(reporting): C4c.3 external BI seam — inert operator mirror + grants audit + quickstart"
```

---

## Task C4c.4: Full-gate run + status bookkeeping

**Files**
- Modify: `docs/superpowers/plans/README.md` (Stage C table)
- Modify: `CLAUDE.md` (reporting invariants)

**Steps**

- [ ] **Step 1 — the full local gate chain** (every command must pass):

```sh
pnpm codegen && git status --porcelain            # only expected artifacts, baseline untouched
turbo run typecheck                               # 12/12
pnpm --filter @movp/codegen test
supabase db reset && supabase db diff             # clean
supabase test db                                  # 666 / 33 files
node scripts/check-definer-audit.mjs              # 188 function blocks
pnpm test:forward-only-migrations
pnpm test:graphql-shape
pnpm test:redaction
bash scripts/check-boundary.sh                    # boundary: clean
pnpm --filter @movp/domain test
pnpm --filter @movp/graphql test
pnpm --filter @movp/frontend-astro build && pnpm --filter @movp/frontend-astro test && pnpm --filter @movp/frontend-astro e2e
bash scripts/slice-e2e.sh                         # full slice stays green
```

- [ ] **Step 2 — update the Stage C EXECUTION STATUS table** in
  `docs/superpowers/plans/README.md`: set the C4 row to

```markdown
> | C4 Reporting Views & Dashboards | `2026-07-11-movp-stage-c-04{a,b,c}-*.md` | ✅ EXECUTED (…fill in PR/commit + gate evidence…) |
```

(A phase is DONE only when **all three parts** are executed — update the row in the same
commit that lands the final part, per CLAUDE.md "Phase Completion Signal".)

- [ ] **Step 3 — add the reporting invariants to `CLAUDE.md`** (new section after
  "Migration Discipline"):

```markdown
## Reporting Discipline

- The `reporting` schema is CODEGEN OUTPUT (a generated delta migration listed in
  `GENERATED_DELTAS`, `packages/codegen/src/generate.ts`). Never hand-edit a
  `*_movp_generated*.sql` file; `generate()` hard-fails on frozen-baseline drift —
  post-freeze emitter changes need a NEW registry entry + NEW timestamped file.
- Dashboard reads are RPCs (`reporting_*`), member-gated with `42501`, date-clamped to
  ≤90 days; the `movp_internal` readers return counts + bounded classifiers only.
- `reporting_bi` (created by `reporting.setup_bi_mirror()`, operator-invoked) BYPASSES
  RLS by design and is granted to no app role; `reporting_bi_grants_test.sql` is the
  audit. Do not grant `reporting_bi` to `authenticated`/`anon` — ever.
```

- [ ] **Step 4 — commit + review.**

```sh
git add docs/superpowers/plans/README.md CLAUDE.md
git commit -m "docs(reporting): C4c.4 execution status + reporting discipline invariants"
```

Then run the adversarial review over the whole C4 diff; the phase ships only at
**≥ 9.2** with no dimension below threshold (repo standard).

---

## Deferred (visible, not silent)

- **Custom dashboard builder / configurable charts** — prebuilt six families only;
  builder needs a real consumer first.
- **Scheduled email reports** — an `automation_rule` action later (roadmap C4 deferred).
- **Materialized views** — plain views until a measured slow query says otherwise.
- **Client-side interactivity (tooltips, zoom)** — server-rendered charts are the v1;
  islands only when a concrete UX need lands.
- **Per-workspace BI roles / row-filtered BI** — the mirror is deployment-scoped;
  multi-tenant BI isolation is a future phase with its own design.

## Eight-dimension self-check (C4c)

- **Correctness** — page states, chart math (unit-tested pure helpers), and mirror
  behavior all pinned by deterministic tests; mock fixtures mirror the C4b interface
  shapes exactly.
- **Safety** — boundary grep covers all new frontend files; the RLS-bypassing mirror is
  inert until operator action, granted to nobody, projects bounded columns only, and is
  audited by pgTAP; the operator gate uses `session_user` (not the definer-trap
  `current_user`).
- **Reliability** — GraphQL failure → shared error state with retry; empty data → shared
  empty state; the failed nested-view assumption surfaced RED in pgTAP and the documented
  resolved-definition fallback is now pinned by the unchanged assertion.
- **Observability** — reads reuse the evented GraphQL edge (`resolvePrincipal` emits
  auth failures); RPC failures carry bounded codes end-to-end; no new silent path.
- **Efficiency** — one GraphQL document per page load (eight resolvers, one round trip);
  charts render server-side (zero client JS added); no duplicate fetching.
- **Performance** — payload is aggregates only (≤90-day windows, counted in SQL); no
  chart library means no bundle-size change; grid renders statically.
- **Simplicity** — two chart components + three pure helpers; no chart abstraction
  beyond the first real consumers (eight sections).
- **Usability** — keyboardable (`details` for data tables, plain links), screen-reader
  real tables behind every visual, axe-clean gate, humane empty/error copy.
