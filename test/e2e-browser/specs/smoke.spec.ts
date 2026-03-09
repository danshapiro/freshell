import { test, expect } from '@playwright/test'

test('playwright is configured correctly', async ({ page }) => {
  // This test verifies Playwright can launch a browser
  // It will be removed after the full suite is built
  expect(page).toBeTruthy()
})
