export interface NotificationMessage {
  to: string
  subject: string
  html: string
  from?: string
}

export interface NotificationProvider {
  send(msg: NotificationMessage): Promise<{ id: string }>
}

const DEFAULT_FROM = 'MOVP <notifications@movp.dev>'

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export class ResendAdapter implements NotificationProvider {
  #key: string

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('resend_missing_api_key')
    this.#key = apiKey
  }

  async send(msg: NotificationMessage): Promise<{ id: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: msg.from ?? DEFAULT_FROM, to: msg.to, subject: msg.subject, html: msg.html }),
    })
    if (!res.ok) throw new Error(`resend_send_failed:${res.status}`)
    const json = (await res.json()) as { id: string }
    return { id: json.id }
  }
}
