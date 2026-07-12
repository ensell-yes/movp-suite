import { createServer } from 'node:http'

export async function startMockCrm() {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/contacts/crm-1') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'crm-1', properties: { stage: 'lead' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock CRM did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
