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
  collectLegacyPendingHandleAssignments,
  importLegacyNames,
  legacyPendingNamingHandle,
  prepareLegacyNameImports,
  stripScopedPaneTitleMetadata,
  stripSessionOwnedTabFreezeFlags,
  submitPendingLegacyNameImports,
} from '@/lib/session-name-migration'
import {
  isCaptureDone,
  isGenuinePreMigrationSource,
  listCapturedMigrationEnvelopes,
  runOneTimeLegacyCapture,
  SESSION_NAME_MIGRATION_KEY_PREFIX,
} from '@/lib/legacy-name-capture-policy'
import {
  parsePersistedLayoutRaw,
} from '@/store/persistedState'

// ── fixtures ─────────────────────────────────────────────────────────────────

function scopedTerminalPane(sessionId: string): unknown {
  return {
    type: 'leaf',
    id: 'pane-1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId },
    },
  }
}

function unboundScopedPane(): unknown {
  return {
    type: 'leaf',
    id: 'pane-unbound',
    content: {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'req-unbound',
      terminalId: 'term-unbound',
    },
  }
}

function shellPane(): unknown {
  return {
    type: 'leaf',
    id: 'pane-shell',
    content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shell' },
  }
}

function layoutEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 4,
    persistedAt: 1234,
    tabs: {
      activeTabId: 'tab-1',
      tabs: [
        { id: 'tab-1', title: 'Tab Label', titleSetByUser: true },
        { id: 'tab-shell', title: 'Shell Tab' },
      ],
    },
    panes: {
      version: 7,
      layouts: {
        'tab-1': scopedTerminalPane('sess-1'),
        'tab-shell': shellPane(),
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {
        'tab-1': { 'pane-1': 'Pane Alias' },
        'tab-shell': { 'pane-shell': 'Shell Title' },
      },
      paneTitleSetByUser: {
        'tab-1': { 'pane-1': true },
        'tab-shell': { 'pane-shell': true },
      },
    },
    ...overrides,
  })
}

function envelopeKeysIn(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.`)) keys.push(key)
  }
  return keys
}

beforeEach(() => {
  localStorage.clear()
  apiMocks.post.mockReset()
})

/** The captured envelopes as prepare/submit evidence. */
function capturedEvidence(): Array<{ storageKey: string; raw: string }> {
  return listCapturedMigrationEnvelopes(localStorage).map((e) => ({ storageKey: e.storageKey, raw: e.raw }))
}

// ── capture ─────────────────────────────────────────────────────────────────

describe('legacy-name capture', () => {
  it('captures only the genuine pre-migration sources, each under its own per-importId envelope key', () => {
    // The five genuine pre-migration sources …
    localStorage.setItem('freshell.layout.v3', layoutEnvelope())
    localStorage.setItem('freshell.layout.v3.bak', layoutEnvelope({ persistedAt: 2 }))
    localStorage.setItem('freshell.layout.pre-migration-raw.v1', layoutEnvelope({ persistedAt: 3 }))
    localStorage.setItem('freshell.tabs.v2', layoutEnvelope({ persistedAt: 4 }))
    localStorage.setItem('freshell.panes.v2', layoutEnvelope({ persistedAt: 5 }))
    // … and what the current client writes itself, never captured.
    localStorage.setItem('freshell.layout.v3.window-a', layoutEnvelope())
    localStorage.setItem('freshell.layout.v3.window-a.bak', layoutEnvelope())
    localStorage.setItem('freshell.layout.pre-migration-raw.v1.window-a', layoutEnvelope())
    localStorage.setItem('freshell.layout.v3.window-a.fresh-agent-centralization-commit', '{}')
    localStorage.setItem('freshell.browser-preferences.v1', '{}')

    runOneTimeLegacyCapture(localStorage)

    const envelopes = listCapturedMigrationEnvelopes(localStorage)
    expect(envelopes).toHaveLength(5)
    for (const envelope of envelopes) {
      expect(localStorage.getItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.${envelope.importId}`))
        .toBe(JSON.stringify(envelope))
      // The raw bytes are preserved verbatim.
      expect(envelope.raw).toBe(localStorage.getItem(envelope.storageKey))
    }
    expect(envelopes.map((envelope) => envelope.storageKey).sort()).toEqual([
      'freshell.layout.pre-migration-raw.v1',
      'freshell.layout.v3',
      'freshell.layout.v3.bak',
      'freshell.panes.v2',
      'freshell.tabs.v2',
    ])
  })

  it('captures at most once — a second window boot never duplicates, rewrites or re-captures changed bytes', () => {
    localStorage.setItem('freshell.layout.v3', layoutEnvelope())
    runOneTimeLegacyCapture(localStorage)
    const first = listCapturedMigrationEnvelopes(localStorage)
    expect(first).toHaveLength(1)

    // Same bytes (a second window boots on the same device): no change.
    runOneTimeLegacyCapture(localStorage)
    expect(listCapturedMigrationEnvelopes(localStorage)).toEqual(first)

    // Changed bytes under the same key: still no second envelope, and the
    // first envelope keeps its original bytes.
    localStorage.setItem('freshell.layout.v3', layoutEnvelope({ persistedAt: 9999 }))
    runOneTimeLegacyCapture(localStorage)
    expect(listCapturedMigrationEnvelopes(localStorage)).toEqual(first)
    expect(first[0].raw).toBe(layoutEnvelope())
  })

  it('a capture write failure never throws, logs legacy_name_capture_failed, keeps the source, and the next ready submit marks the device done without sending', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    localStorage.setItem('freshell.layout.v3', layoutEnvelope())
    const realSetItem = Storage.prototype.setItem
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.`)) throw new Error('quota')
      realSetItem.call(this, key, value)
    })
    try {
      expect(() => runOneTimeLegacyCapture(localStorage)).not.toThrow()
    } finally {
      setItem.mockRestore()
    }
    // The source is untouched, nothing was captured, and the device is not
    // done yet.
    expect(localStorage.getItem('freshell.layout.v3')).toBe(layoutEnvelope())
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(0)
    expect(isCaptureDone(localStorage)).toBe(false)
    const logged = vi.mocked(console.error).mock.calls.find((args) => args.includes('legacy_name_capture_failed'))
    expect(logged?.find((arg) => typeof arg === 'object' && arg !== null))
      .toMatchObject({ storageKey: 'freshell.layout.v3', reason: expect.any(String) })

    // The connection-ready submit finds nothing pending: the evidence is
    // dropped and the device is done, so no later boot captures it.
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(isCaptureDone(localStorage)).toBe(true)
    runOneTimeLegacyCapture(localStorage)
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(0)
  })

  it('an envelope an old client window adds later is never submitted, and is deleted', async () => {
    localStorage.setItem('freshell.layout.v3', layoutEnvelope())
    runOneTimeLegacyCapture(localStorage)
    // An old client still open after the deploy copies its live per-window
    // layout into a migration envelope.
    localStorage.setItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.old-window`, JSON.stringify({
      version: 1,
      importId: 'old-window',
      storageKey: 'freshell.layout.v3.window-old',
      raw: layoutEnvelope({ persistedAt: 42 }),
      capturedAt: 1,
    }))
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })

    await submitPendingLegacyNameImports()

    // Only the genuine bare-key envelope was submitted.
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    const body = apiMocks.post.mock.calls[0][1] as { evidence: Array<{ storageKey: string }> }
    expect(body.evidence.map((e) => e.storageKey)).toEqual(['freshell.layout.v3'])
    expect(localStorage.getItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.old-window`)).toBeNull()
  })
})

// ── prepare ─────────────────────────────────────────────────────────────────

describe('legacy-name candidate preparation', () => {
  it('extracts flagged pane and source-tab candidates and bare automatic labels with their claims', () => {
    localStorage.setItem('freshell.layout.v3', layoutEnvelope())
    runOneTimeLegacyCapture(localStorage)
    const imports = prepareLegacyNameImports(capturedEvidence())
    expect(imports).toHaveLength(1)
    const candidates = imports[0].candidates
    // The flagged pane alias claims legacy-flag protection.
    const pane = candidates.find((c) => c.scope === 'pane')
    expect(pane).toMatchObject({
      name: 'Pane Alias',
      source: 'legacy_protected',
      protectionEvidence: 'legacy_flag',
      target: { kind: 'session', provider: 'claude', sessionId: 'sess-1' },
    })
    // The user-flagged tab label claims legacy protection for the
    // naming-source session (the first leaf is scoped here).
    const tab = candidates.find((c) => c.scope === 'source_tab')
    expect(tab).toMatchObject({
      name: 'Tab Label',
      source: 'legacy_protected',
      protectionEvidence: 'legacy_flag',
      target: { kind: 'session', provider: 'claude', sessionId: 'sess-1' },
    })
    // The shell pane/tab never produced a candidate.
    expect(candidates.find((c) => c.name === 'Shell Title')).toBeUndefined()
    expect(candidates.find((c) => c.name === 'Shell Tab')).toBeUndefined()
    // No candidate ever carries an explicitRenameAt (no trustworthy time in
    // legacy data — and never the envelope's updatedAt).
    expect(candidates.every((c) => c.explicitRenameAt === undefined)).toBe(true)
  })

  it('maps one source-tab label only to its naming-source session — a shell-first tab keeps its label recovery-only', () => {
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 't', tabs: [{ id: 't', title: 'Mixed Tab Label', titleSetByUser: true }] },
      panes: {
        version: 7,
        layouts: {
          t: {
            type: 'split',
            children: [shellPane(), scopedTerminalPane('sess-late')],
          },
        },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
    })
    const imports = prepareLegacyNameImports([{ storageKey: 'freshell.layout.v3', raw }])
    expect(imports).toHaveLength(0)
  })

  it('extracts no candidate from default or derived labels', () => {
    const cwd = '/home/dan/code/freshell'
    const scoped = (paneId: string, mode: string, sessionId: string): unknown => ({
      type: 'leaf',
      id: paneId,
      content: {
        kind: 'terminal',
        mode,
        createRequestId: `req-${paneId}`,
        initialCwd: cwd,
        sessionRef: { provider: mode, sessionId },
      },
    })
    const labelled: Array<[string, string, string | undefined]> = [
      // [tab title, mode, pane title]
      ['Tab 7', 'claude', 'Tab 7'],
      ['freshell', 'claude', 'freshell'],
      ['OpenCode agent', 'opencode', 'OpenCode agent'],
      ['Claude CLI', 'claude', 'Claude CLI'],
      ['Billing bug', 'claude', undefined],
      ['Tab 9', 'codex', 'Invoice rounding'],
    ]
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    labelled.forEach(([tabTitle, mode, paneTitle], index) => {
      const tabId = `t${index}`
      tabs.push({ id: tabId, title: tabTitle })
      layouts[tabId] = scoped(`p${index}`, mode, `sess-${index}`)
      if (paneTitle) paneTitles[tabId] = { [`p${index}`]: paneTitle }
    })
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 't0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    })

    const imports = prepareLegacyNameImports([{ storageKey: 'freshell.layout.v3', raw }])
    const candidates = imports.flatMap((one) => one.candidates)
    expect(candidates.map((c) => [c.scope, c.name]).sort()).toEqual([
      ['pane', 'Invoice rounding'],
      ['source_tab', 'Billing bug'],
    ])
  })

  it("skips a session-owned tab's title entirely — it is a display copy, not evidence", () => {
    const raw = JSON.stringify({
      version: 4,
      tabs: {
        activeTabId: 't',
        tabs: [{ id: 't', title: 'Billing bug', nameSource: { kind: 'session', paneId: 'pane-1' } }],
      },
      panes: {
        version: 7,
        layouts: { t: scopedTerminalPane('sess-owned') },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
    })
    expect(prepareLegacyNameImports([{ storageKey: 'freshell.layout.v3', raw }])).toEqual([])
  })

  it('derives a retry-stable legacy-pending namingHandle for an unbound scoped pane and persists the assignment', () => {
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 't', tabs: [{ id: 't', title: 'Pre Identity' }] },
      panes: {
        version: 7,
        layouts: { t: unboundScopedPane() },
        paneTitles: { t: { 'pane-unbound': 'Named Before Identity' } },
        paneTitleSetByUser: { t: { 'pane-unbound': true } },
      },
    })
    localStorage.setItem('freshell.layout.v3', raw)
    runOneTimeLegacyCapture(localStorage)
    const evidence = capturedEvidence()

    const assignments = collectLegacyPendingHandleAssignments(evidence)
    expect(assignments).toHaveLength(1)
    expect(assignments[0].namingHandle).toBe(legacyPendingNamingHandle({
      storageKey: 'freshell.layout.v3',
      windowId: null,
      paneId: 'pane-unbound',
      createRequestId: 'req-unbound',
    }))
    expect(JSON.parse(assignments[0].namingHandle)).toEqual([
      'legacy-pending', 'freshell.layout.v3', null, 'pane-unbound', 'req-unbound',
    ])

    // The candidate targets the derived pending handle.
    const imports = prepareLegacyNameImports(evidence)
    expect(imports[0].candidates[0].target).toEqual({
      kind: 'pending',
      id: assignments[0].namingHandle,
    })
    // Retry stability: re-derivation produces the same handle.
    expect(collectLegacyPendingHandleAssignments(evidence)[0].namingHandle)
      .toBe(assignments[0].namingHandle)
  })

  it('yields no candidates from a corrupted envelope and chunks oversized envelopes at 100 candidates', () => {
    expect(prepareLegacyNameImports([
      { storageKey: 'freshell.layout.v3.corrupt', raw: '{not json' },
    ])).toEqual([])

    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 150; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    })
    const imports = prepareLegacyNameImports([
      { storageKey: 'freshell.layout.v3', raw },
    ])
    expect(imports).toHaveLength(2)
    expect(imports[0].candidates).toHaveLength(100)
    expect(imports[1].candidates).toHaveLength(50)
    expect(imports[0].importId).not.toBe(imports[1].importId)
  })
})

// ── submit ──────────────────────────────────────────────────────────────────

describe('legacy-name import submission', () => {
  function seedPending(): void {
    localStorage.setItem('freshell.layout.v3', layoutEnvelope())
    runOneTimeLegacyCapture(localStorage)
  }

  it('submits pending imports, deletes the acknowledged envelope, and marks the device done', async () => {
    seedPending()
    apiMocks.post.mockResolvedValue({
      acknowledged: ['c-1'],
      names: [],
    })
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(0)
    expect(isCaptureDone(localStorage)).toBe(true)
    // Acknowledged: a second submit is a no-op.
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })

  it('retires candidate-free envelopes (nothing to import) without a request', async () => {
    // A genuine legacy layout holding only a shell tab: captured, but it
    // yields no candidate.
    localStorage.setItem('freshell.layout.v3', JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-shell', tabs: [{ id: 'tab-shell', title: 'Shell Tab' }] },
      panes: { version: 7, layouts: { 'tab-shell': shellPane() }, paneTitles: {}, paneTitleSetByUser: {} },
    }))
    runOneTimeLegacyCapture(localStorage)
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(1)
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(0)
    expect(isCaptureDone(localStorage)).toBe(true)
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('keeps a failed submit pending for retry (never acknowledges, never clears evidence)', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    seedPending()
    apiMocks.post.mockRejectedValue(new Error('network down'))
    await expect(submitPendingLegacyNameImports()).rejects.toThrow('network down')
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(1)
    expect(isCaptureDone(localStorage)).toBe(false)
    // Retry once the server answers.
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    expect(isCaptureDone(localStorage)).toBe(true)
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
  })

  it('acknowledges a deterministic 400 locally (it can never succeed on retry)', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the rejection path logs
    seedPending()
    apiMocks.post.mockRejectedValue(new apiMocks.ApiError(400, 'Invalid request'))
    await submitPendingLegacyNameImports()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(1)
  })

  it('retires an oversized envelope after its chunked imports acknowledge (no endless re-submit)', async () => {
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 150; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    localStorage.setItem('freshell.layout.v3', JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    }))
    runOneTimeLegacyCapture(localStorage)
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })

    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
    // Both chunks acknowledged → the envelope is fully retired: a second
    // ready edge never re-submits it.
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).toHaveBeenCalledTimes(2)
  })

  it('a failed later chunk keeps the envelope pending and resubmits only the unacknowledged chunks', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 250; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    localStorage.setItem('freshell.layout.v3', JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    }))
    runOneTimeLegacyCapture(localStorage)
    const base = listCapturedMigrationEnvelopes(localStorage)[0].importId
    const postedImportIds = () =>
      apiMocks.post.mock.calls.map(([, body]) => (body as { importId: string }).importId)

    // Chunk 0 of 3 succeeds; chunk 1 fails transiently (a non-400 error —
    // network/5xx — which must stay retryable).
    apiMocks.post.mockImplementation(async (_url: string, body: unknown) => {
      const importId = (body as { importId: string }).importId
      if (importId === `${base}--1`) throw new Error('transient network failure')
      return { acknowledged: [], names: [] }
    })
    await expect(submitPendingLegacyNameImports()).rejects.toThrow('transient network failure')
    expect(postedImportIds()).toEqual([`${base}--0`, `${base}--1`])

    // The envelope is still pending — chunk 0's success must NOT retire
    // it — so the next ready edge resubmits ONLY the unacknowledged
    // chunks (chunk 0 replays as a per-candidate no-op, so it is not
    // even sent).
    apiMocks.post.mockClear()
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    expect(postedImportIds()).toEqual([`${base}--1`, `${base}--2`])

    // Every chunk is now acknowledged → the envelope retires: a further
    // ready edge sends nothing.
    apiMocks.post.mockClear()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(listCapturedMigrationEnvelopes(localStorage)).toHaveLength(0)
    expect(isCaptureDone(localStorage)).toBe(true)
  })

  it('pairs chunks to envelopes by evidence — an importId containing "--" never breaks the retirement bookkeeping', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure path logs
    // A captured envelope whose id contains `--` (a legal nanoid pair —
    // seen in a real coordinated run): the chunk ids become
    // `edge--case--0/1`, and the envelope↔chunk pairing must still hold.
    const tabs: Array<Record<string, unknown>> = []
    const layouts: Record<string, unknown> = {}
    const paneTitles: Record<string, Record<string, string>> = {}
    for (let index = 0; index < 150; index += 1) {
      const tabId = `tab-${index}`
      tabs.push({ id: tabId })
      layouts[tabId] = scopedTerminalPane(`sess-${index}`)
      paneTitles[tabId] = { 'pane-1': `P ${index}` }
    }
    const raw = JSON.stringify({
      version: 4,
      tabs: { activeTabId: 'tab-0', tabs },
      panes: { version: 7, layouts, paneTitles, paneTitleSetByUser: {} },
    })
    localStorage.setItem(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.edge--case`, JSON.stringify({
      version: 1,
      importId: 'edge--case',
      storageKey: 'freshell.layout.v3',
      raw,
      capturedAt: 1,
    }))

    // Chunk 0 succeeds, chunk 1 fails transiently: the envelope (whose id
    // a `--`-split heuristic would mangle) must STAY pending.
    apiMocks.post.mockImplementation(async (_url: string, body: unknown) => {
      const importId = (body as { importId: string }).importId
      if (importId === 'edge--case--1') throw new Error('transient network failure')
      return { acknowledged: [], names: [] }
    })
    await expect(submitPendingLegacyNameImports()).rejects.toThrow('transient network failure')
    // Still pending: the next ready edge resubmits only the missing chunk.
    apiMocks.post.mockClear()
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await submitPendingLegacyNameImports()
    const posted = apiMocks.post.mock.calls.map(([, body]) => (body as { importId: string }).importId)
    expect(posted).toEqual(['edge--case--1'])
    // Fully acknowledged → retired: nothing further is sent.
    apiMocks.post.mockClear()
    await submitPendingLegacyNameImports()
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('importLegacyNames posts the migration envelope to the import endpoint', async () => {
    apiMocks.post.mockResolvedValue({ acknowledged: [], names: [] })
    await importLegacyNames([
      { version: 1, importId: 'i-1', evidence: [], candidates: [] },
    ])
    expect(apiMocks.post).toHaveBeenCalledWith(
      '/api/session-names/import',
      { version: 1, importId: 'i-1', evidence: [], candidates: [] },
    )
  })
})

// ── the one client sanitizer ─────────────────────────────────────────────────

describe('the one client sanitizer', () => {
  it('strips scoped pane titles/flags while preserving out-of-scope entries verbatim', () => {
    const { paneTitles, paneTitleSetByUser } = stripScopedPaneTitleMetadata(
      {
        'tab-1': scopedTerminalPane('sess-1'),
        'tab-shell': shellPane(),
      },
      {
        'tab-1': { 'pane-1': 'Pane Alias' },
        'tab-shell': { 'pane-shell': 'Shell Title' },
      },
      {
        'tab-1': { 'pane-1': true },
        'tab-shell': { 'pane-shell': true },
      },
    )
    expect(paneTitles).toEqual({ 'tab-shell': { 'pane-shell': 'Shell Title' } })
    expect(paneTitleSetByUser).toEqual({ 'tab-shell': { 'pane-shell': true } })
  })

  it('strips a session-owned tab freeze flag but keeps the title projection and legacy tabs verbatim', () => {
    const [sessionOwned, legacy] = stripSessionOwnedTabFreezeFlags([
      { id: 't1', title: 'Projection', titleSetByUser: true, nameSource: { kind: 'session', paneId: 'p1' } },
      { id: 't2', title: 'Legacy', titleSetByUser: true },
    ])
    expect(sessionOwned).toEqual({ id: 't1', title: 'Projection', nameSource: { kind: 'session', paneId: 'p1' } })
    expect(legacy).toEqual({ id: 't2', title: 'Legacy', titleSetByUser: true })
  })

  it('gates the persisted parse: scoped aliases never re-enter state, identity and source pointers survive', () => {
    const parsed = parsePersistedLayoutRaw(JSON.stringify({
      version: 4,
      persistedAt: 9,
      tabs: {
        activeTabId: 't1',
        tabs: [
          { id: 't1', title: 'Old Tab Title', titleSetByUser: true, nameSource: { kind: 'session', paneId: 'p1' } },
          { id: 't2', title: 'Legacy Tab', titleSetByUser: true },
        ],
      },
      panes: {
        version: 7,
        layouts: {
          t1: {
            type: 'leaf',
            id: 'p1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              sessionRef: { provider: 'claude', sessionId: 'sess-1' },
              nameRef: { kind: 'session', provider: 'claude', sessionId: 'sess-1' },
              namingHandle: 'h1',
            },
          },
          t2: shellPane(),
        },
        activePane: { t1: 'p1' },
        paneTitles: { t1: { p1: 'Scoped Alias' }, t2: { 'pane-shell': 'Shell Title' } },
        paneTitleSetByUser: { t1: { p1: true }, t2: { 'pane-shell': true } },
      },
    }))
    expect(parsed).not.toBeNull()
    // Scoped aliases dropped at parse…
    expect(parsed!.panes.paneTitles).toEqual({ t2: { 'pane-shell': 'Shell Title' } })
    expect(parsed!.panes.paneTitleSetByUser).toEqual({ t2: { 'pane-shell': true } })
    // …while identity, the source pointer and projections survive.
    const content = (parsed!.panes.layouts.t1 as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: 'sess-1' })
    expect(content.nameRef).toEqual({ kind: 'session', provider: 'claude', sessionId: 'sess-1' })
    expect(content.namingHandle).toBe('h1')
    const sessionOwned = parsed!.tabs.tabs.find((t) => t.id === 't1')!
    expect(sessionOwned.title).toBe('Old Tab Title')
    expect(sessionOwned.titleSetByUser).toBeUndefined()
    expect(sessionOwned.nameSource).toEqual({ kind: 'session', paneId: 'p1' })
    const legacy = parsed!.tabs.tabs.find((t) => t.id === 't2')!
    expect(legacy.titleSetByUser).toBe(true)
  })
})

// ── capture-source taxonomy ──────────────────────────────────────────────────

describe('capture-source key taxonomy', () => {
  it('accepts only the genuine pre-migration keys holding a pre-names raw', () => {
    const preNames = layoutEnvelope()
    for (const key of [
      'freshell.layout.v3',
      'freshell.layout.v3.bak',
      'freshell.layout.pre-migration-raw.v1',
      'freshell.tabs.v2',
      'freshell.panes.v2',
    ]) {
      expect(isGenuinePreMigrationSource(key, preNames), key).toBe(true)
    }
    // Live per-window keys and every channel the current client writes.
    for (const key of [
      'freshell.layout.v3.window-a',
      'freshell.layout.v3.window-a.bak',
      'freshell.layout.v3.window-a.backup-before-fresh-agent-centralization',
      'freshell.layout.v3.backup-before-fresh-agent-centralization',
      'freshell.layout.pre-migration-raw.v1.window-a',
      'freshell.layout.v3.window-a.fresh-agent-centralization-commit',
      'freshell.layout.v3.window-a.fresh-agent-centralization-pending',
      'freshell.session-names.migration.v1.abc',
      'freshell.session-names.capture-done.v1',
      'freshell.browser-preferences.v1',
      'freshell.layout.legacy-adopted.v1',
    ]) {
      expect(isGenuinePreMigrationSource(key, preNames), key).toBe(false)
    }
    // A genuine key whose bytes are missing, corrupt, or already carry
    // unified-names fields.
    expect(isGenuinePreMigrationSource('freshell.layout.v3', null)).toBe(false)
    expect(isGenuinePreMigrationSource('freshell.layout.v3', '{corrupt')).toBe(false)
    expect(isGenuinePreMigrationSource('freshell.layout.v3', JSON.stringify({
      tabs: { tabs: [{ id: 't', title: 'x', nameSource: { kind: 'legacy' } }] },
    }))).toBe(false)
  })
})
