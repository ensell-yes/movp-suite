import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { scenario, seedSession } from './scenario.ts'

const CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src https: data:; script-src 'self'; connect-src 'self'; style-src 'self'"

test.describe('inline overlay', () => {
  test('authorized editor primes once, mounts lazily, saves, and returns focus', async ({
    context,
    page,
  }) => {
    await seedSession(context)
    const probeResponses: number[] = []
    const editableReads: string[] = []
    const cspViolations: string[] = []
    page.on('response', (response) => {
      if (response.url().includes('/capability')) probeResponses.push(response.status())
      if (
        response.request().method() === 'GET'
        && response.url().includes('/richtext?fieldKey=')
      ) editableReads.push(response.url())
    })
    page.on('console', (message) => {
      const text = message.text()
      if (/content security policy|refused to|csp/i.test(text)) cspViolations.push(text)
    })

    const response = await page.goto('/article/published-page')
    expect(response?.headers()['content-security-policy']).toBe(CSP)
    await expect(page.getByRole('button', { name: 'Edit body', exact: true })).toHaveCount(0)
    expect(probeResponses).toEqual([])

    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Edit body', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Edit body' })).toHaveCount(0)
    expect(probeResponses).toEqual([200])

    const trigger = page.getByRole('button', { name: 'Edit body', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Edit body' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close body editor' })).toBeFocused()
    expect(editableReads).toHaveLength(1)
    await expect(dialog.getByRole('textbox', { name: 'Rich text editor' })).toBeVisible()
    const saveResponsePromise = page.waitForResponse((candidate) =>
      candidate.request().method() === 'POST'
      && candidate.url().endsWith(`/api/content/11111111-1111-4111-8111-111111111111/richtext`)
    )
    await dialog.getByRole('button', { name: 'Save content' }).click()
    const saveResponse = await saveResponsePromise
    // An expect() message is evaluated even on success. This page-network body read crosses CDP
    // and can race Chrome's buffer eviction, so keep the diagnostic best-effort.
    const saveBody = await saveResponse.text().catch(() => '<body unavailable>')
    expect(saveResponse.status(), saveBody).toBe(200)
    await expect(dialog.getByRole('status')).toHaveText('Saved')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()

    const inlineStyleElements = await page.locator('[style]').evaluateAll((elements) =>
      elements.map((element) => ({
        tag: element.tagName,
        className: element.getAttribute('class'),
        styleNames: Array.from((element as HTMLElement).style).sort(),
      }))
    )
    expect(inlineStyleElements).toEqual([])
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations.filter((violation) =>
      violation.impact === 'serious' || violation.impact === 'critical'
    )).toEqual([])
    expect(cspViolations).toEqual([])
  })

  test('surfaces conflict and a safe actionable save error', async ({ context, page }) => {
    await seedSession(context)
    await scenario('conflict')
    await page.goto('/article/published-page')
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: 'Edit body', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Edit body' })
    await dialog.getByRole('button', { name: 'Save content' }).click()
    await expect(dialog.getByRole('button', { name: 'Refresh revision' })).toBeVisible()

    await scenario('save-error')
    await dialog.getByRole('button', { name: 'Save content' }).click()
    await expect(dialog.getByRole('alert')).toContainText(
      'You no longer have permission to edit this field.',
    )
  })

  test('anonymous views stay request-free until interaction and cache denial for the tab', async ({
    page,
  }) => {
    const probeRequests: string[] = []
    const editorScripts: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/capability')) probeRequests.push(request.url())
      if (request.resourceType() === 'script' && /editor|tiptap|overlay/i.test(request.url())) {
        editorScripts.push(request.url())
      }
    })

    await page.goto('/article/published-page')
    expect(probeRequests).toEqual([])
    await expect(page.getByRole('button', { name: 'Edit body', exact: true })).toHaveCount(0)

    await page.locator('h1').click()
    await expect.poll(() => probeRequests.length).toBe(1)
    await expect(page.getByRole('button', { name: 'Edit body', exact: true })).toHaveCount(0)
    expect(editorScripts).toEqual([])

    await page.reload()
    await page.keyboard.press('Tab')
    await page.waitForTimeout(100)
    expect(probeRequests).toHaveLength(1)
  })

  test('member capability denial never loads editor code', async ({ context, page }) => {
    await seedSession(context)
    await scenario('member')
    const editorScripts: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && /editor|tiptap/i.test(request.url())) {
        editorScripts.push(request.url())
      }
    })
    await page.goto('/article/published-page')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Edit body' })).toHaveCount(0)
    expect(editorScripts).toEqual([])
  })

  test('reduced motion removes overlay control transitions', async ({ context, page }) => {
    await seedSession(context)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/article/published-page')
    await page.keyboard.press('Tab')
    const trigger = page.getByRole('button', { name: 'Edit body', exact: true })
    await expect(trigger).toBeVisible()
    expect(await trigger.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s')
  })
})
