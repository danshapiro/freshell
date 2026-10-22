import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
      super(message)
      this.status = status
      this.data = data
    }
  },
}))

vi.mock('@/lib/api', () => ({ api: { post: apiMocks.post }, ApiError: apiMocks.ApiError }))

import {
  LEGACY_NAME_CAPTURE_DONE_KEY,
  SESSION_NAME_MIGRATION_KEY_PREFIX,
  isCaptureDone,
  listCapturedMigrationEnvelopes,
  runOneTimeLegacyCapture,
} from '@/lib/legacy-name-capture-policy'
import { submitPendingLegacyNameImports } from '@/lib/session-name-migration'

// Name reliability (Task 2): the browser captures legacy name evidence at
// most once per device, only from genuine pre-migration keys, and deletes
// what it no longer needs. These cases drive the real capture against the
// jsdom localStorage and the real submit path (with the HTTP call mocked).

function preNamesLayout(opts: {
  tabTitle?: string
  paneTitle?: string
  mode?: string
  sessionId?: string
} = {}): string {
  const mode = opts.mode ?? 'claude'
  return JSON.stringify({
    version: 4,
    persistedAt: 1234,
    tabs: {
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', title: opts.tabTitle ?? 'Billing bug', titleSetByUser: true }],
    },
    panes: {
      version: 7,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode,
            createRequestId: 'req-1',
            terminalId: 'term-1',
            sessionRef: { provider: mode, sessionId: opts.sessionId ?? 'sess-1' },
          },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': opts.paneTitle ?? 'Invoice rounding' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    },
  })
}

/** Every key under the migration prefix: envelopes and ack markers. */
function migrationKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key && key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.`)) keys.push(key)
  }
  return keys.sort()
}

function seedEnvelope(importId: string, storageKey: string, raw: string): void {
  localStorage.setItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.${importId}`, JSON.stringify({
    version: 1,
    importId,
    storageKey,
    raw,
    capturedAt: 1,
  }))
}

function acknowledgeAllCandidates(): void {
  apiMocks.post.mockImplementation(async (_url: string, body: unknown) => ({
    acknowledged: ((body as { candidates?: Array<{ id: string }> }).candidates ?? []).map((c) => c.id),
    names: [],
  }))
}

/** A Storage stub whose setItem can be made to throw (a full quota). */
function failingStorage(): Storage & { failSetItem: (fail: boolean) => void } {
  const map = new Map<string, string>()
  let fail = false
  const storage = {
    get length() { return map.size },
    key(index: number) { return Array.from(map.keys())[index] ?? null },
    getItem(key: string) { return map.get(key) ?? null },
    setItem(key: string, value: string) {
      if (fail) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      map.set(key, value)
    },
    removeItem(key: string) { map.delete(key) },
    clear() { map.clear() },
    failSetItem(next: boolean) { fail = next },
  }
  return storage as Storage & { failSetItem: (fail: boolean) => void }
}

beforeEach(() => {
  localStorage.clear()
  apiMocks.post.mockReset()
})

describe('one-time legacy name capture', () => {
  it('never captures a live per-window layout key, its .bak or its fresh-agent backup', async () => {
    localStorage.setItem('freshell.layout.v3.layout-window-a', preNamesLayout({ tabTitle: 'Tab 23' }))
    localStorage.setItem('freshell.layout.v3.layout-window-a.bak', preNamesLayout({ tabTitle: 'Backup label' }))
    localStorage.setItem(
      'freshell.layout.v3.layout-window-a.backup-before-fresh-agent-centralization',
      preNamesLayout({ tabTitle: 'Centralization label' }),
    )

    runOneTimeLegacyCapture(localStorage)
    acknowledgeAllCandidates()
    await submitPendingLegacyNameImports()

    expect(migrationKeys()).toEqual([])
    expect(apiMocks.post).not.toHaveBeenCalled()
    // Nothing genuine to capture: the device is done at once.
    expect(isCaptureDone(localStorage)).toBe(true)
    // The live layout keys themselves are never touched.
    expect(localStorage.getItem('freshell.layout.v3.layout-window-a')).toBe(preNamesLayout({ tabTitle: 'Tab 23' }))
  })

  it('never captures the per-window pre-migration sidecar', async () => {
    // The current client rewrites this sidecar during its own storage
    // migration, so its scoped tab title ("OpenCode agent") is not legacy
    // evidence.
    localStorage.setItem(
      'freshell.layout.pre-migration-raw.v1.layout-window-a',
      preNamesLayout({ tabTitle: 'OpenCode agent', paneTitle: 'OpenCode agent', mode: 'opencode' }),
    )

    runOneTimeLegacyCapture(localStorage)
    acknowledgeAllCandidates()
    await submitPendingLegacyNameImports()

    expect(migrationKeys()).toEqual([])
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(isCaptureDone(localStorage)).toBe(true)
  })

  it('captures a genuine bare legacy layout once, then marks the device done after acknowledgment', async () => {
    const bare = preNamesLayout()
    localStorage.setItem('freshell.layout.v3', bare)

    runOneTimeLegacyCapture(localStorage)
    const envelopes = listCapturedMigrationEnvelopes(localStorage)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]).toMatchObject({ storageKey: 'freshell.layout.v3', raw: bare })
    expect(isCaptureDone(localStorage)).toBe(false)

    acknowledgeAllCandidates()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    const posted = apiMocks.post.mock.calls[0][1] as { candidates: Array<{ name: string }> }
    expect(posted.candidates.map((candidate) => candidate.name).sort()).toEqual(['Billing bug', 'Invoice rounding'])
    // The acknowledged envelope and every ack marker are deleted; the done
    // marker remains.
    expect(migrationKeys()).toEqual([])
    expect(isCaptureDone(localStorage)).toBe(true)
    expect(localStorage.getItem(LEGACY_NAME_CAPTURE_DONE_KEY)).not.toBeNull()
    // The bare key is never deleted (an old window may still read it).
    expect(localStorage.getItem('freshell.layout.v3')).toBe(bare)

    // A later boot with changed bare bytes captures and sends nothing.
    localStorage.setItem('freshell.layout.v3', preNamesLayout({ tabTitle: 'Another label' }))
    runOneTimeLegacyCapture(localStorage)
    await submitPendingLegacyNameImports()
    expect(migrationKeys()).toEqual([])
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })

  it('ignores a bare legacy key whose raw already carries unified-names fields', async () => {
    const withTabNameSource = JSON.parse(preNamesLayout())
    withTabNameSource.tabs.tabs[0].nameSource = { kind: 'session', paneId: 'pane-1' }
    const withPaneNameRef = JSON.parse(preNamesLayout())
    withPaneNameRef.panes.layouts['tab-1'].content.nameRef = {
      kind: 'session', provider: 'claude', sessionId: 'sess-1',
    }
    const withPaneNamingHandle = JSON.parse(preNamesLayout())
    withPaneNamingHandle.panes.layouts['tab-1'].content.namingHandle = 'nh-abc'

    for (const [field, raw] of [
      ['nameSource', withTabNameSource],
      ['nameRef', withPaneNameRef],
      ['namingHandle', withPaneNamingHandle],
    ] as const) {
      localStorage.clear()
      apiMocks.post.mockReset()
      acknowledgeAllCandidates()
      localStorage.setItem('freshell.layout.v3', JSON.stringify(raw))

      runOneTimeLegacyCapture(localStorage)
      await submitPendingLegacyNameImports()

      expect(migrationKeys(), field).toEqual([])
      expect(apiMocks.post, field).not.toHaveBeenCalled()
      expect(isCaptureDone(localStorage), field).toBe(true)
    }
  })

  it('a device with prior envelopes or ack markers becomes done without resubmitting live-layout envelopes', async () => {
    // What the previous client left behind: an acknowledged envelope with
    // its marker, and an unacknowledged copy of another window's live
    // layout. The bare key was captured back then too.
    seedEnvelope('acked-a', 'freshell.layout.v3.layout-window-a', preNamesLayout({ tabTitle: 'Tab 4' }))
    localStorage.setItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.ack.acked-a`, '1')
    seedEnvelope('live-b', 'freshell.layout.v3.layout-window-b', preNamesLayout({ tabTitle: 'Tab 23' }))
    localStorage.setItem('freshell.layout.v3', preNamesLayout())

    runOneTimeLegacyCapture(localStorage)
    acknowledgeAllCandidates()
    await submitPendingLegacyNameImports()

    expect(migrationKeys()).toEqual([])
    expect(isCaptureDone(localStorage)).toBe(true)
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('a prior genuine envelope that was never acknowledged is still submitted once', async () => {
    seedEnvelope('bare-1', 'freshell.layout.v3', preNamesLayout())
    seedEnvelope('live-b', 'freshell.layout.v3.layout-window-b', preNamesLayout({ tabTitle: 'Tab 23' }))

    runOneTimeLegacyCapture(localStorage)
    // The live-layout copy is purged; the genuine one waits for submission.
    expect(listCapturedMigrationEnvelopes(localStorage).map((envelope) => envelope.importId)).toEqual(['bare-1'])
    expect(isCaptureDone(localStorage)).toBe(false)

    acknowledgeAllCandidates()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    expect((apiMocks.post.mock.calls[0][1] as { importId: string }).importId).toBe('bare-1')
    expect(migrationKeys()).toEqual([])
    expect(isCaptureDone(localStorage)).toBe(true)
  })

  it('a done device deletes any envelope an older window wrote later and never submits it', async () => {
    runOneTimeLegacyCapture(localStorage)
    expect(isCaptureDone(localStorage)).toBe(true)
    // An old client window still open after the deploy keeps copying its
    // live layout into envelopes.
    seedEnvelope('old-window', 'freshell.layout.v3.layout-window-old', preNamesLayout({ tabTitle: 'Tab 9' }))
    acknowledgeAllCandidates()

    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()

    runOneTimeLegacyCapture(localStorage)
    expect(migrationKeys()).toEqual([])
  })

  it('an acknowledged envelope is deleted even when its acknowledgment marker cannot be written', async () => {
    localStorage.setItem('freshell.layout.v3', preNamesLayout())
    runOneTimeLegacyCapture(localStorage)
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(1)
    // The storage is full: marker writes fail from here on.
    const realSetItem = Storage.prototype.setItem
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.ack.`)) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      realSetItem.call(this, key, value)
    })
    try {
      acknowledgeAllCandidates()
      await submitPendingLegacyNameImports()
      await submitPendingLegacyNameImports()
      // Sent once; the envelope is gone, so nothing is ever resent.
      expect(apiMocks.post).toHaveBeenCalledTimes(1)
      expect(listCapturedMigrationEnvelopes(localStorage)).toEqual([])
      expect(isCaptureDone(localStorage)).toBe(true)
    } finally {
      setItem.mockRestore()
    }
  })

  it('a capture write failure is logged as a structured error, leaves the source untouched, and the next boot retries', () => {
    ;(globalThis as { __ALLOW_CONSOLE_ERROR__?: boolean }).__ALLOW_CONSOLE_ERROR__ = true
    const storage = failingStorage()
    const bare = preNamesLayout()
    storage.setItem('freshell.layout.v3', bare)
    storage.failSetItem(true)

    expect(() => runOneTimeLegacyCapture(storage)).not.toThrow()
    expect(listCapturedMigrationEnvelopes(storage)).toEqual([])
    expect(storage.getItem('freshell.layout.v3')).toBe(bare)
    expect(isCaptureDone(storage)).toBe(false)
    const logged = vi.mocked(console.error).mock.calls.find((args) => args.includes('legacy_name_capture_failed'))
    expect(logged).toBeTruthy()
    expect(logged?.find((arg) => typeof arg === 'object' && arg !== null)).toEqual({
      storageKey: 'freshell.layout.v3',
      reason: 'QuotaExceededError',
    })

    storage.failSetItem(false)
    runOneTimeLegacyCapture(storage)
    expect(listCapturedMigrationEnvelopes(storage).map((envelope) => envelope.storageKey)).toEqual(['freshell.layout.v3'])
  })
})
