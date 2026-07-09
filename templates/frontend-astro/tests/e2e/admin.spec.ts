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

  const memberRow = page.locator('tr', { hasText: 'member-1' })
  await memberRow.getByLabel('Confirm removal of member member-1').check()
  await memberRow.getByRole('button', { name: 'Remove member member-1' }).click()
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

test('admin ingest API keys show raw keys only for create and rotate responses', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/api-keys')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await scenario('empty')
  await page.goto('/admin/api-keys')
  await expect(page.getByTestId('empty')).toBeVisible()
  await expect(page.getByTestId('ingest-key-create-form')).toBeVisible()

  await scenario('ok')
  await page.goto('/admin/api-keys')
  await expect(page.getByTestId('ingest-keys')).toContainText('ci')
  await expect(page.locator('body')).not.toContainText('key_hash')
  await expect(page.locator('body')).not.toContainText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  await page.getByTestId('ingest-key-create-form').getByLabel('Label').fill('ci browser')
  await page.getByRole('button', { name: 'Create ingest key' }).click()
  await expect(page.getByTestId('ingest-key-secret')).toContainText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  await page.reload()
  await expect(page.getByTestId('ingest-key-secret')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  const keyRow = page.locator('tr', { hasText: 'ci' })
  await keyRow.getByLabel('Confirm rotation of ingest key ci').check()
  await keyRow.getByRole('button', { name: 'Rotate ingest key ci' }).click()
  await expect(page.getByTestId('ingest-key-secret')).toContainText('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

  await keyRow.getByLabel('Confirm revocation of ingest key ci').check()
  await keyRow.getByRole('button', { name: 'Revoke ingest key ci' }).click()
  await expect(page.getByTestId('admin-notice')).toContainText('Ingest key revoked')
})

test('admin jobs render counts, payload keys only, and replay dead jobs', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/jobs')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await scenario('empty')
  await page.goto('/admin/jobs')
  await expect(page.getByTestId('empty')).toBeVisible()
  await expect(page.getByTestId('job-counts')).toContainText('dead')

  await scenario('ok')
  await page.goto('/admin/jobs')
  await expect(page.getByTestId('job-counts')).toContainText('dead')
  await expect(page.getByTestId('job-counts')).toContainText('1')
  await expect(page.getByTestId('dead-jobs')).toContainText('secret_url')
  await expect(page.locator('body')).not.toContainText('evil.example')

  await page.getByLabel('Confirm replay of dead jobs').check()
  await page.getByRole('button', { name: 'Replay dead jobs in this workspace' }).click()
  await expect(page.getByTestId('admin-notice')).toContainText('Replayed 1 dead jobs')
})

test('admin collection browser lists public collections and edits a row', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/collections')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await scenario('empty')
  await page.goto('/admin/collections')
  await expect(page.getByTestId('empty')).toBeVisible()

  await scenario('ok')
  await page.goto('/admin/collections')
  await expect(page.getByTestId('collections-meta')).toContainText('Notes')
  await expect(page.getByTestId('collections-meta')).not.toContainText('Task')

  await page.goto('/admin/collections/note')
  await expect(page.getByTestId('collection-rows')).toContainText('First note')
  await page.getByLabel('Title').fill('Edited note')
  await page.getByRole('button', { name: 'Save row' }).click()
  await expect(page.getByTestId('admin-notice')).toContainText('Row updated')
})

test('admin settings render workspace and retention advisory', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/admin/settings')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await page.goto('/admin/settings')
  await expect(page.getByTestId('workspace-settings')).toContainText('Acme')
  await expect(page.getByTestId('workspace-settings')).toContainText('2')
  await expect(page.getByTestId('retention-advisory')).toContainText('deploy-time pg_cron')
  await expect(page.getByRole('link', { name: 'Event catalog and workflow rules' })).toHaveAttribute('href', '/workflows/rules')
})

for (const path of ['/admin', '/admin/members', '/admin/api-keys', '/admin/jobs', '/admin/collections', '/admin/collections/note', '/admin/settings', '/auth/accept-invite?token=invite-token-1234567890']) {
  test(`admin a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
