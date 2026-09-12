import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import type { Page, Response } from '@playwright/test'
import {
  shouldAnswerRecoveryOffer,
  installRecoveryOfferAutoDecline,
  installRecoveryOfferAutoDeclineOnContext,
  RECOVERY_PANEL_TESTID,
  RECOVERY_DECLINE_TESTID,
} from './recovery-offer.js'

/**
 * RESTORE-01 — unit tests for the harness-level recovery-offer auto-decline.
 * The watcher answers the rust server's "Restore N panes?" offer through the
 * on rust legs. See docs/plans/df1/RESTORE-01.md for the verdict + plan.
 */

interface FakeLocatorBehavior {
  waitError?: Error
  clickError?: Error
}

class FakeLocator {
  constructor(
    private readonly calls: string[],
    private readonly testid: string,
    private readonly behavior: FakeLocatorBehavior = {},
  ) {}

  async waitFor(opts: { state: string }): Promise<void> {
    this.calls.push(`waitFor:${this.testid}:${opts.state}`)
    if (this.behavior.waitError) throw this.behavior.waitError
  }

  async click(): Promise<void> {
    this.calls.push(`click:${this.testid}`)
    if (this.behavior.clickError) throw this.behavior.clickError
  }
}

class FakePage extends EventEmitter {
  readonly calls: string[] = []

  constructor(private readonly locators: Record<string, FakeLocatorBehavior> = {}) {
    super()
  }

  getByTestId(testid: string): FakeLocator {
    return new FakeLocator(this.calls, testid, this.locators[testid] ?? {})
  }
}

interface FakeResponseInit {
  url?: string
  status?: number
  body?: unknown
  jsonError?: Error
}

function makeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200
  return {
    url: () => init.url ?? 'http://127.0.0.1:1/api/recovery/inventory?clientInstanceId=x',
    ok: () => status >= 200 && status < 300,
    json: async () => {
      if (init.jsonError) throw init.jsonError
      return init.body ?? { recoverable: true }
    },
  } as unknown as Response
}

/** Let the watcher's fire-and-forget promise chain run to quiescence. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('shouldAnswerRecoveryOffer', () => {
  it('answers a recoverable inventory response', () => {
    expect(
      shouldAnswerRecoveryOffer({
        url: 'http://h/api/recovery/inventory?clientInstanceId=me',
        ok: true,
        body: { recoverable: true },
      }),
    ).toBe(true)
  })

  it('ignores unrelated urls', () => {
    expect(
      shouldAnswerRecoveryOffer({
        url: 'http://h/api/settings',
        ok: true,
        body: { recoverable: true },
      }),
    ).toBe(false)
  })

  it('ignores non-ok responses (legacy 404s the route)', () => {
    expect(
      shouldAnswerRecoveryOffer({
        url: 'http://h/api/recovery/inventory',
        ok: false,
        body: { recoverable: true },
      }),
    ).toBe(false)
  })

  it('ignores a non-recoverable inventory', () => {
    expect(
      shouldAnswerRecoveryOffer({
        url: 'http://h/api/recovery/inventory',
        ok: true,
        body: { recoverable: false },
      }),
    ).toBe(false)
  })

  it('ignores bodies without a recoverable flag and non-object bodies', () => {
    for (const body of [{}, null, undefined, 'garbage']) {
      expect(
        shouldAnswerRecoveryOffer({
          url: 'http://h/api/recovery/inventory',
          ok: true,
          body,
        }),
      ).toBe(false)
    }
  })
})

describe('installRecoveryOfferAutoDecline', () => {
  it('registers a response listener on install', () => {
    const page = new FakePage()
    installRecoveryOfferAutoDecline(page as unknown as Page)
    expect(page.listenerCount('response')).toBe(1)
  })

  it('declines a real recovery offer through the UI: panel visible -> decline click -> detached', async () => {
    const page = new FakePage()
    installRecoveryOfferAutoDecline(page as unknown as Page)
    page.emit('response', makeResponse())
    await flush()
    expect(page.calls).toEqual([
      `waitFor:${RECOVERY_PANEL_TESTID}:visible`,
      `click:${RECOVERY_DECLINE_TESTID}`,
      `waitFor:${RECOVERY_PANEL_TESTID}:detached`,
    ])
  })

  it('never declines for a legacy 404 (no /api/recovery/inventory route on Node)', async () => {
    const page = new FakePage()
    installRecoveryOfferAutoDecline(page as unknown as Page)
    page.emit('response', makeResponse({ status: 404 }))
    await flush()
    expect(page.calls).toEqual([])
  })

  it('never declines when the inventory is not recoverable', async () => {
    const page = new FakePage()
    installRecoveryOfferAutoDecline(page as unknown as Page)
    page.emit('response', makeResponse({ body: { recoverable: false } }))
    await flush()
    expect(page.calls).toEqual([])
  })

  it('ignores unrelated responses entirely', async () => {
    const page = new FakePage()
    installRecoveryOfferAutoDecline(page as unknown as Page)
    page.emit('response', makeResponse({ url: 'http://h/api/settings', body: null }))
    await flush()
    expect(page.calls).toEqual([])
  })

  it('swallows a body-read failure without declining and without throwing', async () => {
    const page = new FakePage()
    installRecoveryOfferAutoDecline(page as unknown as Page)
    page.emit('response', makeResponse({ jsonError: new Error('body evicted') }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await flush()
    expect(page.calls).toEqual([])
    expect(log.mock.calls.some((c) => String(c[0]).includes('[recovery-auto-decline]'))).toBe(true)
    log.mockRestore()
  })

  it('survives a failing decline: the error is swallowed and a LATER offer is still answered', async () => {
    // First page: decline click explodes (page closing mid-decline).
    const chainPage = new FakePage({ [RECOVERY_DECLINE_TESTID]: { clickError: new Error('Target closed') } })
    installRecoveryOfferAutoDecline(chainPage as unknown as Page)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    chainPage.emit('response', makeResponse())
    await flush()
    expect(chainPage.calls.filter((c) => c.startsWith('click')).length).toBe(1)

    // Second offer on the SAME page must still be answered (chain resilience).
    chainPage.emit('response', makeResponse())
    await flush()
    expect(chainPage.calls.filter((c) => c.startsWith('click')).length).toBe(2)
    expect(log.mock.calls.some((c) => String(c[0]).includes('non-fatal'))).toBe(true)
    log.mockRestore()
  })
})

describe('installRecoveryOfferAutoDeclineOnContext', () => {
  it('attaches to existing pages and to pages created later', async () => {
    const existing = new FakePage()
    const context = new EventEmitter() as EventEmitter & { pages(): Page[] }
    context.pages = () => [existing as unknown as Page]
    installRecoveryOfferAutoDeclineOnContext(context as never)
    expect(existing.listenerCount('response')).toBe(1)

    const later = new FakePage()
    context.emit('page', later as unknown as Page)
    later.emit('response', makeResponse())
    await flush()
    expect(later.calls).toContain(`click:${RECOVERY_DECLINE_TESTID}`)
  })
})
