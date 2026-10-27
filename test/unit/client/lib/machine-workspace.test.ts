import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecoveryInventory: vi.fn(),
}))
vi.mock('@/store/tabRegistrySync', () => ({
  getCurrentTabRegistryClientInstanceId: () => 'client-machine-test',
}))
vi.mock('@/lib/recovery/boot-state', () => ({
  bootCapturedAtMs: 1_000,
}))

import { api, getRecoveryInventory } from '@/lib/api'
import { MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY } from '@/lib/machine-identity'
import { restoreMachineWorkspace } from '@/lib/machine-workspace'
import tabsReducer, { addTab, setActiveTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, splitPane } from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import type { RecoveryInventory } from '@/lib/recovery/types'

const MACHINE_ID = 'machine-desktop'

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
    },
  })
}

function addForeignWorkspace(store: ReturnType<typeof createStore>) {
  store.dispatch(addTab({ id: 'foreign-tab', title: 'Foreign workspace' }))
  store.dispatch(initLayout({
    tabId: 'foreign-tab',
    paneId: 'foreign-pane',
    content: { kind: 'terminal', createRequestId: 'foreign-create', status: 'creating', mode: 'shell' },
  }))
}

function inventoryFor(machineId: string): RecoveryInventory {
  return {
    recoverable: true,
    contentId: `content-${machineId}`,
    device: {
      deviceId: machineId,
      deviceLabel: 'DANDESKTOP',
      capturedAt: 2_000,
      tabs: [{
        tabKey: `${machineId}:recovered-tab`,
        tabName: 'Recovered workspace',
        panes: [{
          paneId: 'recovered-pane',
          kind: 'terminal',
          mode: 'shell',
          shell: null,
          cwd: '/work',
          payload: {},
          sessionRef: null,
          ledgerState: 'unknown',
          live: false,
        }],
      }],
    },
    otherDevices: [],
    ledgerOnly: [],
  }
}

function addRecoveredTab(inventory: RecoveryInventory, machineId: string, tabId: string, title: string) {
  inventory.device?.tabs.push({
    tabKey: `${machineId}:${tabId}`,
    tabName: title,
    panes: [{
      paneId: `${tabId}-pane`,
      kind: 'terminal',
      mode: 'shell',
      shell: null,
      cwd: '/work',
      payload: {},
      sessionRef: null,
      ledgerState: 'unknown',
      live: false,
    }],
  })
}

function recoveredTerminal(
  paneId: string,
  createRequestId: string,
  mode = 'shell',
) {
  return {
    paneId,
    kind: 'terminal' as const,
    mode,
    shell: null,
    cwd: '/work',
    payload: { createRequestId, terminalId: `server-${paneId}`, status: 'running' },
    sessionRef: null,
    ledgerState: 'unknown' as const,
    live: false,
  }
}

function terminalContentAt(
  store: ReturnType<typeof createStore>,
  tabId: string,
  paneId: string,
) {
  const layout = store.getState().panes.layouts[tabId]
  if (!layout) throw new Error(`missing layout for ${tabId}`)
  const findLeaf = (node: typeof layout): import('@/store/paneTypes').TerminalPaneContent | undefined => {
    if (node.type === 'leaf') {
      return node.id === paneId && node.content.kind === 'terminal' ? node.content : undefined
    }
    return findLeaf(node.children[0]) ?? findLeaf(node.children[1])
  }
  const content = findLeaf(layout)
  if (!content) throw new Error(`missing terminal pane ${paneId}`)
  return content
}

describe('restoreMachineWorkspace', () => {
  beforeEach(() => {
    vi.mocked(getRecoveryInventory).mockReset()
    localStorage.clear()
  })

  it('replaces local state with only the selected machine scoped workspace before sync can start', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(getRecoveryInventory).toHaveBeenCalledWith(
      'machine-bootstrap:client-machine-test',
      expect.any(Number),
      { machineId: MACHINE_ID },
    )
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Recovered workspace'])
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['recovered-tab'])
    expect(store.getState().panes.layouts['recovered-tab']?.id).toBe('recovered-pane')
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).not.toContain('foreign-tab')
    expect(store.getState().panes.layouts['foreign-tab']).toBeUndefined()
  })

  it('requests the machine-bootstrap inventory so the window’s own last snapshot is included', async () => {
    const store = createStore()
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    await restoreMachineWorkspace(store, MACHINE_ID, { reason: 'corrupt' })

    expect(getRecoveryInventory).toHaveBeenCalledWith(
      'machine-bootstrap:client-machine-test',
      expect.any(Number),
      { machineId: MACHINE_ID },
    )
  })

  it('derives the bootstrap exclusion id from the REGISTRY client id, not the per-window layout-window id (e3r1 finding 3c pin)', async () => {
    // The layout envelope key follows the mint-once layout-window-id
    // (window-layout-keys.ts), but the bootstrap exclusion id keeps using
    // the tab-registry client id so the server can still exclude (or, for
    // the reserved prefix, include) the window's own tabs-sync snapshot.
    sessionStorage.setItem('freshell.layout-window-id.v1', 'layout-window-distinct-from-registry-id')
    const store = createStore()
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    await restoreMachineWorkspace(store, MACHINE_ID, { reason: 'absent' })

    expect(getRecoveryInventory).toHaveBeenCalledWith(
      'machine-bootstrap:client-machine-test',
      expect.any(Number),
      { machineId: MACHINE_ID },
    )
    expect(getRecoveryInventory).not.toHaveBeenCalledWith(
      'machine-bootstrap:layout-window-distinct-from-registry-id',
      expect.any(Number),
      expect.anything(),
    )
    sessionStorage.removeItem('freshell.layout-window-id.v1')
  })

  it('preserves snapshot createRequestIds through the same-machine restore reducer for terminals and every fresh-agent variant', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    const recoveredTab = inventory.device!.tabs[0]
    recoveredTab.panes = [
      {
        paneId: 'terminal-pane',
        kind: 'terminal',
        mode: 'shell',
        shell: null,
        cwd: '/work',
        payload: {
          createRequestId: 'server-terminal-create-request-id',
          terminalId: 'stale-terminal-id',
          status: 'running',
        },
        sessionRef: null,
        ledgerState: 'unknown',
        live: false,
      },
      ...([
        ['freshclaude', 'claude'],
        ['kilroy', 'claude'],
        ['freshcodex', 'codex'],
        ['freshopencode', 'opencode'],
      ] as const).map(([sessionType, provider]) => ({
        paneId: `${sessionType}-pane`,
        kind: 'fresh-agent',
        mode: sessionType,
        shell: null,
        cwd: '/work',
        payload: {
          sessionType,
          provider,
          createRequestId: `server-${sessionType}-create-request-id`,
          sessionId: `stale-${sessionType}-session`,
          status: 'running',
          serverInstanceId: 'stale-server',
        },
        sessionRef: null,
        ledgerState: 'unknown' as const,
        live: false,
      })),
    ]
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    const layout = store.getState().panes.layouts['recovered-tab']
    if (!layout) throw new Error('expected recovered layout')
    const leaves: Record<string, import('@/store/paneTypes').PaneContent> = {}
    const collectLeaves = (node: typeof layout): void => {
      if (node.type === 'leaf') {
        leaves[node.id] = node.content
        return
      }
      collectLeaves(node.children[0])
      collectLeaves(node.children[1])
    }
    collectLeaves(layout)

    const terminal = leaves['terminal-pane']
    if (terminal?.kind !== 'terminal') throw new Error('expected recovered terminal')
    expect(terminal.createRequestId).toBe('server-terminal-create-request-id')
    expect(terminal.terminalId).toBeUndefined()
    expect(terminal.status).toBe('creating')

    for (const sessionType of ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']) {
      const content = leaves[`${sessionType}-pane`]
      if (content?.kind !== 'fresh-agent') throw new Error(`expected recovered ${sessionType}`)
      expect(content.createRequestId).toBe(`server-${sessionType}-create-request-id`)
      expect(content.sessionId).toBeUndefined()
      expect(content.serverInstanceId).toBeUndefined()
      expect(content.status).toBe('creating')
    }
  })

  it('keeps a local crash trace when same-machine recovery restores the same terminal identity', async () => {
    const store = createStore()
    const crashTrace = { exitCode: 137, resumedAtMs: 2_345 }
    localStorage.setItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY, MACHINE_ID)
    store.dispatch(addTab({ id: 'recovered-tab', title: 'Cached workspace' }))
    store.dispatch(initLayout({
      tabId: 'recovered-tab',
      paneId: 'recovered-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'same-create-request',
        status: 'creating',
        mode: 'shell',
        crashTrace,
      },
    }))
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].panes[0].payload = { createRequestId: 'same-create-request' }
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(terminalContentAt(store, 'recovered-tab', 'recovered-pane').crashTrace).toEqual(crashTrace)
  })

  it('does not copy a local crash trace onto a different machine with the same terminal identity', async () => {
    const store = createStore()
    const sourceMachineId = 'machine-desktop'
    const targetMachineId = 'machine-garage'
    localStorage.setItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY, sourceMachineId)
    store.dispatch(addTab({ id: 'recovered-tab', title: 'Cached desktop workspace' }))
    store.dispatch(initLayout({
      tabId: 'recovered-tab',
      paneId: 'recovered-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'same-create-request',
        status: 'running',
        mode: 'shell',
        crashTrace: { exitCode: 137, resumedAtMs: 2_345 },
      },
    }))
    const inventory = inventoryFor(targetMachineId)
    inventory.device!.tabs[0].panes[0].payload = { createRequestId: 'same-create-request' }
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, targetMachineId)

    expect(terminalContentAt(store, 'recovered-tab', 'recovered-pane').crashTrace).toBeUndefined()
    expect(localStorage.getItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY)).toBe(targetMachineId)
  })

  it('preserves only matching crash traces across tabs and split panes from the same machine', async () => {
    const store = createStore()
    localStorage.setItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY, MACHINE_ID)
    const traceA = { exitCode: 137, resumedAtMs: 2_345 }
    const traceB = { exitCode: 9, resumedAtMs: 3_456 }
    const traceC = { exitCode: 1, resumedAtMs: 4_567 }

    store.dispatch(addTab({ id: 'tab-a', title: 'Cached A' }))
    store.dispatch(initLayout({
      tabId: 'tab-a',
      paneId: 'tab-a-pane-1',
      content: {
        kind: 'terminal', createRequestId: 'create-a', terminalId: 'stale-a',
        status: 'running', mode: 'shell', crashTrace: traceA,
      },
    }))
    store.dispatch(splitPane({
      tabId: 'tab-a',
      paneId: 'tab-a-pane-1',
      direction: 'horizontal',
      newPaneId: 'tab-a-pane-2',
      newContent: {
        kind: 'terminal', createRequestId: 'create-b', terminalId: 'stale-b',
        status: 'running', mode: 'shell', crashTrace: traceB,
      },
    }))
    store.dispatch(addTab({ id: 'tab-b', title: 'Cached B' }))
    store.dispatch(initLayout({
      tabId: 'tab-b',
      paneId: 'tab-b-pane',
      content: {
        kind: 'terminal', createRequestId: 'create-c', terminalId: 'stale-c',
        status: 'running', mode: 'shell', crashTrace: traceC,
      },
    }))

    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0] = {
      tabKey: `${MACHINE_ID}:tab-a`,
      tabName: 'Recovered A',
      panes: [
        recoveredTerminal('tab-a-pane-1', 'create-a'),
        recoveredTerminal('tab-a-pane-2', 'different-create-b'),
      ],
    }
    addRecoveredTab(inventory, MACHINE_ID, 'tab-b', 'Recovered B')
    inventory.device!.tabs[1].panes = [recoveredTerminal('tab-b-pane', 'create-c')]
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(terminalContentAt(store, 'tab-a', 'tab-a-pane-1')).toMatchObject({
      crashTrace: traceA,
      createRequestId: 'create-a',
      status: 'creating',
      terminalId: undefined,
    })
    expect(terminalContentAt(store, 'tab-a', 'tab-a-pane-2').crashTrace).toBeUndefined()
    expect(terminalContentAt(store, 'tab-b', 'tab-b-pane')).toMatchObject({
      crashTrace: traceC,
      createRequestId: 'create-c',
      status: 'creating',
      terminalId: undefined,
    })
  })

  it.each([
    ['a different create request id', 'shell', 'different-create-request'],
    ['a different terminal mode', 'codex', 'same-create-request'],
  ] as const)('does not copy a crash trace onto recovery with %s', async (_description, mode, createRequestId) => {
    const store = createStore()
    // These are identity-mismatch tests, not origin-gate tests. Seed the
    // same-machine origin explicitly so either mismatch is what rejects the
    // stale decoration when this case runs independently.
    localStorage.setItem(MACHINE_WORKSPACE_ORIGIN_STORAGE_KEY, MACHINE_ID)
    store.dispatch(addTab({ id: 'recovered-tab', title: 'Cached workspace' }))
    store.dispatch(initLayout({
      tabId: 'recovered-tab',
      paneId: 'recovered-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'same-create-request',
        status: 'creating',
        mode: 'shell',
        crashTrace: { exitCode: 137, resumedAtMs: 2_345 },
      },
    }))
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].panes[0].mode = mode
    inventory.device!.tabs[0].panes[0].payload = { createRequestId }
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(terminalContentAt(store, 'recovered-tab', 'recovered-pane').crashTrace).toBeUndefined()
  })

  it('preserves a still-recovered active tab across machine workspace replacement', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].tabKey = `${MACHINE_ID}:tab-a`
    inventory.device!.tabs[0].tabName = 'Tab A'
    inventory.device!.tabs[0].panes[0].paneId = 'tab-a-pane'
    addRecoveredTab(inventory, MACHINE_ID, 'tab-b', 'Tab B')
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    store.dispatch(addTab({ id: 'tab-a', title: 'Cached Tab A' }))
    store.dispatch(addTab({ id: 'tab-b', title: 'Cached Tab B' }))
    store.dispatch(setActiveTab('tab-a'))

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b'])
    expect(store.getState().tabs.activeTabId).toBe('tab-a')
  })

  it('keeps the deterministic restored-tab fallback when the prior active tab is absent', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].tabKey = `${MACHINE_ID}:tab-a`
    inventory.device!.tabs[0].tabName = 'Tab A'
    inventory.device!.tabs[0].panes[0].paneId = 'tab-a-pane'
    addRecoveredTab(inventory, MACHINE_ID, 'tab-b', 'Tab B')
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)
    addForeignWorkspace(store)

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b'])
    expect(store.getState().tabs.activeTabId).toBe('tab-b')
  })

  it('restores the workspace tabs in the inventory device.tabs order', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    const base = inventoryFor(MACHINE_ID)
    const pane = base.device!.tabs[0].panes[0]
    const mkTab = (key: string, name: string) => ({
      tabKey: key, tabName: name, panes: [{ ...pane, paneId: `${key}-pane` }],
    })
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      ...base,
      device: {
        ...base.device!,
        // Deliberately NOT tabKey/alphabetical order.
        tabs: [mkTab(`${MACHINE_ID}:tab-mango`, 'Mango'), mkTab(`${MACHINE_ID}:tab-apple`, 'Apple')],
      },
    })

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Mango', 'Apple'])
  })

  it('refuses an unscoped foreign recovery response and preserves the current cache', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor('machine-garage'))

    await expect(restoreMachineWorkspace(store, MACHINE_ID)).rejects.toThrow(/machine-garage/i)
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Foreign workspace'])
  })

  it('clears stale local state when the ACTIVELY CHOSEN machine has no durable workspace', async () => {
    // The chooser-pick lane under the MERGED (Choice B) semantics: the user
    // just picked this machine, so the App boot gate classifies the local
    // layout — possibly a DIFFERENT machine's stale cache — as foreign and
    // rebuilds with reason:'foreign' (the chooser's one-shot active-selection
    // marker plus the machine-id stamp prove foreignness at the gate; see
    // App.machine-identity.test.tsx and layout-health.test.ts). A
    // non-recoverable inventory (the chosen machine has no durable
    // workspace) still clears it: the chosen machine's empty truth wins.
    // Updated from #774's `{ activeSelection: true }` option, which the
    // merged gate superseded.
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      recoverable: false,
      contentId: 'empty',
      device: null,
      otherDevices: [],
      ledgerOnly: [],
    })

    await restoreMachineWorkspace(store, MACHINE_ID, { reason: 'foreign' })

    expect(store.getState().tabs.tabs).toEqual([])
    expect(store.getState().panes.layouts).toEqual({})
  })

  it('clears stale local state when the selected machine has no durable workspace', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      recoverable: false,
      contentId: 'empty',
      device: null,
      otherDevices: [],
      ledgerOnly: [],
    })

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs).toEqual([])
    expect(store.getState().panes.layouts).toEqual({})
  })

  it('replaces the local layout unconditionally on a rebuild decision — the boot gate owns the keep-vs-rebuild call (Choice B merge of #774)', async () => {
    // MERGED SEMANTICS (replaces #774's restore-level "keeps the rehydrated
    // local layout when nothing foreign is recoverable on a
    // remembered-machine reload"): under Choice B the App boot gate keeps a
    // HEALTHY local layout and never calls restoreMachineWorkspace, so this
    // function — reached only for absent/corrupt/foreign/stale layouts —
    // always replaces local state, even when the inventory is
    // non-recoverable. #774's underlying intent (a natural reload with
    // nothing foreign keeps the workspace) SURVIVES one layer up: the
    // healthy-keep gate is pinned in App.machine-identity.test.tsx ("keeps
    // a healthy local workspace: no restore call...") and end-to-end in
    // local-first-reload-rust.spec.ts scenario 1.
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      recoverable: false,
      contentId: 'empty',
      device: null,
      otherDevices: [],
      ledgerOnly: [],
    })

    const result = await restoreMachineWorkspace(store, MACHINE_ID, { reason: 'stale' })

    expect(result.restoredTabs).toBe(0)
    expect(store.getState().tabs.tabs).toEqual([])
    expect(store.getState().panes.layouts).toEqual({})
  })

  it('still converges to a recoverable foreign generation on a rebuild', async () => {
    // A rebuild with a NEWER foreign generation on the machine: the restore
    // still replaces the local layout with the machine's newest
    // cross-client truth.
    const store = createStore()
    addForeignWorkspace(store)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    const result = await restoreMachineWorkspace(store, MACHINE_ID)

    expect(result.restoredTabs).toBe(1)
    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Recovered workspace'])
    expect(store.getState().tabs.tabs.map((tab) => tab.id)).not.toContain('foreign-tab')
  })

  it.each(['absent', 'corrupt', 'foreign', 'stale'] as const)(
    'still fetches with the bootstrap exclusion id, clears, and restores when told the boot reason is %s',
    async (reason) => {
      const store = createStore()
      addForeignWorkspace(store)
      vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

      const result = await restoreMachineWorkspace(store, MACHINE_ID, { reason })

      expect(getRecoveryInventory).toHaveBeenCalledWith(
        'machine-bootstrap:client-machine-test',
        expect.any(Number),
        { machineId: MACHINE_ID },
      )
      expect(result).toEqual({ restoredTabs: 1 })
      expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Recovered workspace'])
      expect(store.getState().tabs.tabs.map((tab) => tab.id)).not.toContain('foreign-tab')
      expect(store.getState().panes.layouts['foreign-tab']).toBeUndefined()
    },
  )
})

describe('restoreMachineWorkspace — unified agent names (Task 6)', () => {
  it('threads the recovered plan nameSource into the restored tab', async () => {
    const store = createStore()
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0] = {
      tabKey: `${MACHINE_ID}:recovered-tab`,
      tabName: 'Recovered workspace',
      nameSource: { kind: 'session', paneId: 'recovered-pane' },
      panes: [{
        paneId: 'recovered-pane',
        kind: 'terminal',
        mode: 'claude',
        shell: null,
        cwd: '/work',
        payload: { createRequestId: 'crid-agent' },
        sessionRef: { provider: 'claude', sessionId: 'sess-agent' },
        ledgerState: 'unknown',
        live: false,
      }],
    }
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    const tab = store.getState().tabs.tabs.find((t) => t.id === 'recovered-tab')
    expect(tab).toBeTruthy()
    expect(tab?.nameSource).toEqual({ kind: 'session', paneId: 'recovered-pane' })
  })
})

// ── unified agent names (Task 7) ─────────────────────────────────────────────

describe('restoreMachineWorkspace — unified agent names (Task 7)', () => {
  beforeEach(() => {
    vi.mocked(getRecoveryInventory).mockReset()
    localStorage.clear()
  })

  it('machine-workspace restore performs no legacy capture', async () => {
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ acknowledged: [], names: [] })
    const store = createStore()
    addForeignWorkspace(store)
    const legacyRaw = JSON.stringify({
      version: 4,
      persistedAt: 9,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Old Agent Tab', titleSetByUser: true }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'p-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              sessionRef: { provider: 'claude', sessionId: 'sess-legacy' },
            },
          },
        },
        activePane: { 'tab-1': 'p-1' },
        paneTitles: { 'tab-1': { 'p-1': 'Old User Pane Name' } },
        paneTitleSetByUser: { 'tab-1': { 'p-1': true } },
      },
    })
    localStorage.setItem('freshell.layout.v3', legacyRaw)
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventoryFor(MACHINE_ID))

    await restoreMachineWorkspace(store, MACHINE_ID)

    // The one-time capture runs only at module load; a rebuild copies
    // nothing into a migration envelope and sends nothing.
    const migrationKeys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith('freshell.session-names.migration.v1.')) migrationKeys.push(key)
    }
    expect(migrationKeys).toEqual([])
    expect(postSpy).not.toHaveBeenCalled()
    // The genuine legacy key itself is left in place.
    expect(localStorage.getItem('freshell.layout.v3')).toBe(legacyRaw)
    postSpy.mockRestore()
  })

  it('restores scoped recovery panes with no scoped pane-title aliases and intact identity', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0].panes = [{
      paneId: 'recovered-pane',
      kind: 'terminal',
      mode: 'claude',
      shell: null,
      cwd: '/work',
      payload: {
        createRequestId: 'crid-agent',
        nameRef: { kind: 'session', provider: 'claude', sessionId: 'sess-agent' },
        namingHandle: 'handle-agent',
      },
      sessionRef: { provider: 'claude', sessionId: 'sess-agent' },
      ledgerState: 'unknown',
      live: false,
    }]
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID)

    // The scoped pane restored with its canonical identity (the migrated
    // name follows the pane), and NO pane-title alias was installed.
    const content = terminalContentAt(store, 'recovered-tab', 'recovered-pane')
    expect(content.nameRef).toEqual({
      kind: 'session', provider: 'claude', sessionId: 'sess-agent',
    })
    expect(content.namingHandle).toBe('handle-agent')
    expect(store.getState().panes.paneTitles['recovered-tab'] ?? {}).toEqual({})
    expect(store.getState().panes.paneTitleSetByUser['recovered-tab'] ?? {}).toEqual({})
  })
})

// ── name reliability (Task 9) ────────────────────────────────────────────────

describe('restoreMachineWorkspace — name reliability (Task 9)', () => {
  beforeEach(() => {
    vi.mocked(getRecoveryInventory).mockReset()
    localStorage.clear()
  })

  it('restoreMachineWorkspace keeps titleSetByUser on legacy tabs', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    const inventory = inventoryFor(MACHINE_ID)
    inventory.device!.tabs[0] = {
      tabKey: `${MACHINE_ID}:recovered-tab`,
      tabName: 'MyShellTab',
      titleSetByUser: true,
      nameSource: { kind: 'legacy' },
      panes: [{
        paneId: 'recovered-pane',
        kind: 'terminal',
        mode: 'shell',
        shell: null,
        cwd: '/work',
        title: 'KeepMePane',
        titleSetByUser: true,
        payload: { createRequestId: 'crid-shell' },
        sessionRef: null,
        ledgerState: 'unknown',
        live: false,
      }],
    }
    addRecoveredTab(inventory, MACHINE_ID, 'unrenamed-tab', 'user@host: ~')
    inventory.device!.tabs[1].panes[0].title = 'user@host: ~'
    vi.mocked(getRecoveryInventory).mockResolvedValue(inventory)

    await restoreMachineWorkspace(store, MACHINE_ID, { reason: 'absent' })

    const state = store.getState()
    const renamed = state.tabs.tabs.find((tab) => tab.id === 'recovered-tab')
    expect(renamed?.title).toBe('MyShellTab')
    expect(renamed?.titleSetByUser).toBe(true)
    expect(state.panes.paneTitles['recovered-tab']).toEqual({ 'recovered-pane': 'KeepMePane' })
    expect(state.panes.paneTitleSetByUser['recovered-tab']).toEqual({ 'recovered-pane': true })

    // A tab nobody renamed restores its automatic titles, unprotected.
    const unrenamed = state.tabs.tabs.find((tab) => tab.id === 'unrenamed-tab')
    expect(unrenamed?.titleSetByUser).toBeFalsy()
    expect(state.panes.paneTitles['unrenamed-tab']).toEqual({ 'unrenamed-tab-pane': 'user@host: ~' })
    expect(state.panes.paneTitleSetByUser['unrenamed-tab'] ?? {}).toEqual({})
  })
})
