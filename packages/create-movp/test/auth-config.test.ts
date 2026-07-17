import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileGuarded } from '../src/copier.ts'

// The 4 scaffoldable app templates ship a shared Supabase Auth config. F4 (movp-prod, 2026-07-16):
// a hosted project left on Supabase Cloud's defaults — localhost Site URL + the *implicit* Magic
// Link template — silently breaks the server-side /auth/callback (token_hash) verify, because the
// implicit flow returns the session in a URL fragment the server callback never sees. These pins
// keep the scaffold default F4-correct so it cannot regress to the implicit `{{ .ConfirmationURL }}`
// form. frontend-astro is excluded on purpose: it carries the login/callback pages but no supabase/
// config, and it is not a create-movp scaffold choice.
const appTemplates = ['crm-lite', 'marketing-site', 'support-desk', 'knowledge-base'] as const

function readTemplateFile(template: string, relativePath: string): string {
  const path = fileURLToPath(new URL(`../../../templates/${template}/${relativePath}`, import.meta.url))
  return readFileGuarded(path).toString('utf8')
}

describe('scaffold Supabase Auth config stays F4-correct (magic-link token_hash)', () => {
  for (const template of appTemplates) {
    it(`${template}: magic_link.html uses the token_hash form, not the implicit ConfirmationURL`, () => {
      const html = readTemplateFile(template, 'supabase/templates/magic_link.html')
      expect(html).toContain('token_hash={{ .TokenHash }}')
      expect(html).not.toContain('{{ .ConfirmationURL }}')
    })

    it(`${template}: config.toml binds the magic_link template to the shipped file`, () => {
      const config = readTemplateFile(template, 'supabase/config.toml')
      expect(config).toMatch(/\[auth\.email\.template\.magic_link\]/)
      expect(config).toMatch(/content_path\s*=\s*"\.\/supabase\/templates\/magic_link\.html"/)
    })

    it(`${template}: additional_redirect_urls allowlists an /auth/callback route`, () => {
      const config = readTemplateFile(template, 'supabase/config.toml')
      expect(config).toMatch(/additional_redirect_urls\s*=\s*\[/)
      expect(config).toMatch(/\/auth\/callback"/)
    })
  }
})
