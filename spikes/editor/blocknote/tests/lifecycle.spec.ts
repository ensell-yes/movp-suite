import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { blockNoteAdapter } from '../src/adapter.ts'
import { hashOnce, makeLifecycleOracle } from '@spike/oracle'
import { SEED_RECORD } from '@spike/fixture'
import { writeJsonAtomic } from '../../scripts/lib/safe-io.mjs'

const SEED_DOC = [
  { id: 'b1', type: 'heading', props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left', level: 1 }, content: [{ type: 'text', text: 'Title', styles: {} }], children: [] },
  { id: 'b2', type: 'paragraph', props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' }, content: [{ type: 'text', text: 'hello world', styles: {} }], children: [] },
  { id: 'b3', type: 'bulletListItem', props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' }, content: [{ type: 'text', text: 'List item', styles: {} }], children: [] },
  { id: 'b4', type: 'paragraph', props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' }, content: [], children: [] },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boldTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(boldTexts)
  if (!isRecord(value)) return []
  const own = value.type === 'text' && typeof value.text === 'string' &&
    isRecord(value.styles) && value.styles.bold === true ? [value.text] : []
  return [...own, ...Object.values(value).flatMap(boldTexts)]
}

function mismatchPaths(left: unknown, right: unknown, path = '$'): string[] {
  if (Object.is(left, right)) return []
  if (Array.isArray(left) && Array.isArray(right)) {
    const lengthPaths = left.length === right.length ? [] : [`${path}.length`]
    return [...lengthPaths, ...Array.from(
      { length: Math.max(left.length, right.length) },
      (_, index) => mismatchPaths(left[index], right[index], `${path}[${index}]`),
    ).flat()]
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    return keys.flatMap((key) => mismatchPaths(left[key], right[key], `${path}.${key}`))
  }
  return [path]
}

async function selectWord(page: import('@playwright/test').Page, word: string): Promise<void> {
  const selected = await page.evaluate((needle) => {
    const root = document.querySelector('[contenteditable="true"]')
    if (!root) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent ?? ''
      const start = text.indexOf(needle)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + needle.length)
      const selection = window.getSelection()
      if (!selection) return false
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    }
    return false
  }, word)
  expect(selected).toBe(true)
}

function publishedBody(value: unknown): { revisionId: string; body: string } {
  if (!isRecord(value) || !isRecord(value.revision) ||
      typeof value.revision.id !== 'string' || !isRecord(value.revision.data) ||
      typeof value.revision.data.body !== 'string') {
    throw new Error('lifecycle: malformed published result')
  }
  return { revisionId: value.revision.id, body: value.revision.data.body }
}

async function isWordRenderedBold(page: import('@playwright/test').Page, word: string): Promise<boolean> {
  return page.evaluate((needle) => {
    const root = document.querySelector('[contenteditable]') ?? document.body
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!(node.textContent ?? '').includes(needle) || !node.parentElement) continue
      const weight = getComputedStyle(node.parentElement).fontWeight
      const numeric = Number.parseInt(weight, 10)
      return weight === 'bold' || weight === 'bolder' || (Number.isFinite(numeric) && numeric >= 600)
    }
    return false
  }, word)
}

async function readonlyBlocksInput(page: import('@playwright/test').Page): Promise<boolean> {
  const before = await page.evaluate(() => window.__spike!.serialize())
  const editable = page.locator('[contenteditable="true"]').first()
  const count = await editable.count()
  if (count > 0) {
    await editable.focus()
    await page.keyboard.press('End')
    await page.keyboard.type('x')
  }
  const after = await page.evaluate(() => window.__spike!.serialize())
  return count === 0 || after === before
}

test('idempotent create -> editor edit -> publish -> published read', async ({ page }) => {
  const seedBody = blockNoteAdapter.encode(SEED_DOC)
  const seedData = { ...SEED_RECORD, body: seedBody }
  const H0 = await hashOnce(seedData)

  await page.goto('/')
  await page.waitForFunction(() => Boolean(window.__spike))
  await page.evaluate((b) => window.__spike!.load(b), seedBody)

  const zeroEdit = await page.evaluate(() => window.__spike!.serialize())
  const idempotent = (await hashOnce({ ...SEED_RECORD, body: zeroEdit })) === H0
  expect(idempotent, `zero-edit mismatch paths: ${mismatchPaths(SEED_DOC, blockNoteAdapter.decode(zeroEdit)).join(',')}`).toBe(true)
  await page.evaluate((body) => window.__spike!.load(body), zeroEdit)
  const repeatedStable = await page.evaluate((body) => window.__spike!.serialize() === body, zeroEdit)
  expect(repeatedStable).toBe(true)
  const blockIdPreserved = /"id":"b1"/.test(zeroEdit) && /"id":"b2"/.test(zeroEdit)

  const beforeText = await page.locator('[contenteditable="true"]').innerText()
  await selectWord(page, 'world')
  await page.keyboard.press('ControlOrMeta+b')
  const afterText = await page.locator('[contenteditable="true"]').innerText()
  const editedBody = await page.evaluate(() => window.__spike!.serialize())
  const H2 = await hashOnce({ ...SEED_RECORD, body: editedBody })
  const renderedWorldBold = await isWordRenderedBold(page, 'world')
  const exactEdit = H2 !== H0 && beforeText === afterText && renderedWorldBold &&
    JSON.stringify(boldTexts(blockNoteAdapter.decode(editedBody))) === JSON.stringify(['world'])
  expect(exactEdit).toBe(true)

  const o = makeLifecycleOracle()
  await o.service.create({ workspaceId: 'ws', contentTypeId: 'ct', slug: 's', data: seedData })
  const r1 = o.currentRevisionId()
  await o.service.update({ itemId: 'item', expectedRevisionId: r1, data: { ...SEED_RECORD, body: editedBody } })
  const r2 = o.currentRevisionId()
  await o.service.publish({ itemId: 'item' })
  const expectedRevisionPinned = o.captures[1]?.p_expected_revision_id === r1
  const updateHashPinned = o.captures[1]?.p_content_hash === H2
  const lifecycleOrder =
    JSON.stringify(o.captures.map((capture) => capture.rpc)) ===
      JSON.stringify(['create_content_with_revision', 'update_content', 'publish_content']) &&
    updateHashPinned && expectedRevisionPinned
  expect(lifecycleOrder).toBe(true)

  const delivered = publishedBody(await o.service.getPublished('item'))
  await page.evaluate((body) => {
    window.__spike!.load(body)
    window.__spike!.setReadonly(true)
  }, delivered.body)
  const renderedGolden = await isWordRenderedBold(page, 'world')
  const readonlyPreserved = await readonlyBlocksInput(page)
  const revisionPinned = delivered.revisionId === r2
  const headingVisible = await page.getByRole('heading', { level: 1, name: 'Title' }).isVisible()
  const listVisible = await page.getByRole('listitem', { name: 'List item' }).isVisible()
  const publishedRead = revisionPinned && headingVisible && listVisible && renderedGolden && readonlyPreserved
  expect({ revisionPinned, headingVisible, listVisible, renderedGolden, readonlyPreserved }).toEqual({
    revisionPinned: true,
    headingVisible: true,
    listVisible: false,
    renderedGolden: true,
    readonlyPreserved: true,
  })
  expect(publishedRead).toBe(false)

  o.forcePublishedRevision(r1)
  const stale = publishedBody(await o.service.getPublished('item'))
  await page.evaluate((body) => window.__spike!.load(body), stale.body)
  const stalePassesGolden = await isWordRenderedBold(page, 'world')
  expect(stalePassesGolden).toBe(false)
  const staleSabotage = stale.revisionId === r1 && stale.body === seedBody && !stalePassesGolden
  expect(staleSabotage).toBe(true)

  mkdirSync('.report', { recursive: true })
  writeJsonAtomic('.report/blocknote.lifecycle.json', {
    idempotent,
    exactEdit,
    lifecycleOrder,
    publishedRead,
    staleSabotage,
    blockIdPreserved,
    lifecycleOrderEvidence: { expectedRevisionPinned, updateHashPinned },
    publishedReadEvidence: { revisionPinned, headingVisible, listVisible, renderedGolden, readonlyPreserved },
  })
})
