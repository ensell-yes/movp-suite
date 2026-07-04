import { test, type BrowserContext } from '@playwright/test'

export function scenarioToken(): string {
  const info = test.info()
  const title = info.titlePath.join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return `test-token-${info.workerIndex}-${info.retry}-${title}`
}

export async function scenario(name: string): Promise<void> {
  const token = encodeURIComponent(scenarioToken())
  await fetch(`http://127.0.0.1:4322/scenario?name=${encodeURIComponent(name)}&token=${token}`)
}

export async function seedSession(context: BrowserContext): Promise<void> {
  const token = scenarioToken()
  await scenario('ok')
  await context.addCookies([
    {
      name: 'sb-access-token',
      value: token,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}
