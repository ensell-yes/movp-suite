import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { writeJsonAtomic } from '../../scripts/lib/safe-io.mjs'

test('a11y: exact BlockNote violation classified; shell, focus, and toolbar clean', async ({ page, browser }) => {
  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.__spike))
  const results = await new AxeBuilder({ page }).analyze()
  const violationIds = results.violations.map((item) => item.id).sort()
  const violationNodeCount = results.violations.reduce((count, item) => count + item.nodes.length, 0)
  expect({ violationIds, violationNodeCount }).toEqual({
    violationIds: ['aria-allowed-attr'],
    violationNodeCount: 1,
  })
  expect(results.incomplete, JSON.stringify(results.incomplete, null, 2)).toEqual([])

  for (const name of ['Bold', 'Heading 1', 'Bullet list', 'Undo', 'Redo']) {
    await expect(page.getByRole('button', { name })).toBeVisible()
  }
  await page.keyboard.press('Tab')
  const onEditor = await page.evaluate(() => {
    const active = document.activeElement
    return active !== null && active.tagName !== 'BODY' &&
      (active.getAttribute('contenteditable') === 'true' ||
       (active.tagName === 'BUTTON' && Boolean(active.getAttribute('aria-label'))))
  })
  expect(onEditor).toBe(true)

  mkdirSync('.report', { recursive: true })
  writeJsonAtomic('.report/blocknote.a11y.json', {
    a11y: false,
    violationIds,
    violationCount: results.violations.length,
    violationNodeCount,
    runtime: { node: process.versions.node, browserChannel: 'chrome', browserVersion: browser.version() },
  })
})
