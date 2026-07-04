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

test('campaigns auth failure renders without a cookie', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/campaigns')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('campaign list renders seeded campaigns, sorting controls, and empty state', async ({ page }) => {
  await page.goto('/campaigns')
  await expect(page.getByTestId('campaigns-list')).toContainText('Launch campaign')
  await page.getByRole('button', { name: 'Sort by rank' }).click()
  await expect(page.getByRole('button', { name: 'Sort by rank' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Sort by priority' }).click()
  await expect(page.getByRole('button', { name: 'Sort by priority' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Sort by status' }).click()
  await expect(page.getByRole('button', { name: 'Sort by status' })).toHaveAttribute('aria-pressed', 'true')

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

for (const path of ['/campaigns', '/campaigns/camp-1']) {
  test(`campaign a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
