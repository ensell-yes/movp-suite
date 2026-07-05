import { expect, test, type Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { scenario, seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

test('auth failure renders without issuing anonymous data', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('notes list, empty, and error retry states render', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('notes-list')).toContainText('First note')

  await scenario('empty')
  await page.goto('/')
  await expect(page.getByTestId('empty')).toBeVisible()

  await scenario('error')
  await page.goto('/')
  await expect(page.getByTestId('error')).toBeVisible()
  await expect(page.getByTestId('retry')).toBeVisible()
})

test('note detail renders', async ({ page }) => {
  await page.goto('/notes/n1')
  await expect(page.getByTestId('note-detail')).toContainText('First note')
})

test('search loading, results, empty, and error retry states render', async ({ page }) => {
  await page.goto('/search')
  await expect(page.getByTestId('search-box')).toHaveAttribute('data-ready', 'true')
  await page.getByLabel('Search notes').fill('first')

  let releaseSearch!: () => void
  const searchGate = new Promise<void>((resolve) => {
    releaseSearch = resolve
  })
  const searchRoute = async (route: Route) => {
    await searchGate
    await route.continue()
  }
  await page.route('**/api/search**', searchRoute)

  const response = page.waitForResponse((res) => {
    const url = new URL(res.url())
    return url.pathname === '/api/search' && url.searchParams.get('q') === 'first'
  })
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('search-loading')).toBeVisible()
  releaseSearch()
  await response
  await page.unroute('**/api/search**', searchRoute)
  await expect(page.getByTestId('search-results')).toContainText('First note')

  await scenario('empty')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('search-empty')).toBeVisible()

  await scenario('error')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('search-error')).toBeVisible()
  await expect(page.getByTestId('search-retry')).toBeVisible()
})

test('keyboard starts with skip link', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByText('Skip to content')).toBeFocused()
})

for (const path of ['/', '/notes/n1', '/search']) {
  test(`a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
}
