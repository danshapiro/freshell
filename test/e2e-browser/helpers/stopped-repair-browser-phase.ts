import { expect, test, type Locator, type Page } from '@playwright/test'
import { resolveWsReadyTimeoutMs, type TestHarness } from './test-harness.js'

async function phase<T>(name: string, operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return test.step(`stopped repair: ${name}`, async () => {
    try {
      return await operation()
    } catch (error) {
      throw new Error(`stopped repair: ${name} failed`, { cause: error })
    }
  }, { timeout: timeoutMs })
}

/** The existing first Resume browser leg, shared with its controlled page tests. */
export async function resumeStoppedRepairBrowserView(
  page: Page,
  harness: TestHarness,
  tabId: string,
  paneId: string,
  timeoutMs = 60_000,
): Promise<Locator> {
  // Native operation deadlines cancel their waits; steps retain the failed
  // operation name and original error. Keep the reload's full-load semantics.
  await phase('reload', () => page.reload({ timeout: timeoutMs }), timeoutMs + 1_000)
  await phase('harness', () => harness.waitForHarness(timeoutMs), timeoutMs + 1_000)
  await phase('connection', () => harness.waitForConnection(), resolveWsReadyTimeoutMs(undefined) + 2_000)
  // The original synchronous dispatch runs once. waitForFunction supplies a
  // native deadline for acquiring/executing in the new document's context.
  await phase('select restored tab', () => page.waitForFunction(id => {
    window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'tabs/setActiveTab', payload: id })
    return true
  }, tabId, { timeout: timeoutMs }), timeoutMs + 1_000)
  const card = page.locator(`[data-pane-id="${paneId}"]`)
    .getByTestId('managed-runtime-recovery-card').first()
  const resume = card.getByRole('button', { name: 'Resume restored session', exact: true })
  await phase('Resume visibility', () => expect(resume).toBeVisible({ timeout: 60_000 }), 61_000)
  await phase('Resume click', () => resume.click({ timeout: timeoutMs }), timeoutMs + 1_000)
  return card
}
