import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { scenario, seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

test('admin members auth, error, empty, invite, role, and remove paths render', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/members')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await scenario('error')
  await page.goto('/admin/members')
  await expect(page.getByTestId('error')).toBeVisible()

  await scenario('empty')
  await page.goto('/admin/members')
  await expect(page.getByTestId('empty')).toBeVisible()
  await expect(page.getByTestId('member-invite-form')).toBeVisible()

  await scenario('ok')
  await page.goto('/admin/members')
  await expect(page.getByTestId('workspace-members')).toContainText('owner-1')
  await expect(page.getByTestId('workspace-members')).toContainText('member-1')

  const inviteForm = page.getByTestId('member-invite-form')
  await inviteForm.getByLabel('Email').fill('invitee@example.test')
  await inviteForm.getByLabel('Role').selectOption('member')
  await inviteForm.getByRole('button', { name: 'Invite member' }).click()
  await expect(page.getByTestId('admin-notice')).toContainText('Invite created')
  await expect(page.getByTestId('admin-invite-token')).toContainText('/auth/accept-invite?token=invite-token-1234567890')

  await page.reload()
  await expect(page.getByTestId('admin-invite-token')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('invite-token-1234567890')

  await page.locator('tr', { hasText: 'member-1' }).getByLabel('Role').selectOption('admin')
  await page.locator('tr', { hasText: 'member-1' }).getByRole('button', { name: 'Set role' }).click()
  await expect(page.getByTestId('admin-notice')).toContainText('Role updated')

  await page.locator('tr', { hasText: 'member-1' }).getByRole('button', { name: 'Remove member' }).click()
  await expect(page.getByTestId('admin-notice')).toContainText('Member removed')
})

test('accept invite requires auth and handles success and invalid tokens', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/auth/accept-invite?token=invite-token-1234567890')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await page.goto('/auth/accept-invite?token=invite-token-1234567890')
  await expect(page.getByTestId('accept-invite-form')).toBeVisible()
  await page.getByRole('button', { name: 'Accept invite' }).click()
  await expect(page.getByTestId('invite-accepted')).toContainText('member')

  await page.goto('/auth/accept-invite?token=bad-token')
  await page.getByRole('button', { name: 'Accept invite' }).click()
  await expect(page.getByTestId('invite-error')).toContainText('P0001')
})

for (const path of ['/admin/members', '/auth/accept-invite?token=invite-token-1234567890']) {
  test(`admin a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
