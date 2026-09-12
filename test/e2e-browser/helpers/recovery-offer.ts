import type { BrowserContext, Page, Response } from '@playwright/test'

/**
 * RESTORE-01 — harness-level auto-decline for the rust server's
 * recover-my-panes offer (GATE-01 headline finding F1).
 *
 * Verdict (full audit: docs/plans/df1-evidence/RESTORE-01.md): the offer is
 * CORRECT, designed product behavior — `RecoveryOfferPanel` fetches
 * `GET /api/recovery/inventory` on every boot whose localStorage carried no
 * persisted layout (D1, docs/plans/2026-07-26-recover-my-panes.md), and the
 * rust server joins the vanished clients' tabs-snapshot generations +
 * pane-ledger bindings into a recoverable inventory (A15/A16 filters:
 * `crates/freshell-server/src/recovery_inventory.rs`). A fresh Playwright
 * context against the worker-shared rust server is indistinguishable from a
 * real new browser connecting after the last browser vanished — the exact
 * scenario the feature and its e2e pin (recover-my-panes-rust.spec.ts)
 * offered there (feature absent, a documented KNOWN DIVERGENCE).
 *
 * So the harness ANSWERS the offer exactly like an uninterested user: watch
 * the wire for the inventory response, let the panel render, then click the
 * real "Not now" button. That runs the genuine product decline path
 * (recordDismissal by contentId + clearPendingOffer, both localStorage-local
 * in src/lib/recovery/dismissal.ts) — no test-only product flag, no assertion
 * weakened, and the dismissal dies with the throwaway browser context, so a
 * shared server is never contaminated across tests.
 *
 * Best-effort by contract: the watcher must NEVER fail its test (a page
 * closing mid-decline, an evicted response body, a click racing a detach are
 * all benign and only logged).
 */

export type RecoveryOfferHandling = 'auto-decline' | 'manual'

export const RECOVERY_PANEL_TESTID = 'recovery-offer-panel'
export const RECOVERY_DECLINE_TESTID = 'recovery-decline'
const INVENTORY_URL_MARKER = '/api/recovery/inventory'
// f3wp deflake: under load the panel can render >10 s after the inventory
// response; 30 s bounds the observed worst case (same bound the in-spec
// idioms used).
const PANEL_VISIBLE_TIMEOUT_MS = 30_000
const PANEL_DETACH_TIMEOUT_MS = 10_000

/** Pure decision: does this HTTP exchange carry a real recovery offer? */
export function shouldAnswerRecoveryOffer(probe: {
  url: string
  ok: boolean
  body: unknown
}): boolean {
  if (!probe.url.includes(INVENTORY_URL_MARKER)) return false
  if (!probe.ok) return false // legacy 404s the route — nothing to answer
  const body = probe.body as { recoverable?: unknown } | null
  return body?.recoverable === true
}

const declineChains = new WeakMap<Page, Promise<void>>()

async function answerOffer(page: Page): Promise<void> {
  const panel = page.getByTestId(RECOVERY_PANEL_TESTID)
  await panel.waitFor({ state: 'visible', timeout: PANEL_VISIBLE_TIMEOUT_MS })
  console.log('[recovery-auto-decline] recovery offer made; harness clicking "Not now"')
  await page.getByTestId(RECOVERY_DECLINE_TESTID).click()
  await panel.waitFor({ state: 'detached', timeout: PANEL_DETACH_TIMEOUT_MS })
}

function onResponse(page: Page, response: Response): void {
  if (!response.url().includes(INVENTORY_URL_MARKER)) return
  const previous = declineChains.get(page) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      const body = response.ok()
        ? await response.json().catch((err) => {
            // Unreadable body hides whether an offer was even made — surface a
            // triage line (non-fatal) so silence is never mistaken for "no offer".
            console.log(`[recovery-auto-decline] non-fatal decline failure: inventory body unreadable: ${String(err)}`)
            return null
          })
        : null
      if (!shouldAnswerRecoveryOffer({ url: response.url(), ok: response.ok(), body })) return
      await answerOffer(page)
    })
    .catch((err) => {
      console.log(`[recovery-auto-decline] non-fatal decline failure: ${String(err)}`)
    })
  declineChains.set(page, next)
}

/**
 * Watch a single page: when the rust server offers pane recovery on a fresh
 * boot, answer with the real "Not now" button. Safe to install on every e2e
 * page: it is a no-op unless a recoverable offer is actually made.
 */
export function installRecoveryOfferAutoDecline(page: Page): void {
  page.on('response', (response) => onResponse(page, response))
}

/** Watch every page of a context — existing pages and pages created later. */
export function installRecoveryOfferAutoDeclineOnContext(context: BrowserContext): void {
  context.on('page', (page) => installRecoveryOfferAutoDecline(page))
  for (const page of context.pages()) installRecoveryOfferAutoDecline(page)
}
