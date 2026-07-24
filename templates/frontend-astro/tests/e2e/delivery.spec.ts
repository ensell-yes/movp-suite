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
    await expect(page).toHaveTitle('Published page')
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'http://127.0.0.1:8788/article/published-page',
    )
    await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible()
    await expect(page.locator('img')).toHaveCount(0)
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
