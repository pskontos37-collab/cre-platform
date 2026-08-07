// CI smoke suite — runs against a build pointed at the STAGING Supabase project
// (never production; the workflow builds with staging VITE_ vars). Three checks:
// the auth gate holds, a real login lands in the app shell, and the core pages
// render live data through PostgREST + RLS as an authenticated user.
import { test, expect, type Page } from '@playwright/test'

const EMAIL = process.env.STAGING_SMOKE_EMAIL ?? 'smoke@staging.local'
const PASSWORD = process.env.STAGING_SMOKE_PASSWORD ?? ''

async function login(page: Page) {
  await page.goto('/')
  await page.locator('input[type="email"]').fill(EMAIL)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The sidebar navigation landmark renders only inside the authenticated app
  // shell (the login screen has no nav). Works collapsed or expanded.
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 20_000 })
}

test('unauthenticated visit is walled at the login screen', async ({ page }) => {
  await page.goto('/properties')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('navigation')).toHaveCount(0)
})

test('login reaches the app shell', async ({ page }) => {
  await login(page)
})

test('properties page renders live rows from the database', async ({ page }) => {
  await login(page)
  await page.goto('/properties')
  // A real PostgREST read through RLS: this name exists only in the properties table.
  await expect(page.getByText('Gateway Port Chester')).toBeVisible({ timeout: 20_000 })
})

test('financials page renders its shell without erroring', async ({ page }) => {
  await login(page)
  await page.goto('/financials')
  // No GL data is loaded in staging, so assert the page frame renders rather than
  // any numbers: the shell must stay up, and nothing may crash to a blank screen.
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 20_000 })
  const body = await page.textContent('body')
  expect(body ?? '').not.toContain('Something went wrong')
})
