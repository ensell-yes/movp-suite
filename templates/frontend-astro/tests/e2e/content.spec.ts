import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function scenario(name: string) {
  await fetch(`http://127.0.0.1:4322/scenario?name=${name}`)
}

test.beforeEach(async ({ context }) => {
  await scenario('ok')
  await context.addCookies([
    {
      name: 'sb-access-token',
      value: 'test-token',
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
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
  await expect(page.getByTestId('content-fields').locator('[data-field-control]')).toHaveCount(3)
  await expect(page.getByLabel('Hero asset')).toHaveAttribute('type', 'file')
  await expect(page.getByTestId('content-comments')).toContainText('Editorial note')
  await expect(page.getByTestId('content-revisions').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('content-revisions')).toContainText('Diff')

  await page.getByRole('button', { name: 'Run SEO audit' }).click()
  await expect(page.getByTestId('seo-panel')).toContainText('Score 87')
  await expect(page.getByTestId('seo-panel')).toContainText('headline')
})

test('approval queue and calendar render operational states', async ({ page }) => {
  await page.goto('/content/approvals')
  await expect(page.getByTestId('content-approvals')).toContainText('ci1')

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
