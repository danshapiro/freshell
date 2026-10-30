// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ cases: new Map<string, Function>(), createPage: vi.fn() }))
vi.mock('../../../e2e-browser/helpers/fixtures.js', () => ({
  test: Object.assign((title: string, callback: Function) => fixtures.cases.set(title, callback), {
    describe: Object.assign((_title: string, callback: () => void) => callback(), { serial: (_title: string, callback: () => void) => callback() }),
    skip: vi.fn(), setTimeout: vi.fn(),
  }),
  createFreshE2ePage: fixtures.createPage,
}))
vi.mock('../../../e2e-browser/helpers/recovery-offer.js', () => ({ installRecoveryOfferAutoDeclineOnContext: vi.fn() }))

import * as external from '../../../../scripts/testing/runtime-external-browser.js'
import { ExternalServer } from '../../../e2e-browser/helpers/external-target.js'

afterEach(() => { vi.restoreAllMocks(); fixtures.createPage.mockReset() })

describe('retained browser fixture failure cleanup', () => {
  it.each([false, true])('finishes the owned runtime after navigation fails (browser close fails: %s)', async closeFails => {
    await import('../../../e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.js')
    const callback = fixtures.cases.get('synthetic config-blocked exact retry')
    if (!callback) throw new Error('original retained browser case was not registered')
    const descriptor = { baseUrl: 'https://owned.invalid', wsUrl: 'wss://owned.invalid/ws', token: 'fixture-token',
      runId: '11111111-1111-4111-8111-111111111111', candidateSha: 'a'.repeat(40) }
    vi.spyOn(external, 'resolveManagedExternalDescriptor').mockReturnValue(descriptor)
    vi.spyOn(external.ExternalManagedRuntimeRig.prototype, 'start').mockResolvedValue(descriptor)
    vi.spyOn(external.ExternalManagedRuntimeRig.prototype, 'startRetainedFixture').mockResolvedValue({ kind: 'preparing', sequence: 0 })
    vi.spyOn(external.ExternalManagedRuntimeRig.prototype, 'retainedFixtureStage').mockResolvedValue({ kind: 'observe', sequence: 1,
      phase: 'store_blocked', context: { info: descriptor } } as any)
    vi.spyOn(ExternalServer.prototype, 'start').mockResolvedValue(descriptor as any)
    const finish = vi.spyOn(external.ExternalManagedRuntimeRig.prototype, 'finishRetainedFixture')
      .mockResolvedValue({ ok: true, errors: [] })
    const primary = new Error('owned browser navigation failed')
    const closing = new Error('owned browser context close failed')
    const close = closeFails ? vi.fn().mockRejectedValue(closing) : vi.fn().mockResolvedValue(undefined)
    fixtures.createPage.mockResolvedValue({ page: { goto: vi.fn().mockRejectedValue(primary) }, context: { close } })
    const failure = await callback({ browser: {} }).catch((error: unknown) => error)
    expect(close).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    if (closeFails) {
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.cause).toBe(primary)
      expect(failure.message).toContain(closing.message)
    } else expect(failure).toBe(primary)
  })
})
