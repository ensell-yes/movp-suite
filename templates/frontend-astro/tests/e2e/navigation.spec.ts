import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

test('desktop renders a sticky expanded navigation with icons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByTestId('top-nav')).toHaveCSS('position', 'sticky')
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Tasks' }).locator('svg')).toHaveCount(1)
})

test('tablet uses the hamburger navigation', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden()
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
})

test('mobile hamburger opens and closes the navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const toggle = page.locator('[data-nav-toggle]')
  await expect(toggle).toHaveAccessibleName('Open navigation menu')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toHaveAccessibleName('Close navigation menu')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveAccessibleName('Open navigation menu')
})

test('Escape closes mobile navigation and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Open navigation menu' })
  await toggle.click()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('current section is announced', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page')
})

test('authenticated user menu links to the existing account surfaces', async ({ page }) => {
  await page.goto('/')
  await page.getByText('Account', { exact: true }).click()
  await expect(page.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/settings/profile')
  await expect(page.getByRole('link', { name: 'Security' })).toHaveAttribute('href', '/settings/security')
  await expect(page.getByRole('link', { name: 'Access tokens' })).toHaveAttribute('href', '/settings/tokens')
  await expect(page.getByRole('link', { name: 'Members & roles' })).toHaveAttribute('href', '/admin/members')
})

test('signed-out navigation presents login instead of the user menu', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login')
  await expect(page.getByText('Account', { exact: true })).toHaveCount(0)
})

test('display-name markup is rendered as inert text', async ({ page, context }) => {
  const payload = '<img src=x onerror="window.__displayNameXss=true">'
  const encoded = Buffer.from(JSON.stringify({ email: 'safe@example.test', user_metadata: { display_name: payload } })).toString('base64url')
  await context.clearCookies()
  await context.addCookies([{ name: 'sb-access-token', value: `a.${encoded}.b`, domain: '127.0.0.1', path: '/', httpOnly: true }])
  await page.goto('/')
  await expect(page.getByText(payload, { exact: true })).toBeVisible()
  await expect(page.locator('[data-user-menu] img')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, '__displayNameXss'))).toBeUndefined()
})

test('mobile navigation has no detectable accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
