import { assert, provision, type E2eEnv } from './lib.ts'

const env: E2eEnv = {
  url: Deno.env.get('SUPABASE_URL')!,
  anon: Deno.env.get('SUPABASE_ANON_KEY')!,
  serviceRole: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
}
const fnUrl = Deno.env.get('GRAPHQL_URL') ?? `${env.url}/functions/v1/graphql`
const { accessToken, workspaceId } = await provision(env)

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: env.anon,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  return { status: res.status, body: await res.json() }
}

{
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: { apikey: env.anon, 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  })
  assert(res.status === 401, `expected 401 without token, got ${res.status}`)
}

const created = await gql(
  'mutation ($i: NoteCreateInput!) { createNote(input: $i) { id title status } }',
  { i: { workspace_id: workspaceId, title: 'Hello', status: 'draft' } },
)
assert(created.body?.data?.createNote?.title === 'Hello', `create failed: ${JSON.stringify(created.body)}`)
const id = created.body.data.createNote.id

const got = await gql('query ($id: ID!) { note(id: $id) { id title } }', { id })
assert(got.body?.data?.note?.id === id, `query failed: ${JSON.stringify(got.body)}`)

const over = await gql(
  `query { notes(workspaceId: "${workspaceId}", first: 1000) {
      items { id title body status workspace_id created_at updated_at tags { id } } nextCursor } }`,
)
assert((over.body?.errors?.length ?? 0) > 0 && over.body?.data == null, `expected rejection: ${JSON.stringify(over.body)}`)

const listed = await gql(`query { notes(workspaceId: "${workspaceId}", first: 5) { items { id } nextCursor } }`)
assert(Array.isArray(listed.body?.data?.notes?.items), `list failed: ${JSON.stringify(listed.body)}`)

console.log('GRAPHQL_SMOKE_OK')
