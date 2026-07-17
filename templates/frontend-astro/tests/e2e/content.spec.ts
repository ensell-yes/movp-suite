import { expect, test, type BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mockCounts, scenario, scenarioToken, seedSession } from './scenario.ts'

const RT = 'd1000000-0000-4000-8000-000000000001'
const RT_REV = 'd2000000-0000-4000-8000-000000000001'

async function seedNamedSession(context: BrowserContext, token: string): Promise<void> {
  await fetch(`http://127.0.0.1:4322/scenario?name=ok&token=${encodeURIComponent(token)}`)
  await context.addCookies([
    {
      name: 'sb-access-token',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

test('content auth failure renders without a cookie', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/content')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('content list renders filters search and seeded items', async ({ page }) => {
  await page.goto('/content')
  await expect(page.getByTestId('content-list')).toContainText('launch-article')
  await expect(page.getByLabel('Type')).toBeVisible()
  await expect(page.getByLabel('Status')).toBeVisible()
  await expect(page.getByLabel('Search content')).toBeVisible()

  await page.goto('/content?q=launch')
  await expect(page.getByTestId('content-search-results')).toContainText('Launch article')
})

test('content editor renders schema controls discussion revisions and SEO POST result', async ({ page }) => {
  await page.goto('/content/ci1')
  await expect(page.getByTestId('content-editor')).toContainText('launch-article')
  await expect(page.getByTestId('content-fields').locator('[data-field-control]')).toHaveCount(6)
  await expect(page.getByRole('region', { name: 'Body' }).getByRole('textbox', { name: 'Rich text editor' })).toBeVisible()
  await expect(page.getByLabel('Priority')).toHaveAttribute('type', 'number')
  await expect(page.getByLabel('Featured')).toHaveAttribute('type', 'checkbox')
  await expect(page.getByLabel('Category')).toHaveValue('news')
  await expect(page.getByLabel('Hero asset')).toHaveAttribute('type', 'file')
  await expect(page.getByTestId('content-comments')).toContainText('Editorial note')
  await expect(page.getByTestId('content-revisions').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('content-revisions')).toContainText('Diff')
  await page.getByText('Diff').nth(1).click()
  await expect(page.getByTestId('content-revisions')).toContainText('body')
  await expect(page.getByTestId('content-revisions')).toContainText('Draft body')

  await page.getByLabel('Priority').fill('42')
  await page.getByLabel('Featured').uncheck()
  await page.getByLabel('Category').selectOption('guide')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Saved')

  await page.getByRole('button', { name: 'Run SEO audit' }).click()
  await expect(page.getByTestId('seo-panel')).toContainText('Score 87')
  await expect(page.getByTestId('seo-panel')).toContainText('headline')
})

test('content editor keeps edits visible on save conflict', async ({ page }) => {
  await scenario('conflict')
  await page.goto('/content/ci1')
  await page.getByLabel('Priority').fill('43')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('save-error')).toContainText('changed by someone else')
  await expect(page.getByTestId('content-editor')).toBeVisible()
  await expect(page.getByLabel('Priority')).toHaveValue('43')
})

test('two editors on different fields recover a stale save and preserve both fields', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  await seedSession(ctxA)
  await seedSession(ctxB)

  try {
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    await a.goto(`/content/${RT}`)
    await b.goto(`/content/${RT}`)
    await expect(a.getByTestId('richtext-island')).toHaveAttribute('data-ready', 'true')
    await expect(b.getByTestId('richtext-island')).toHaveAttribute('data-ready', 'true')

    const aSummaryRegion = a.getByRole('region', { name: 'Summary' })
    const aSummary = aSummaryRegion.getByRole('textbox', { name: 'Rich text editor' })
    await aSummary.click()
    await aSummary.pressSequentially('alpha summary')
    await aSummaryRegion.getByRole('button', { name: 'Save content' }).click()
    await expect(aSummaryRegion.getByText('Saved', { exact: true })).toBeVisible()

    const bBodyRegion = b.getByRole('region', { name: 'Body' })
    const bBody = bBodyRegion.getByRole('textbox', { name: 'Rich text editor' })
    await bBody.click()
    await bBody.pressSequentially('bravo body')
    await bBodyRegion.getByRole('button', { name: 'Save content' }).click()
    await expect(bBodyRegion.getByRole('alert')).toBeVisible()
    await expect(bBodyRegion).toContainText('bravo body')

    await bBodyRegion.getByRole('button', { name: 'Refresh revision' }).click()
    await expect(bBodyRegion.getByText('Revision updated — Save to retry.', { exact: true })).toBeVisible()
    await expect(bBodyRegion).toContainText('bravo body')
    await bBodyRegion.getByRole('button', { name: 'Save content' }).click()
    await expect(bBodyRegion.getByText('Saved', { exact: true })).toBeVisible()

    const fresh = await ctxA.newPage()
    await fresh.goto(`/content/${RT}`)
    await expect(fresh.getByTestId('richtext-island')).toHaveAttribute('data-ready', 'true')
    await expect(fresh.getByRole('region', { name: 'Summary' })).toContainText('alpha summary')
    await expect(fresh.getByRole('region', { name: 'Body' })).toContainText('bravo body')
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

test('two richtext fields save sequentially in one session without a self-conflict', async ({ page }) => {
  await page.goto(`/content/${RT}`)
  await expect(page.getByTestId('richtext-island')).toHaveAttribute('data-ready', 'true')

  for (const name of ['Body', 'Summary']) {
    const region = page.getByRole('region', { name })
    const editor = region.getByRole('textbox', { name: 'Rich text editor' })
    await editor.click()
    await editor.pressSequentially(`${name} text`)
    await region.getByRole('button', { name: 'Save content' }).click()
    await expect(region.getByText('Saved', { exact: true })).toBeVisible()
    await expect(region.getByRole('alert')).toHaveCount(0)
  }
})

test('editing arms the beforeunload guard and saving disarms it', async ({ page }) => {
  await page.goto(`/content/${RT}`)
  const island = page.getByTestId('richtext-island')
  await expect(island).toHaveAttribute('data-ready', 'true')
  await expect(island).toHaveAttribute('data-dirty', 'false')

  const bodyRegion = page.getByRole('region', { name: 'Body' })
  const body = bodyRegion.getByRole('textbox', { name: 'Rich text editor' })
  await body.click()
  await body.pressSequentially('unsaved')
  await expect(island).toHaveAttribute('data-dirty', 'true')
  await bodyRegion.getByRole('button', { name: 'Save content' }).click()
  await expect(bodyRegion.getByText('Saved', { exact: true })).toBeVisible()
  await expect(island).toHaveAttribute('data-dirty', 'false')
})

test('richtext mock state and scenario resets are isolated by bearer token', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const base = scenarioToken()
  const tokenA = `${base}-A`
  const tokenB = `${base}-B`
  await seedNamedSession(ctxA, tokenA)
  await seedNamedSession(ctxB, tokenB)

  try {
    const a = await ctxA.newPage()
    await a.goto(`/content/${RT}`)
    const aBodyRegion = a.getByRole('region', { name: 'Body' })
    const aBody = aBodyRegion.getByRole('textbox', { name: 'Rich text editor' })
    await aBody.click()
    await aBody.pressSequentially('token A body')
    await aBodyRegion.getByRole('button', { name: 'Save content' }).click()
    await expect(aBodyRegion.getByText('Saved', { exact: true })).toBeVisible()

    await fetch(`http://127.0.0.1:4322/scenario?name=ok&token=${encodeURIComponent(tokenB)}`)
    const aFresh = await ctxA.newPage()
    await aFresh.goto(`/content/${RT}`)
    await expect(aFresh.getByRole('region', { name: 'Body' })).toContainText('token A body')

    const b = await ctxB.newPage()
    await b.goto(`/content/${RT}`)
    await expect(b.getByRole('region', { name: 'Body' })).not.toContainText('token A body')
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

test('richtext endpoint enforces bounds, idempotency, conflicts, and one combined read', async ({ page }) => {
  await page.goto(`/content/${RT}`)
  const url = `/api/content/${RT}/richtext`
  const okDoc = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
  })
  const staleDoc = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'different' }] }],
  })
  const before = (await mockCounts()).contentItemRead ?? 0

  const bad = await page.request.post(url, {
    data: { fieldKey: 'body', body: '"not a doc"', expectedRevisionId: RT_REV },
  })
  expect(bad.status()).toBe(422)

  const big = await page.request.post(url, {
    data: { fieldKey: 'body', body: okDoc + ' '.repeat(300_000), expectedRevisionId: RT_REV },
  })
  expect(big.status()).toBe(413)

  const ok = await page.request.post(url, {
    data: { fieldKey: 'body', body: okDoc, expectedRevisionId: RT_REV },
  })
  const okText = await ok.text()
  const okPayload: unknown = JSON.parse(okText)
  expect(ok.status(), okText).toBe(200)
  expect(okPayload).toMatchObject({ status: 'saved' })

  const idempotent = await page.request.post(url, {
    data: { fieldKey: 'body', body: okDoc, expectedRevisionId: RT_REV },
  })
  expect(idempotent.status()).toBe(200)
  const idempotentPayload: unknown = await idempotent.json()
  expect(idempotentPayload).toMatchObject({ status: 'saved' })

  const stale = await page.request.post(url, {
    data: { fieldKey: 'body', body: staleDoc, expectedRevisionId: RT_REV },
  })
  expect(stale.status()).toBe(409)

  const after = (await mockCounts()).contentItemRead ?? 0
  expect(after - before).toBe(3)
})

test('approval queue and calendar render operational states', async ({ page }) => {
  await page.goto('/content/approvals')
  await expect(page.getByTestId('content-approvals')).toContainText('launch-article')

  await page.goto('/content/calendar')
  await expect(page.getByTestId('content-calendar')).toContainText('content.scheduled')
})

for (const path of ['/content', '/content/ci1', '/content/approvals', '/content/calendar']) {
  test(`content a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
