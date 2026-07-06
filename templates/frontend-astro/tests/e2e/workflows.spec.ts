import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { scenario, seedSession } from './scenario.ts'

test.beforeEach(async ({ context }) => {
  await seedSession(context)
})

test('workflow rules auth, error, empty, and save paths render', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/workflows/rules')
  await expect(page.getByTestId('auth-failure')).toBeVisible()

  await seedSession(context)
  await scenario('error')
  await page.goto('/workflows/rules')
  await expect(page.getByTestId('error')).toBeVisible()

  await scenario('empty')
  await page.goto('/workflows/rules')
  await expect(page.getByTestId('empty')).toBeVisible()
  await expect(page.getByTestId('workflow-rule-form')).toBeVisible()

  await scenario('ok')
  await page.goto('/workflows/rules')
  await expect(page.getByTestId('workflow-rules')).toContainText('task.completed')
  await expect(page.getByTestId('workflow-rules')).toContainText('notify')
  await page.getByLabel('Trigger').selectOption('evt-task-completed')
  await page.getByLabel('Condition JSON').fill('{not-json')
  await page.getByRole('button', { name: 'Save rule' }).click()
  await expect(page.getByTestId('workflow-form-error')).toContainText('Condition JSON')
  await expect(page.getByTestId('workflow-rule-form')).toBeVisible()

  await page.getByLabel('Trigger').selectOption('evt-task-completed')
  await page.getByLabel('Condition JSON').fill('{"field":"status","op":"eq","value":"done"}')
  await page.getByLabel('Action config JSON').fill('{"recipient_user_id":"user-2"}')
  await page.getByRole('button', { name: 'Save rule' }).click()
  await expect(page.getByTestId('workflow-notice')).toContainText('Rule saved')
})

test('workflow webhooks show generated secrets only for the mutation response', async ({ page }) => {
  await page.goto('/workflows/webhooks')
  await expect(page.getByTestId('workflow-webhooks')).toContainText('https://hooks.example.test/workflows')
  await expect(page.getByTestId('workflow-webhooks')).not.toContainText('register-secret-value')

  await page.getByLabel('URL').fill('https://hooks.example.test/new')
  await page.getByRole('button', { name: 'Register webhook' }).click()
  await expect(page.getByTestId('webhook-secret')).toContainText('register-secret-value-1234567890')

  await page.reload()
  await expect(page.getByTestId('workflow-webhooks')).toBeVisible()
  await expect(page.getByTestId('webhook-secret')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('register-secret-value-1234567890')

  await page.getByRole('button', { name: 'Rotate secret' }).click()
  await expect(page.getByTestId('webhook-secret')).toContainText('rotated-secret-value-1234567890')
})

test('workflow audit lists runs, replays dead jobs, and redacts event payload values', async ({ page }) => {
  await page.goto('/workflows/runs')
  await expect(page.getByTestId('workflow-runs')).toContainText('task.completed')
  await expect(page.getByTestId('workflow-runs')).toContainText('condition_not_matched')

  await page.getByRole('button', { name: 'Replay dead workflow jobs' }).click()
  await expect(page.getByTestId('workflow-notice')).toContainText('Replayed 2 jobs')

  await page.getByRole('link', { name: 'task.completed' }).click()
  await expect(page.getByTestId('workflow-event-detail')).toContainText('task.completed')
  await expect(page.getByTestId('workflow-event-detail')).toContainText('task_id')
  await expect(page.getByTestId('workflow-event-detail')).toContainText('email')
  await expect(page.locator('body')).not.toContainText('member@example.com')
  await expect(page.locator('body')).not.toContainText('Secret body should not render')
})

test('workflow admin keyboard starts with skip link', async ({ page }) => {
  await page.goto('/workflows/rules')
  await page.keyboard.press('Tab')
  await expect(page.getByText('Skip to content')).toBeFocused()
})

for (const path of ['/workflows/rules', '/workflows/webhooks', '/workflows/runs']) {
  test(`workflow a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
