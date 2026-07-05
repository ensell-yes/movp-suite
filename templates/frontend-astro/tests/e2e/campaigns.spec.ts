import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockCounts, scenario, seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

test('campaigns auth failure renders without a cookie', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/campaigns')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('campaign list renders seeded campaigns, sorting controls, and empty state', async ({ page }) => {
  await page.goto('/campaigns')
  const rows = page.getByTestId('campaigns-list').locator('tbody tr')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('Launch campaign')
  await expect(rows.nth(1)).toContainText('Planning campaign')
  await expect(rows.nth(2)).toContainText('Wrap-up campaign')
  await expect(rows.nth(3)).toContainText('Cancelled campaign')

  await page.getByRole('button', { name: 'Sort by rank' }).click()
  await expect(page.getByRole('button', { name: 'Sort by rank' })).toHaveAttribute('aria-pressed', 'true')
  await expect(rows.nth(0)).toContainText('Launch campaign')
  await expect(rows.nth(1)).toContainText('Planning campaign')
  await expect(rows.nth(2)).toContainText('Wrap-up campaign')
  await expect(rows.nth(3)).toContainText('Cancelled campaign')

  await page.getByRole('button', { name: 'Sort by priority' }).click()
  await expect(page.getByRole('button', { name: 'Sort by priority' })).toHaveAttribute('aria-pressed', 'true')
  await expect(rows.nth(0)).toContainText('Planning campaign')
  await expect(rows.nth(1)).toContainText('Cancelled campaign')
  await expect(rows.nth(2)).toContainText('Launch campaign')
  await expect(rows.nth(3)).toContainText('Wrap-up campaign')

  await page.getByRole('button', { name: 'Sort by status' }).click()
  await expect(page.getByRole('button', { name: 'Sort by status' })).toHaveAttribute('aria-pressed', 'true')
  await expect(rows.nth(0)).toContainText('Planning campaign')
  await expect(rows.nth(1)).toContainText('Launch campaign')
  await expect(rows.nth(2)).toContainText('Wrap-up campaign')
  await expect(rows.nth(3)).toContainText('Cancelled campaign')
  await expect(rows.nth(3)).toHaveAttribute('data-status-order', '4')

  await scenario('empty')
  await page.goto('/campaigns')
  await expect(page.getByTestId('empty')).toBeVisible()
})

test('campaign detail renders brief metrics stakeholders deliverables channels and discussion', async ({ page }) => {
  await page.goto('/campaigns/camp-1')
  await expect(page.getByTestId('campaign-detail')).toContainText('Launch campaign')
  await expect(page.getByTestId('campaign-brief')).toContainText('summer campaign')
  await expect(page.getByTestId('campaign-metrics')).toContainText('clicks')
  await expect(page.getByTestId('campaign-metrics')).toContainText('40 / 100')
  await expect(page.getByTestId('campaign-stakeholders')).toContainText('owner-1')
  await expect(page.getByTestId('campaign-deliverables')).toContainText('Launch email')
  await expect(page.getByTestId('campaign-channels')).toContainText('email')
  await expect(page.getByTestId('campaign-comments')).toContainText('Campaign note')
})

test('campaign timeline renders backing-task dates and milestones with one batched schedule read', async ({ page }) => {
  await page.goto('/campaigns/timeline')
  await expect(page.getByTestId('campaign-timeline')).toContainText('Launch email')
  await expect(page.getByTestId('campaign-timeline')).toContainText('2026-07-03 to 2026-07-10')
  await expect(page.getByTestId('campaign-timeline')).toContainText('Launch day')
  await expect(page.getByTestId('campaign-timeline')).toContainText('launch')
  expect(await mockCounts()).toMatchObject({ DeliverableSchedules: 1 })
})

test('campaign calendar renders milestones and deliverable due dates', async ({ page }) => {
  await page.goto('/campaigns/calendar')
  await expect(page.getByTestId('campaign-calendar')).toContainText('Launch day')
  await expect(page.getByTestId('campaign-calendar')).toContainText('Launch email due')
  await expect(page.getByTestId('campaign-calendar')).toContainText('2026-07-10')
  expect(await mockCounts()).toMatchObject({ DeliverableSchedules: 1 })
})

test('campaign board reuses the task board filtered to backing tasks', async ({ page }) => {
  await page.goto('/campaigns/camp-1/board')
  await expect(page.getByTestId('task-board')).toContainText('Todo')
  await expect(page.getByTestId('task-board')).toContainText('Campaign launch task')
  await expect(page.getByTestId('task-board')).not.toContainText('Unlinked task')
})

for (const path of ['/campaigns', '/campaigns/camp-1', '/campaigns/timeline', '/campaigns/calendar', '/campaigns/camp-1/board']) {
  test(`campaign a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
