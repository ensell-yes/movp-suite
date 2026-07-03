export interface SeoInput {
  data: Record<string, unknown>
  meta: Record<string, unknown> | null
  jsonld: unknown | null
  referencedAssets: Array<{ alt_text: string | null }>
}

export interface SeoCheck {
  rule: string
  pass: boolean
}

export interface SeoResult {
  score: number
  checklist: SeoCheck[]
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const isJsonLd = (value: unknown): boolean =>
  !!value && typeof value === 'object' && '@context' in value && '@type' in value

export function auditSeo(input: SeoInput): SeoResult {
  const title = str(input.data.title) || str(input.meta?.title)
  const description = str(input.meta?.description)
  const faqs = Array.isArray(input.data.faqs) ? input.data.faqs : []
  const checklist: SeoCheck[] = [
    { rule: 'title_length', pass: title.length >= 10 && title.length <= 60 },
    { rule: 'meta_description_length', pass: description.length >= 50 && description.length <= 160 },
    { rule: 'canonical_present', pass: str(input.meta?.canonical).length > 0 },
    {
      rule: 'alt_text_coverage',
      pass: input.referencedAssets.every((asset) => !!asset.alt_text && asset.alt_text.trim().length > 0),
    },
    { rule: 'jsonld_valid', pass: isJsonLd(input.jsonld) },
    { rule: 'aeo_answer_present', pass: str(input.data.answer).trim().length > 0 },
    {
      rule: 'faq_complete',
      pass: faqs.length > 0 && faqs.every((faq) => {
        const row = faq as { q?: unknown; a?: unknown } | null
        return !!str(row?.q) && !!str(row?.a)
      }),
    },
  ]
  const passed = checklist.filter((check) => check.pass).length
  return { score: Math.round((passed / checklist.length) * 100), checklist }
}
