export async function syncRecord({ crmUrl, apiUrl, anonKey, token, workspaceId, source }) {
  const crmResponse = await fetch(`${crmUrl}/contacts/crm-1`)
  if (!crmResponse.ok) throw new Error(`mock CRM returned HTTP ${crmResponse.status}`)
  const record = await crmResponse.json()
  if (!record || typeof record.id !== 'string' || !record.properties || typeof record.properties !== 'object') {
    throw new Error('mock CRM returned an invalid contact')
  }

  const response = await fetch(`${apiUrl}/rest/v1/rpc/upsert_by_external_ref`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ws: workspaceId, source, external_id: record.id, payload: record.properties }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`upsert_by_external_ref returned HTTP ${response.status}`)
  return body
}
