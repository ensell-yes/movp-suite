import { beforeAll, describe, expect, it } from 'vitest'
import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const MAX_TEMPLATE_BYTES = 16 * 1024
const templatePath = fileURLToPath(new URL('../../../supabase/templates/recovery.html', import.meta.url))
let source = ''
let templateSize = 0

beforeAll(async () => {
  const entry = await lstat(templatePath)
  expect(entry.isSymbolicLink()).toBe(false)
  expect(entry.isFile()).toBe(true)
  expect(entry.size).toBeLessThanOrEqual(MAX_TEMPLATE_BYTES)
  templateSize = entry.size
  source = await readFile(templatePath, 'utf8')
})

describe('password recovery email template', () => {
  it('is a bounded regular file', () => {
    expect(templateSize).toBeGreaterThan(0)
  })

  it('routes the token hash through the human-confirmation callback', () => {
    expect(source).toContain('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery')
  })

  it('does not use the one-click confirmation URL', () => {
    expect(source).not.toContain('{{ .ConfirmationURL }}')
  })
})
