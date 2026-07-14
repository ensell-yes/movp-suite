import assert from 'node:assert/strict'
import test from 'node:test'
import { exchangePat } from './integration-smoke-http.mjs'

const request = {
  apiUrl: 'http://127.0.0.1:64321',
  anonKey: 'anon-test-key',
  pat: 'movp_pat_test',
  sleep: async () => {},
}

test('retries transient gateway failures and returns the successful response', async () => {
  const statuses = [502, 200]
  let calls = 0
  const response = await exchangePat({
    ...request,
    fetchImpl: async () => new Response('{}', { status: statuses[calls++] }),
  })

  assert.equal(response.status, 200)
  assert.equal(calls, 2)
})

test('does not retry terminal authentication failures', async () => {
  let calls = 0
  const response = await exchangePat({
    ...request,
    fetchImpl: async () => {
      calls++
      return new Response('{}', { status: 401 })
    },
  })

  assert.equal(response.status, 401)
  assert.equal(calls, 1)
})

test('returns the third transient response after the bounded retry budget', async () => {
  let calls = 0
  const response = await exchangePat({
    ...request,
    fetchImpl: async () => {
      calls++
      return new Response('{}', { status: 504 })
    },
  })

  assert.equal(response.status, 504)
  assert.equal(calls, 3)
})
