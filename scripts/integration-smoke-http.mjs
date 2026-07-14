const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504])
const MAX_ATTEMPTS = 3

export async function exchangePat({ apiUrl, anonKey, pat, fetchImpl = fetch, sleep = defaultSleep }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetchImpl(`${apiUrl}/functions/v1/auth-exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, apikey: anonKey, 'content-type': 'application/json' },
      body: '{}',
    })
    if (RETRYABLE_GATEWAY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(500)
      continue
    }
    return response
  }
  throw new Error('exchange smoke PAT: retry loop exhausted without a response')
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
