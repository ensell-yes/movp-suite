import { expect, test } from '@playwright/test'
import { scenario, scenarioToken } from './scenario.ts'

test('unauthenticated home links to login', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/')
  await expect(page.getByTestId('auth-failure')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
})

test('login page renders and submits a magic-link request', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeDisabled()

  await page.getByLabel('Email').fill('demo-owner@example.test')
  await page.getByRole('button', { name: 'Send magic link' }).click()
  await expect(page.getByTestId('login-sent')).toContainText('Check your email')
})

test('token_hash callback verifies with Supabase Auth and sets the session cookie', async ({ page, context }) => {
  await page.goto('/auth/callback?token_hash=valid-token-hash&type=email')
  await page.waitForURL('/')
  const cookie = (await context.cookies()).find((c) => c.name === 'sb-access-token')
  expect(cookie?.value).toBe('verified-login-token-1234567890')
  await expect(page.getByTestId('notes-list')).toContainText('First note')
})

test('invalid token_hash renders login error without setting a cookie', async ({ page, context }) => {
  await page.goto('/auth/callback?token_hash=bad-token&type=email')
  await page.waitForURL('/login?error=invalid_token')
  expect((await context.cookies()).find((c) => c.name === 'sb-access-token')).toBeUndefined()
  await expect(page.getByTestId('login-error')).toBeVisible()
})

test('verified direct token callback sets the session cookie', async ({ page, context }) => {
  await scenario('ok')
  const token = scenarioToken()
  await page.goto(`/auth/callback?access_token=${encodeURIComponent(token)}`)
  await page.waitForURL('/')
  const cookie = (await context.cookies()).find((c) => c.name === 'sb-access-token')
  expect(cookie?.value).toBe(token)
  await expect(page.getByTestId('notes-list')).toContainText('First note')
})

test('invalid direct token callback sets no cookie and renders login error', async ({ page, context }) => {
  await page.goto('/auth/callback?access_token=invalid')
  await page.waitForURL('/login?error=invalid_token')
  expect((await context.cookies()).find((c) => c.name === 'sb-access-token')).toBeUndefined()
  await expect(page.getByTestId('login-error')).toBeVisible()
})

test('test shortcut is unavailable unless explicitly enabled', async ({ page }) => {
  const res = await page.goto('/auth/callback?test=1&access_token=test-token-shortcut-1234567890')
  expect(res?.status()).toBe(404)
})
