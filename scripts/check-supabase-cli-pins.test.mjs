import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSupabaseCliPins } from './check-supabase-cli-pins.mjs'

const workflow = (steps) => `jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
${steps}
`

test('accepts unquoted, double-quoted, and single-quoted 2.109.1 pins', () => {
  const source = workflow(`      - uses: supabase/setup-cli@v2
        with: { version: 2.109.1 }
      - name: Install Supabase
        id: supabase
        uses: supabase/setup-cli@v2
        with: { version: "2.109.1" }
      - uses: supabase/setup-cli@v2
        with: { version: '2.109.1' }`)

  assert.deepEqual(checkSupabaseCliPins(source), [])
})

test('rejects latest even when a comment contains the expected pin', () => {
  const source = workflow(`      - uses: supabase/setup-cli@v2
        # with: { version: 2.109.1 }
        with: { version: latest }`)

  assert.match(checkSupabaseCliPins(source)[0], /^supabase_cli_pin_missing:/)
})

test('rejects an unpinned step when a different step contains a decoy pin', () => {
  const source = workflow(`      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: echo 'with: { version: 2.109.1 }'`)

  assert.match(checkSupabaseCliPins(source)[0], /^supabase_cli_pin_missing:/)
})

test('rejects a different quoted version', () => {
  const source = workflow(`      - uses: supabase/setup-cli@v2
        with: { version: "2.99.9" }`)

  assert.match(checkSupabaseCliPins(source)[0], /^supabase_cli_pin_missing:/)
})

test('rejects a setup step with no version', () => {
  const source = workflow('      - uses: supabase/setup-cli@v2')

  assert.match(checkSupabaseCliPins(source)[0], /^supabase_cli_pin_missing:/)
})

test('fails when the workflow contains no setup-cli step', () => {
  assert.deepEqual(checkSupabaseCliPins(workflow('      - run: echo ok')), ['supabase_cli_step_missing'])
})
