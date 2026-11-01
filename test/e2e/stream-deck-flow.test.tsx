// E2E flow suite for the Stream Deck stack: full user journeys through the
// REAL Redux store + REAL DeckController + fake transport (FakeDeckDevice).
// Only ws-client is mocked (to record outbound frames); renderers are
// spec-encoding stubs because jsdom has no real canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer, { markTabAttention } from '@/store/turnCompletionSlice'
import freshAgentReducer, { addPermissionRequest } from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer, { upsertClaudeActivity } from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import antigravityActivityReducer from '@/store/antigravityActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import repoIconsReducer, { type RepoIconEntry } from '@/store/repoIconsSlice'
import type { Tab } from '@/store/types'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { DeckKeyLayout, DeckTileStyle } from '@shared/settings'
import { FakeDeckDevice, PLUS_CAPS } from '@/deck/fake-deck-device'
import type { DeckCapabilities } from '@/deck/deck-device'
import { DeckController, type DeckControllerOptions } from '@/deck/deck-controller'
import { IconImageCache } from '@/deck/icon-image-cache'
import { providerIconDataUrl } from '@/deck/provider-icon-svg'
import { PANE_TINT_COLORS } from '@/deck/pane-tint-colors'
import { registerTerminalTextReader, resetTerminalTextRegistryForTests } from '@/deck/terminal-text-registry'
import type { KeySpec } from '@/deck/frame'
import { getTabDisplayTitle } from '@/lib/tab-title'
import type { RootState } from '@/store/store'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  antigravityActivity: antigravityActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer, terminalMeta: terminalMetaReducer, repoIcons: repoIconsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

type DeckStoreOpts = {
  tabs?: number // tab count (t1..tN), default 2
  activeTab?: string // tabs.activeTabId seed, default 't1'
  busy?: string[] // terminalIds marked busy via claudeActivity
  attention?: Record<string, boolean> // attentionByTab seed
  freshAgentTab?: number // 1-based tab index hosting the fresh-agent pane (session s1)
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
  paneStatus?: Record<string, Tab['status']> // per-pane content status override (p1..pN)
  /** Seed state.terminalMeta.byTerminalId (terminalId/updatedAt filled in). */
  terminalMeta?: Record<string, { cwd?: string; repoRoot?: string; checkoutRoot?: string }>
  /** Seed state.repoIcons.byCwd. */
  repoIcons?: Record<string, RepoIconEntry>
  /**
   * Seed settings.localSettings.streamDeck.tileStyle through the production
   * patch action (updateSettingsLocal), BEFORE any controller starts, so the
   * live-settings setup (setupLive) sees it on its first paint.
   */
  tileStyle?: DeckTileStyle
  /**
   * Seed settings.localSettings.streamDeck.keyLayout the same way. Defaults to
   * 'status-sorted': existing tests document the STANDARD arrangement
   * explicitly ('auto' resolves REVERSED on <= 6-key decks and would silently
   * flip Mini-based fixtures); 'auto' resolution and the reversed arrangement
   * have dedicated tests.
   */
  keyLayout?: DeckKeyLayout
  /**
   * Override stored tab titles by 1-based tab index (default `tab${i}`), e.g.
   * { 1: 'Tab 1' } to exercise the raw-placeholder replacement path.
   */
  titles?: Record<number, string>
  /**
   * Seed the claude terminal leaf's initialCwd by 1-based tab index — the same
   * seeding the deck-selectors parity fixtures use (claudeLeaf's initialCwd).
   */
  initialCwd?: Record<number, string>
}

// Local extraction of the deck-controller unit-suite fixture builder: tabs
// t1..tN, terminal leaf panes p1..pN with terminalId term-N (mode 'claude');
// freshAgentTab makes that tab a fresh-agent pane bound to session s1.
function makeDeckStore(opts: DeckStoreOpts = {}) {
  const tabCount = opts.tabs ?? 2
  const tabs = Array.from({ length: tabCount }, (_, i) => ({
    id: `t${i + 1}`, createRequestId: `c${i + 1}`, title: opts.titles?.[i + 1] ?? `tab${i + 1}`, status: 'running', mode: 'shell', createdAt: i + 1,
  }))
  const layouts: Record<string, unknown> = {}
  const activePane: Record<string, string> = {}
  for (let i = 1; i <= tabCount; i++) {
    const isAgent = opts.freshAgentTab === i
    layouts[`t${i}`] = {
      type: 'leaf', id: `p${i}`,
      content: isAgent
        ? { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: `c${i}`, status: 'running' }
        : { kind: 'terminal', terminalId: `term-${i}`, createRequestId: `c${i}`, status: opts.paneStatus?.[`p${i}`] ?? 'running', mode: 'claude', ...(opts.initialCwd?.[i] ? { initialCwd: opts.initialCwd[i] } : {}) },
    }
    activePane[`t${i}`] = `p${i}`
  }
  const busyByTerminalId = Object.fromEntries(
    (opts.busy ?? []).map((terminalId) => [terminalId, { terminalId, phase: 'busy', updatedAt: 1 }]),
  )
  const store = configureStore({
    reducer,
    preloadedState: {
      ...(opts.terminalMeta
        ? {
            terminalMeta: {
              byTerminalId: Object.fromEntries(Object.entries(opts.terminalMeta).map(
                ([terminalId, meta]) => [terminalId, { terminalId, updatedAt: 0, ...meta }],
              )),
            },
          }
        : {}),
      ...(opts.repoIcons ? { repoIcons: { byCwd: opts.repoIcons } } : {}),
      tabs: { tabs, activeTabId: opts.activeTab ?? 't1', renameRequestTabId: null, tombstones: [] },
      panes: {
        layouts, activePane,
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: {
        byTerminalId: busyByTerminalId,
        lastSnapshotSeq: 0, liveMutationSeqByTerminalId: {}, removedMutationSeqByTerminalId: {},
      },
      turnCompletion: {
        seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [],
        attentionByTab: opts.attention ?? {}, attentionByPane: {},
      },
      freshAgent: {
        sessions: opts.freshAgentTab
          ? {
              [s1Key]: {
                sessionKey: s1Key, threadId: 's1', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1',
                status: opts.freshAgentRunning ? 'running' : 'idle', streamingActive: false,
                pendingPermissions: opts.pendingPermissions ?? {}, pendingQuestions: {},
              },
            }
          : {},
        pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
      },
    } as never,
  })
  if (opts.tileStyle !== undefined) {
    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: opts.tileStyle } }))
  }
  store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: opts.keyLayout ?? 'status-sorted' } }))
  return store
}

// Spec-encoding renderer + decoder: the "pixels" are the KeySpec JSON, so
// tests can decode exactly what landed on the fake device.
function encodeSpec(spec: KeySpec): Uint8ClampedArray {
  return new TextEncoder().encode(JSON.stringify(spec)) as unknown as Uint8ClampedArray
}
function decodeKey(device: FakeDeckDevice, key: number): KeySpec | null {
  const buf = device.keyImages.get(key)
  return buf ? JSON.parse(new TextDecoder().decode(buf as unknown as Uint8Array)) : null
}
function decodeStrip(device: FakeDeckDevice): string | null {
  return device.stripImage ? new TextDecoder().decode(device.stripImage.rgba as unknown as Uint8Array) : null
}

type DeckSettings = { brightness: number; idleBrightness: number; idleTimeoutSeconds: number; tileStyle: DeckTileStyle }
const defaultSettings = (): DeckSettings => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300, tileStyle: 'status-icons' as const })

let activeController: DeckController | null = null

function setup(
  opts: DeckStoreOpts = {},
  caps?: DeckCapabilities,
  settings: () => DeckSettings = defaultSettings,
  extra?: Partial<DeckControllerOptions>,
) {
  const store = makeDeckStore(opts)
  const device = new FakeDeckDevice(caps)
  const controller = new DeckController({
    store: store as never,
    device,
    renderKey: (spec) => encodeSpec(spec),
    renderStrip: (text) => new TextEncoder().encode(text) as unknown as Uint8ClampedArray,
    settings,
    ...extra,
  })
  controller.start()
  activeController = controller
  return { store, device, controller }
}

// Like setup(), but the controller reads settings live from the real store,
// so dispatching a settings patch changes controller behavior mid-session.
function setupLive(opts: DeckStoreOpts = {}, caps?: DeckCapabilities) {
  const store = makeDeckStore(opts)
  const device = new FakeDeckDevice(caps)
  const controller = new DeckController({
    store: store as never,
    device,
    renderKey: (spec) => encodeSpec(spec),
    renderStrip: (text) => new TextEncoder().encode(text) as unknown as Uint8ClampedArray,
    settings: () => store.getState().settings.settings.streamDeck,
  })
  controller.start()
  activeController = controller
  return { store, device, controller }
}

// Deferred icon loader, ported from icon-image-cache.test.ts: resolve/reject each
// url by hand. jsdom never loads images, so post-load assertions REQUIRE this.
function deferredLoader() {
  const pending = new Map<string, { resolve: (b: CanvasImageSource) => void; reject: (e: Error) => void }>()
  const loader = (url: string) =>
    new Promise<CanvasImageSource>((resolve, reject) => pending.set(url, { resolve, reject }))
  return { loader, pending }
}

function holdKey(device: FakeDeckDevice, keyIndex: number, ms: number) {
  device.emit({ type: 'keyDown', keyIndex })
  vi.advanceTimersByTime(ms)
  device.emit({ type: 'keyUp', keyIndex })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  sendMock.mockClear()
})
afterEach(() => {
  activeController?.stop()
  activeController = null
  resetTerminalTextRegistryForTests()
  vi.useRealTimers()
})

describe('Stream Deck e2e flows (fake transport, real store)', () => {
  it('tabs appear on keys with titles, fills, paneIcons, and icons', () => {
    const { device } = setup({
      tabs: 3,
      busy: ['term-1'],
      attention: { t2: true },
      freshAgentTab: 3,
      pendingPermissions: { r1: { requestId: 'r1' } },
    })
    // Status-priority sort: t2 attention (greenFill) < t3 waiting fresh-agent
    // (greenIcon) < t1 busy (blueIcon), so busy t1 lands after the others.
    expect(decodeKey(device, 0)).toEqual({
      kind: 'tab', style: 'icons', tabId: 't2', title: 'tab2', active: false,
      fill: 'green', paneIcons: [{ provider: 'claude', tint: 'green', ready: false }], icons: [],
    })
    expect(decodeKey(device, 1)).toEqual({
      kind: 'tab', style: 'icons', tabId: 't3', title: 'tab3', active: false,
      fill: 'none', paneIcons: [{ provider: 'freshclaude', tint: 'green', ready: false }], icons: [],
    })
    expect(decodeKey(device, 2)).toEqual({
      kind: 'tab', style: 'icons', tabId: 't1', title: 'tab1', active: true,
      fill: 'none', paneIcons: [{ provider: 'claude', tint: 'blue', ready: false }], icons: [],
    })
  })

  it('press focuses the tab in this browser', () => {
    const { store, device } = setup({ tabs: 3, attention: { t2: true } })
    expect(store.getState().tabs.activeTabId).toBe('t1')
    // t2 has attention (greenFill) so it sorts to key 0; after focus+dismiss
    // all tabs are greenIcon again and t2 repaints at key 1 in tab-bar order
    holdKey(device, 0, 100)
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('t2')
    expect(state.turnCompletion.attentionByTab.t2).toBeFalsy()
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2', active: true, fill: 'none' })
  })

  it('tile fill and paneIcons track state changes', () => {
    const { store, device } = setup({ tabs: 3, freshAgentTab: 3 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', fill: 'none', paneIcons: [{ provider: 'claude', tint: 'green', ready: false }] })
    store.dispatch(upsertClaudeActivity({ terminals: [{ terminalId: 'term-1', phase: 'busy', updatedAt: 1 }] }))
    // busy t1 (blueIcon) sorts after the green-icon tabs -> key 2
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't1', paneIcons: [{ provider: 'claude', tint: 'blue', ready: false }] })
    store.dispatch(markTabAttention({ tabId: 't1' }))
    // attention outranks busy; active+attention (barTop) sorts t1 back to key 0
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', fill: 'barTop' })
    store.dispatch(addPermissionRequest({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r9',
    }))
    // a pending approval suppresses busy on the fresh-agent tab: still a green pane-icon tile
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't3', fill: 'none', paneIcons: [{ provider: 'freshclaude', tint: 'green', ready: false }] })
  })

  it('overflow paging with wrap on the 6-key profile', () => {
    const { device } = setup({ tabs: 8 })
    expect(decodeKey(device, 5)).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
    device.press(5)
    expect(decodeKey(device, 5)).toEqual({ kind: 'pager', page: 2, pageCount: 2 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't6' })
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't8' })
    expect(decodeKey(device, 3)).toEqual({ kind: 'empty' })
    device.press(5)
    expect(decodeKey(device, 5)).toEqual({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
  })

  it('long-press APPROVE sends the exact allow frame and closes the layer', () => {
    const { device } = setup({ freshAgentTab: 2, pendingPermissions: { r1: { requestId: 'r1' } } })
    holdKey(device, 1, 600)
    expect(decodeKey(device, 0)).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: true })
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: false })
    device.press(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const frame = sendMock.mock.calls[0][0]
    expect(frame).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    })
    expect(frame.decision).toEqual({ behavior: 'allow' })
    expect('updatedInput' in frame.decision).toBe(false)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
  })

  it('STOP with escalation on a terminal pane; abandoned layer auto-closes', () => {
    const { device } = setup({ busy: ['term-1'] })
    // busy t1 (blueIcon) sorts after green-icon t2 -> t1 lands on key 1
    holdKey(device, 1, 600)
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: true })
    device.press(2)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x1b' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
    // second STOP within the 5s escalation window -> Ctrl+C
    holdKey(device, 1, 600)
    device.press(2)
    expect(sendMock.mock.calls[1][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x03' })
    // a layer left open auto-closes after the 10s timeout
    holdKey(device, 1, 600)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
    vi.advanceTimersByTime(10_500)
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't1' })
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('idle dim & wake: dims after the timeout, wakes on press without swallowing it', () => {
    const { store, device } = setup(
      { tabs: 2 }, undefined,
      () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 1 }),
    )
    vi.advanceTimersByTime(1_500)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(10)
    holdKey(device, 1, 100)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(100)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('Deck+ dials and strip: cycle, page clamp, strip text, touch wake', () => {
    const { store, device } = setup(
      { tabs: 10, busy: ['term-1'], attention: { t2: true }, freshAgentTab: 2, pendingPermissions: { r1: { requestId: 'r1' } } },
      PLUS_CAPS,
      () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 1 }),
    )
    // no pager key on the dial profile: all 8 keys are tab tiles.
    // Sorted order: t2 attention (greenFill) stays first, busy t1 (blueIcon)
    // lands last, so page 1 shows t2..t9. Strip counts busy=1 (t1) and
    // waiting=1 (t2 attention).
    for (let k = 0; k < PLUS_CAPS.keyCount; k++) {
      expect(decodeKey(device, k)).toMatchObject({ kind: 'tab', tabId: `t${k + 2}` })
    }
    expect(decodeStrip(device)).toBe('tab1  |  page 1/2  |  1 busy  1 waiting')
    // dial 0 cycles the active tab and wraps in both directions
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t2')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t1')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t10') // wraps first -> last
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t1') // wraps last -> first
    // dial 1 pages, clamped at the last page (sorted list: [t2..t10, t1])
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 1 })
    expect(decodeStrip(device)).toContain('page 2/2')
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't10' })
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 1 })
    expect(decodeStrip(device)).toContain('page 2/2') // clamped
    device.emit({ type: 'dialPress', dialIndex: 1 })
    expect(decodeStrip(device)).toContain('page 1/2')
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't2' })
    // touchTap while dimmed restores brightness
    vi.advanceTimersByTime(1_500)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(10)
    device.emit({ type: 'touchTap' })
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(100)
  })

  it('graceful teardown: stop() clears the device and halts repainting', () => {
    const { store, device, controller } = setup({ tabs: 2 })
    expect(device.keyImages.size).toBeGreaterThan(0)
    controller.stop()
    expect(device.cleared).toBe(true)
    expect(device.keyImages.size).toBe(0)
    const brightnessCalls = device.brightnessHistory.length
    store.dispatch(markTabAttention({ tabId: 't1' }))
    vi.advanceTimersByTime(5_000)
    expect(device.keyImages.size).toBe(0) // no repaints after stop
    expect(device.stripImage).toBeNull()
    expect(device.brightnessHistory.length).toBe(brightnessCalls)
  })

  it('keys are sorted by status priority and stable within groups', () => {
    // 5 tabs: t1 exited(rest), t2 busy(blue), t3 idle-running(green icon),
    // t4 attention(green fill), t5 active+attention(barTop)
    const { device } = setup({
      tabs: 5, activeTab: 't5',
      paneStatus: { p1: 'exited' }, busy: ['term-2'], attention: { t4: true, t5: true },
    })
    const ids = [0, 1, 2, 3, 4].map((k) => {
      const spec = decodeKey(device, k)
      return spec?.kind === 'tab' ? spec.tabId : null
    })
    expect(ids).toEqual(['t5', 't4', 't3', 't2', 't1'])
  })

  it('tiles carry the three background treatments and the active ring flag', () => {
    const { device } = setup({ tabs: 3, activeTab: 't1', attention: { t1: true, t2: true } })
    expect(decodeKey(device, 0)).toMatchObject({ tabId: 't1', fill: 'barTop', active: true })
    expect(decodeKey(device, 1)).toMatchObject({ tabId: 't2', fill: 'green', active: false })
    expect(decodeKey(device, 2)).toMatchObject({ tabId: 't3', fill: 'none', active: false })
  })

  it('busy and idle-running tabs expose blue/green paneIcons', () => {
    const { device } = setup({ tabs: 2, busy: ['term-2'] })
    expect(decodeKey(device, 0)).toMatchObject({ tabId: 't1', paneIcons: [{ provider: 'claude', tint: 'green', ready: false }] }) // idle running
    expect(decodeKey(device, 1)).toMatchObject({ tabId: 't2', paneIcons: [{ provider: 'claude', tint: 'blue', ready: false }] })  // busy sorts after green
  })

  it('repo icons: unready at first paint, repaint to ready when the bitmap loads', async () => {
    // Requires both harness extensions (Interfaces): setup()'s 4th extra-controller-options
    // param (else { iconCache } is silently ignored and pending stays empty) and the
    // deferredLoader helper ported from icon-image-cache.test.ts.
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader)
    const { device } = setup({
      tabs: 1,
      terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    }, undefined, defaultSettings, { iconCache: cache })
    const before = decodeKey(device, 0)
    expect(before).toMatchObject({ icons: [{ letter: 'A', ready: false }] })
    pending.get((before as Extract<KeySpec, { kind: 'tab' }>).icons[0].url!)!.resolve({} as CanvasImageSource)
    await vi.advanceTimersByTimeAsync(0)
    expect(decodeKey(device, 0)).toMatchObject({ icons: [{ letter: 'A', ready: true }] })
  })

  it('pager pages over the SORTED order', () => {
    // 8 tabs on a 6-key Mini -> 5 tab slots + pager. Make t8 attention: it must appear on page 1 key 0.
    const { device } = setup({ tabs: 8, attention: { t8: true } })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't8' })
    expect(decodeKey(device, 5)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
    device.press(5) // next page
    // Sorted order: t8,t1,t2,t3,t4 on page 1 (5 tab slots); t5,t6,t7 on page 2.
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't5' })
  })

  it('a mid-press re-sort does not retarget the press (e2e)', () => {
    const { store, device } = setup({ tabs: 2, activeTab: 't1' })
    device.emit({ type: 'keyDown', keyIndex: 1 })
    store.dispatch(markTabAttention({ tabId: 't2' })) // from '@/store/turnCompletionSlice' - object payload
    vi.advanceTimersByTime(100)
    device.emit({ type: 'keyUp', keyIndex: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('short-press focuses, long-press opens the action layer - on the sorted layout', () => {
    const { store, device } = setup({ tabs: 3, attention: { t3: true } }) // t3 sorts to key 0
    device.press(0)
    expect(store.getState().tabs.activeTabId).toBe('t3')
    holdKey(device, 1, 600) // long-press whatever now occupies key 1
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
  })

  describe('deck font loading', () => {
    it('font ready forces a full repaint of otherwise-unchanged keys, and stop() cancels the wait', () => {
      let fontCb: (() => void) | null = null
      let cancelled = false
      const { device, controller } = setup({ tabs: 2 }, undefined, defaultSettings, {
        fontReady: (onReady) => {
          fontCb = onReady
          return () => { cancelled = true }
        },
      })
      expect(fontCb).not.toBeNull()
      // Steady state: nothing changed, so a plain repaint would paint zero keys.
      device.keyImages.clear()
      fontCb!()
      // The font hook invalidates the diff cache -> every visible key repaints.
      expect(device.keyImages.size).toBeGreaterThan(0)
      controller.stop()
      expect(cancelled).toBe(true)
    })
  })
})

describe('tile styles', () => {
  it('classic style: tabs appear with titles, previews, and rings, in tab-bar order', () => {
    registerTerminalTextReader('term-1', () => ['$ npm test', 'PASS'])
    setupLive({ tabs: 3, activeTab: 't1', busy: ['term-2'], attention: { t3: true } })
    // start in default style, flip to classic through the production settings path
    // (or preload localSettings if makeDeckStore supports it — either is fine)
    // ...dispatch happens in the switch test below; here seed classic directly:
    activeController!.stop()
    const { device: d2 } = setupLive({ tabs: 3, activeTab: 't1', busy: ['term-2'], attention: { t3: true }, tileStyle: 'terminal-previews' })
    expect(decodeKey(d2, 0)).toMatchObject({
      kind: 'tab', style: 'preview', tabId: 't1',
      previewLines: ['$ npm test', 'PASS'], active: true,
    })
    // tab-bar order, NOT attention-sorted: t3 (attention) stays on key 2
    expect(decodeKey(d2, 1)).toMatchObject({ tabId: 't2', ring: 'blue' })
    expect(decodeKey(d2, 2)).toMatchObject({ tabId: 't3', ring: 'green' })
  })

  it('switching styles live repaints, reorders, and stops/starts polling — no reload', () => {
    let n = 0
    registerTerminalTextReader('term-1', () => [`line ${n++}`])
    const { store, device } = setupLive({ tabs: 3, activeTab: 't1', attention: { t3: true } })
    // default: icons style, attention-sorted (t3 first)
    expect(decodeKey(device, 0)).toMatchObject({ style: 'icons', tabId: 't3', fill: 'green' })

    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'terminal-previews' } }))
    // sanity: the patch survived the shared-settings whitelists (guards a silent no-op; see task brief Step 1)
    expect(store.getState().settings.settings.streamDeck.tileStyle).toBe('terminal-previews')
    // live re-sort to tab-bar order + preview specs
    expect(decodeKey(device, 0)).toMatchObject({ style: 'preview', tabId: 't1' })
    expect(decodeKey(device, 2)).toMatchObject({ style: 'preview', tabId: 't3', ring: 'green' })
    // polling is live: changing text repaints within 3s
    const before = decodeKey(device, 0)!
    vi.advanceTimersByTime(3_000)
    expect(decodeKey(device, 0)).not.toEqual(before)

    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'status-icons' } }))
    // back to sorted icons style...
    expect(decodeKey(device, 0)).toMatchObject({ style: 'icons', tabId: 't3' })
    // ...and polling stops: 3s of changing text paints nothing
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBe(0)
  })

  it('mid-press style switch does not retarget the press', () => {
    const { store, device } = setupLive({ tabs: 3, activeTab: 't1', attention: { t3: true } })
    // key 0 is t3 (sorted). Press down, flip style (re-sorts to tab-bar order), release.
    device.emit({ type: 'keyDown', keyIndex: 0 })
    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'terminal-previews' } }))
    device.emit({ type: 'keyUp', keyIndex: 0 })
    expect(store.getState().tabs.activeTabId).toBe('t3') // press-snapshot guard holds across the flip
  })

  it('Deck+ strip counts waiting as attention OR pending approval, in both styles', () => {
    const { store, device } = setupLive({ tabs: 2, freshAgentTab: 2, attention: { t1: true } }, PLUS_CAPS)
    store.dispatch(addPermissionRequest({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    }))
    expect(decodeStrip(device)).toContain('2 waiting')
    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: 'terminal-previews' } }))
    expect(decodeStrip(device)).toContain('2 waiting')
  })

  it('icons style: busy agent pane surfaces as a blue-tinted paneIcon on the wire', () => {
    const { device } = setup({ tabs: 2, busy: ['term-2'] })
    // Sorted order: idle-running t1 (green icon) at key 0, busy t2 (blue icon) at key 1.
    const spec = decodeKey(device, 1)
    expect(spec).toMatchObject({
      kind: 'tab',
      style: 'icons',
      tabId: 't2',
      // ready is false: jsdom never decodes images, so the default cache never
      // reports a bitmap — this asserts the pre-decode wire state.
      paneIcons: [{ provider: 'claude', tint: 'blue', ready: false }],
    })
  })

  it('icons style: pane icon flips to ready on the wire when its data URL decodes (A1 falsification fix, proven on the real controller+cache)', async () => {
    // Mirrors the repo-icon deferred-loader test above: the REAL IconImageCache
    // with a hand-resolved loader. buildFrame's iconReady probe (bitmapFor)
    // starts the load with the tinted data URL; resolving it fires the cache
    // notify, and the repaint must flip `ready` in the spec JSON — the diff-skip
    // in DeckController would otherwise never repaint this key.
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader)
    const { device } = setup({ tabs: 1 }, undefined, defaultSettings, { iconCache: cache })
    expect(decodeKey(device, 0)).toMatchObject({
      paneIcons: [{ provider: 'claude', tint: 'green', ready: false }],
    })
    const url = providerIconDataUrl('claude', PANE_TINT_COLORS.green)
    pending.get(url)!.resolve({} as CanvasImageSource) // frame-time probe already requested this exact URL
    await vi.advanceTimersByTimeAsync(0)
    expect(decodeKey(device, 0)).toMatchObject({
      paneIcons: [{ provider: 'claude', tint: 'green', ready: true }],
    })
  })
})

describe('key layout (reversed arrangement + auto default)', () => {
  it('newest-first on the 6-key profile: pager top-left, newest tab beside it, older tabs on page 2', async () => {
    const { device } = setupLive({ tabs: 8, keyLayout: 'newest-first' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't8' })
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't7' })
    device.press(0)
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
    device.press(0) // wraps back
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't8' })
  })

  it('auto default: the 6-key deck is newest-first, the 8-key Plus stays status-sorted', async () => {
    const mini = setupLive({ tabs: 3, keyLayout: 'auto' })
    expect(decodeKey(mini.device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    expect(decodeKey(mini.device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
    // stop the mini controller before starting the Plus one (afterEach only
    // stops the LAST controller) - same idiom as the classic-style test above.
    mini.controller.stop()
    const plus = setupLive({ tabs: 3, keyLayout: 'auto' }, PLUS_CAPS)
    expect(decodeKey(plus.device, 0)).toMatchObject({ kind: 'tab' }) // full mode, no pager
  })

  it('changing Key layout in settings re-arranges the deck live, without reconnecting', async () => {
    const { store, device } = setupLive({ tabs: 4, keyLayout: 'status-sorted' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' }) // standard: no pager when tabs fit
    store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't4' })
    store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'status-sorted' } }))
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
  })

  it('tiles and the touch strip show the tab bar displayed label (getTabDisplayTitle parity)', async () => {
    // Stored title is the raw 'Tab 1' placeholder; the single claude leaf
    // carries initialCwd '/home/dan/code/freshell' (same seeding as the
    // deck-selectors parity fixtures), on the PLUS profile so the strip renders.
    const { store, device } = setupLive(
      { tabs: 1, keyLayout: 'status-sorted', titles: { 1: 'Tab 1' }, initialCwd: { 1: '/home/dan/code/freshell' } },
      PLUS_CAPS,
    )
    // The tab bar's exact call shape (TabBar.tsx getDisplayTitle); this fixture
    // store has no extensions reducer, hence the RootState cast + ?.
    const s = store.getState() as unknown as RootState
    const tab = s.tabs.tabs[0]
    const expected = getTabDisplayTitle(tab, s.panes.layouts[tab.id], s.panes.paneTitles?.[tab.id], s.extensions?.entries)
    expect(expected).toBe('freshell') // and NOT 'Tab 1'
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', title: expected })
    expect(decodeStrip(device)).toContain(expected) // active-tab text on the strip
  })
})
