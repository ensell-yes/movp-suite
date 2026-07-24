import { generateRobots } from '@movp/delivery'
import type { APIRoute } from 'astro'
import { readServerEnv } from '../lib/env.ts'

export const GET: APIRoute = async () => {
  try {
    const { publicSiteUrl } = readServerEnv()
    return new Response(generateRobots(publicSiteUrl), {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('robots_unavailable\n', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
