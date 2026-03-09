import { test, expect } from '../helpers/fixtures.js'

test.describe('Authentication', () => {
  test('shows auth modal when no token provided', async ({ page, serverInfo }) => {
    await page.goto(serverInfo.baseUrl)
    // Should show the auth modal
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    // Should have a token input
    const input = page.getByPlaceholderText(/token/i)
    await expect(input).toBeVisible()
  })

  test('shows auth modal with wrong token', async ({ page, serverInfo }) => {
    await page.goto(`${serverInfo.baseUrl}/?token=wrong-token-value`)
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10_000 })
  })

  test('authenticates with correct token via URL', async ({ freshellPage, harness }) => {
    // freshellPage already has the correct token
    const status = await harness.getConnectionStatus()
    expect(status).toBe('connected')
  })

  test('authenticates via auth modal input', async ({ page, serverInfo, harness }) => {
    await page.goto(serverInfo.baseUrl)
    // Wait for the auth modal
    const input = page.getByPlaceholderText(/token/i)
    await expect(input).toBeVisible({ timeout: 10_000 })

    // Type the correct token
    await input.fill(serverInfo.token)
    // Submit
    const submitButton = page.getByRole('button', { name: /connect|submit|go/i })
    await submitButton.click()

    // Wait for connection
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Verify connected
    const status = await harness.getConnectionStatus()
    expect(status).toBe('connected')
  })

  test('API rejects requests without auth header', async ({ serverInfo }) => {
    const res = await fetch(`${serverInfo.baseUrl}/api/settings`)
    expect(res.status).toBe(401)
  })

  test('health endpoint works without auth', async ({ serverInfo }) => {
    const res = await fetch(`${serverInfo.baseUrl}/api/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})
