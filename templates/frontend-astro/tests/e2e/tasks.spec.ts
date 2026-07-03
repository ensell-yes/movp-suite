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

test('tasks auth failure renders without a cookie', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/tasks')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
})

test('tasks list renders seeded tasks', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('tasks-list')).toContainText('Ship task')
})

test('task board renders status columns', async ({ page }) => {
  await page.goto('/tasks/board')
  await expect(page.getByTestId('task-board')).toContainText('Todo')
  await expect(page.getByTestId('task-board')).toContainText('Ship task')
})

test('task detail renders description discussion and subtasks', async ({ page }) => {
  await page.goto('/tasks/t1')
  await expect(page.getByTestId('task-detail')).toContainText('Ship task')
  await expect(page.getByTestId('task-detail')).toContainText('Task body text')
  await expect(page.getByTestId('task-comments')).toContainText('Looks good')
  await expect(page.getByTestId('task-subtasks')).toContainText('Write subtask')
})

test('assigned inbox tab renders task assignment items', async ({ page }) => {
  await page.goto('/inbox?tab=assigned')
  await expect(page.getByRole('link', { name: 'assigned', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('inbox-list')).toContainText('task.assigned')
})

for (const path of ['/tasks', '/tasks/board', '/tasks/t1', '/inbox?tab=assigned']) {
  test(`task a11y smoke: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
  })
}
