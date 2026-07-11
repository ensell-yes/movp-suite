import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { scenario, seedSession } from './scenario.ts'

test('reports requires a session before rendering dashboards', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/reports')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
  await expect(page.getByTestId('report-task-throughput')).toHaveCount(0)
})

test('reports renders every dashboard family', async ({ page, context }) => {
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
  await expect(page.getByText('Completed per day (last 30d) data table', { exact: true })).toBeVisible()
  await expect(page.getByTestId('chart-content-funnel').locator('tbody tr')).toHaveCount(2)
  await expect(page.getByTestId('report-task-throughput')).toContainText('Open tasks')
})

test('reports renders the shared empty state', async ({ page, context }) => {
  await seedSession(context)
  await scenario('empty')
  await page.goto('/admin/reports')
  await expect(page.getByTestId('empty')).toBeVisible()
})

test('reports renders the shared error state', async ({ page, context }) => {
  await seedSession(context)
  await scenario('error')
  await page.goto('/admin/reports')
  await expect(page.getByTestId('error')).toBeVisible()
})

test('reports keeps healthy sections visible when one field fails', async ({ page, context }) => {
  await seedSession(context)
  await scenario('partial')
  await page.goto('/admin/reports')
  await expect(page.getByTestId('report-task-throughput')).toBeVisible()
  await expect(page.getByTestId('chart-task-series')).toBeVisible()
  await expect(page.getByTestId('report-campaign-metrics-error')).toBeVisible()
  await expect(page.getByTestId('error')).toHaveCount(0)
})

test('reports authenticated view has no serious accessibility violations', async ({ page, context }) => {
  await seedSession(context)
  await page.goto('/admin/reports')
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter((violation) =>
    violation.impact === 'serious' || violation.impact === 'critical')).toEqual([])
})
