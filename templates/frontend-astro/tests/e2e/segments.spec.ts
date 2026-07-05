import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { scenario, seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

// ── Task 2: segment list + rule builder ──────────────────────────────────────
test('segments list requires a session', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/segments')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('segments list renders ok + empty states', async ({ page }) => {
  await page.goto('/segments')
  const list = page.getByTestId('segments-list')
  await expect(list).toContainText('Registered-not-onboarded')
  await expect(list).toContainText('3')       // memberCount
  await expect(list).toContainText('dynamic') // mode badge (text, not colour-only)

  await scenario('empty')
  await page.goto('/segments')
  await expect(page.getByTestId('empty')).toBeVisible()
})

test('rule builder previews the audience count and saves a new version', async ({ page }) => {
  await page.goto('/segments/seg-1/rules')
  await expect(page.getByTestId('rule-builder-island')).toHaveAttribute('data-ready', 'true')
  await page.getByLabel('Event').fill('registration.completed')

  const previewRes = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/segments/preview')
  await page.getByRole('button', { name: 'Preview' }).click()
  await previewRes
  await expect(page.getByTestId('rule-preview')).toContainText('12')

  const saveRes = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/segments/save-rule')
  await page.getByRole('button', { name: 'Save' }).click()
  await saveRes
  await expect(page.getByTestId('rule-saved')).toContainText('Saved v2')
})

// ── Task 3: membership explorer + snapshot history ───────────────────────────
test('membership explorer lists members and explains one (PII-disciplined)', async ({ page }) => {
  await page.goto('/segments/seg-1/members')
  const list = page.getByTestId('members-list')
  await expect(list).toContainText('user-9')
  await expect(list).toContainText('user-8')

  await page.getByRole('link', { name: 'user-9' }).click()
  await expect(page.getByTestId('matched-rule-version')).toContainText('v2')
  await expect(page.getByTestId('evidence-trail')).toContainText('registration.completed')
  // PII discipline: the evidence surface never carries a raw properties payload.
  expect(await page.content()).not.toMatch(/@example\.com/)

  await scenario('empty')
  await page.goto('/segments/seg-1/members')
  await expect(page.getByTestId('empty')).toBeVisible()
})

test('snapshot history renders a member-count trend and diffs two snapshots', async ({ page }) => {
  await page.goto('/segments/seg-1/snapshots')
  const trend = page.getByTestId('snapshot-trend')
  await expect(trend).toContainText('2')
  await expect(trend).toContainText('3')

  // GET-form diff (?a=&b=) — the browser cannot POST GraphQL, so the diff is SSR-resolved.
  await page.selectOption('#a', 'snap-1')
  await page.selectOption('#b', 'snap-2')
  await page.getByRole('button', { name: 'Diff' }).click()
  await expect(page.getByTestId('diff-added')).toContainText('+1 added')
  await expect(page.getByTestId('diff-removed')).toContainText('-0 removed')
  await expect(page.getByTestId('snapshot-diff')).toContainText('user-8')

  await scenario('empty')
  await page.goto('/segments/seg-1/snapshots')
  await expect(page.getByTestId('empty')).toBeVisible()
})

// ── Task 4: preview single-request (perf) + axe over all four routes ──────────
test('exactly one /api/segments/preview request per Preview click', async ({ page }) => {
  // The browser POSTs JSON to /api/segments/preview (the GraphQL doc travels server-side and is
  // invisible to page.on('request')). Bound server work: one preview request per click, no auto-fire.
  let previewReqs = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/segments/preview') previewReqs++
  })
  await page.goto('/segments/seg-1/rules')
  await expect(page.getByTestId('rule-builder-island')).toHaveAttribute('data-ready', 'true')
  const previewRes = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/segments/preview')
  await page.getByRole('button', { name: 'Preview' }).click()
  await previewRes
  await expect(page.getByTestId('rule-preview')).toContainText('12')
  expect(previewReqs).toBe(1)
})

for (const path of ['/segments', '/segments/seg-1/rules', '/segments/seg-1/members', '/segments/seg-1/snapshots']) {
  test(`a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
}
