import { expect, test } from '@playwright/test'

test.describe('published delivery', () => {
  test('serves only a typed published route with bounded cache headers', async ({ page }) => {
    const requestedScripts: string[] = []
    page.on('request', (request) => {
      if (request.resourceType() === 'script') requestedScripts.push(request.url())
    })

    const response = await page.goto('/article/published-page')

    expect(response?.status()).toBe(200)
    expect(response?.headers()['cache-control']).toBe('public, s-maxage=60')
    expect(response?.headers()['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src https: data:; script-src 'self'; connect-src 'self'; style-src 'self'",
    )
    await expect(page).toHaveTitle('Published page')
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'http://127.0.0.1:8788/article/published-page',
    )
    await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible()
    await expect(page.locator('img')).toHaveCount(0)
    await expect(page.locator('[data-movp-field="body"]')).toHaveCount(1)
    await expect(page.locator('[data-movp-field="bodyHtml"]')).toHaveCount(1)
    await expect(page.locator('p[data-field="bodyHtml"]')).toHaveCount(0)
    await expect(page.getByText('Camel rich text', { exact: true })).toBeVisible()
    await expect(page.locator('[data-movp-field="lookalike"]')).toHaveCount(0)
    expect(requestedScripts.filter((url) => /editor|tiptap/i.test(url))).toEqual([])
  })

  test('maps unpublished and wrong-type lookups to the same no-store 404', async ({ request }) => {
    for (const path of ['/article/draft-page', '/note/published-page']) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(404)
      expect(response.headers()['cache-control'], path).toBe('no-store')
      expect(await response.text(), path).not.toContain('Published page')
    }
  })

  test('keeps experiment delivery private and mints one signed HttpOnly cookie', async ({ request }) => {
    const first = await request.get('/article/experiment-page')

    expect(first.status()).toBe(200)
    expect(first.headers()['cache-control']).toBe('no-store')
    expect(first.headers().vary).toBeUndefined()
    expect(await first.text()).toContain('Experiment variant page')
    const setCookie = first.headers()['set-cookie']
    expect(setCookie).toMatch(/^movp-ab-assignment=[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{43};/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')

    const cookie = setCookie?.split(';', 1)[0]
    expect(cookie).toBeTruthy()
    const returning = await request.get('/article/experiment-page', {
      headers: { cookie: String(cookie) },
    })

    expect(returning.status()).toBe(200)
    expect(returning.headers()['cache-control']).toBe('no-store')
    expect(returning.headers().vary).toBeUndefined()
    expect(await returning.text()).toContain('Experiment variant page')
    expect(returning.headers()['set-cookie']).toBeUndefined()
  })

  test('serves bounded sitemap index and child artifacts', async ({ request }) => {
    const index = await request.get('/sitemap.xml')
    expect(index.status()).toBe(200)
    expect(index.headers()['cache-control']).toBe('public, s-maxage=60')
    const indexBody = await index.text()
    const childPath = indexBody.match(/http:\/\/127\.0\.0\.1:8788(\/sitemap-[A-Za-z0-9_-]+\.xml)/)?.[1]
    expect(childPath).toBeTruthy()

    const child = await request.get(String(childPath))
    expect(child.status()).toBe(200)
    expect(await child.text()).toContain('http://127.0.0.1:8788/article/published-page')
  })

  test('serves robots and llms discovery artifacts', async ({ request }) => {
    const robots = await request.get('/robots.txt')
    expect(robots.status()).toBe(200)
    expect(await robots.text()).toContain('Sitemap: http://127.0.0.1:8788/sitemap.xml')

    const llms = await request.get('/llms.txt')
    expect(llms.status()).toBe(200)
    expect(await llms.text()).toContain('http://127.0.0.1:8788/article/published-page')
  })
})
