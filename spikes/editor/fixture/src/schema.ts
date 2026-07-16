export interface FieldDef { name: string; type: 'text' | 'richtext' | 'json' }

export const FIXTURE_FIELD_SCHEMA: FieldDef[] = [
  { name: 'title', type: 'text' },
  { name: 'body', type: 'richtext' },
  { name: 'meta', type: 'json' },
]

export const SEED_RECORD: Record<string, unknown> = {
  title: 'Spike Fixture',
  body: '', // each candidate fills via adapter.encode(seedDoc) — the string is candidate-specific
  meta: { locale: 'en', tags: ['spike', 'editor'] },
}
