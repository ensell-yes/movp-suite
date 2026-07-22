import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { scenario, scenarioToken, seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

async function openRecoveryPassword(page: Page, context: BrowserContext): Promise<void> {
  await context.clearCookies()
  await page.goto(`/auth/callback?token_hash=valid-recovery-token-hash-${scenarioToken()}&type=recovery`)
  await page.getByRole('button', { name: 'Continue password reset' }).click()
  await page.waitForURL('/settings/security/password')
}

test('profile requires a session', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/settings/profile')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('profile renders authoritative account fields', async ({ page }) => {
  await page.goto('/settings/profile')
  await expect(page.getByLabel('Email')).toHaveValue('demo-owner@example.test')
  await expect(page.getByLabel('First name')).toHaveValue('Demo')
  await expect(page.getByLabel('Last name')).toHaveValue('Owner')
  await expect(page.getByLabel('Display name')).toHaveValue('Demo Owner')
})

test('profile saves metadata and updates the cosmetic navigation name', async ({ page }) => {
  await page.goto('/settings/profile')
  await page.getByLabel('First name').fill('Grace')
  await page.getByLabel('Last name').fill('Hopper')
  await page.getByLabel('Display name').fill('Amazing Grace')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByTestId('profile-notice')).toContainText('Profile saved')
  await page.reload()
  await expect(page.getByText('Amazing Grace', { exact: true })).toBeVisible()
})

test('security links to existing token and member managers', async ({ page }) => {
  await page.goto('/settings/security')
  await expect(page.getByRole('link', { name: 'Manage access tokens' })).toHaveAttribute('href', '/settings/tokens')
  await expect(page.getByRole('link', { name: 'Manage members & roles' })).toHaveAttribute('href', '/admin/members')
})

test('security renders both enabled agent-access switches with exact disclosure', async ({ page }) => {
  await page.goto('/settings/security')
  await expect(page.getByRole('switch', { name: 'MCP access' })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'CLI & API access (PAT)' })).toBeChecked()
  await expect(page.getByText('Allow your account to connect through the MOVP MCP endpoint.')).toBeVisible()
  await expect(page.getByText(/Already-issued exchanged sessions may remain valid for up to 60 minutes/)).toBeVisible()
  await expect(page.getByText(/A directly supplied MOVP_ACCESS_TOKEN is not controlled by this setting/)).toBeVisible()
})

test('security disables MCP access while preserving CLI access', async ({ page }) => {
  await page.goto('/settings/security')
  await page.getByRole('switch', { name: 'MCP access' }).uncheck()
  await page.getByRole('button', { name: 'Save agent access' }).click()
  await expect(page.getByTestId('agent-access-notice')).toContainText('Agent access settings saved')
  await expect(page.getByRole('switch', { name: 'MCP access' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: 'CLI & API access (PAT)' })).toBeChecked()
})

test('security disables PAT CLI access while preserving MCP access', async ({ page }) => {
  await page.goto('/settings/security')
  await page.getByRole('switch', { name: 'CLI & API access (PAT)' }).uncheck()
  await page.getByRole('button', { name: 'Save agent access' }).click()
  await expect(page.getByTestId('agent-access-notice')).toContainText('Agent access settings saved')
  await expect(page.getByRole('switch', { name: 'MCP access' })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'CLI & API access (PAT)' })).not.toBeChecked()
})

test('security success reflects the authoritative refetched preferences', async ({ page }) => {
  await page.goto('/settings/security')
  await page.getByRole('switch', { name: 'MCP access' }).uncheck()
  await page.getByRole('switch', { name: 'CLI & API access (PAT)' }).uncheck()
  await page.getByRole('button', { name: 'Save agent access' }).click()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'MCP access' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: 'CLI & API access (PAT)' })).not.toBeChecked()
})

test('security reports an update failure without changing displayed preferences', async ({ page }) => {
  await scenario('agent-update-error')
  await page.goto('/settings/security')
  await page.getByRole('switch', { name: 'MCP access' }).uncheck()
  await page.getByRole('button', { name: 'Save agent access' }).click()
  await expect(page.getByTestId('agent-access-error')).toContainText('Could not save agent access settings')
  await expect(page.getByRole('switch', { name: 'MCP access' })).toBeChecked()
  await expect(page.getByTestId('agent-access-notice')).toHaveCount(0)
})

test('security hides agent-access switches when preferences cannot be loaded', async ({ page }) => {
  await scenario('error')
  await page.goto('/settings/security')
  await expect(page.getByText('Could not load agent access settings.')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'MCP access' })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'CLI & API access (PAT)' })).toHaveCount(0)
})

test('security requests a recovery email with a generic confirmation', async ({ page }) => {
  await page.goto('/settings/security')
  await page.getByRole('button', { name: 'Email password-reset link' }).click()
  await expect(page.getByTestId('recovery-notice')).toContainText('Check your email')
})

test('recovery GET waits for human confirmation without consuming the token', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto(`/auth/callback?token_hash=valid-recovery-token-hash-${scenarioToken()}&type=recovery`)
  await expect(page.getByTestId('auth-confirm')).toContainText('resetting your password')
  const cookies = await context.cookies()
  expect(cookies.find((cookie) => cookie.name === 'movp-password-recovery')).toBeUndefined()
  await page.getByRole('button', { name: 'Continue password reset' }).click()
  await page.waitForURL('/settings/security/password')
})

test('recovery POST consumes token_hash and opens the password form', async ({ page, context }) => {
  await openRecoveryPassword(page, context)
  await expect(page.getByTestId('password-form')).toBeVisible()
  const recoveryCookie = (await context.cookies()).find((cookie) => cookie.name === 'movp-password-recovery')
  expect(recoveryCookie?.httpOnly).toBe(true)
})

test('ordinary sessions cannot open the password form', async ({ page }) => {
  await page.goto('/settings/security/password')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('password form rejects a mismatched confirmation', async ({ page, context }) => {
  await openRecoveryPassword(page, context)
  await page.getByLabel('New password', { exact: true }).fill('a-long-password')
  await page.getByLabel('Confirm new password', { exact: true }).fill('a-different-password')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByTestId('password-error')).toContainText('Passwords do not match')
})

test('password update clears recovery and session cookies', async ({ page, context }) => {
  await openRecoveryPassword(page, context)
  await page.getByLabel('New password', { exact: true }).fill('correct horse battery staple')
  await page.getByLabel('Confirm new password', { exact: true }).fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Update password' }).click()
  await page.waitForURL('/login?password=updated')
  await expect(page.getByTestId('password-updated')).toBeVisible()
  const cookies = await context.cookies()
  expect(cookies.find((cookie) => cookie.name === 'sb-access-token')).toBeUndefined()
  expect(cookies.find((cookie) => cookie.name === 'movp-password-recovery')).toBeUndefined()
})

test('logout is a POST that clears the local session', async ({ page, context }) => {
  await page.goto('/')
  await page.getByText('Account', { exact: true }).click()
  await page.getByRole('button', { name: 'Log out' }).click()
  await page.waitForURL('/login')
  expect((await context.cookies()).find((cookie) => cookie.name === 'sb-access-token')).toBeUndefined()
})

test('profile and security pages have no detectable accessibility violations', async ({ page }) => {
  for (const path of ['/settings/profile', '/settings/security']) {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations, path).toEqual([])
  }
})
