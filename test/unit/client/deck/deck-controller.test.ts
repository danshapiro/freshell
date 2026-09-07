import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
// Delta-r7-r3 (focused-episode-7 round 2, Finding F2): tabs closed mid-press
// route through the close gate, which awaits the correlated
// `pane.closed.result` — this mock answers every pane.closed with success
// (the healthy-server shape) so mid-press closes complete.
const closeAckHandlers = new Set<(msg: unknown) => void>()
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: (msg: unknown) => {
      sendMock(msg)
      const m = msg as { type?: string; createRequestId?: string; requestId?: string }
      if (m?.type === 'pane.closed' && m.createRequestId) {
        for (const handler of [...closeAckHandlers]) {
          handler({ type: 'pane.closed.result', createRequestId: m.createRequestId, success: true })
        }
      }
      // Focused-episode-7 round 3 (Finding F1): the whole-tab close is ONE
      // batch envelope — answer the correlated `panes.closed.result` too
      // (the healthy-server shape), or a mid-press closeTab wedges its gate.
      if (m?.type === 'panes.closed' && m.requestId) {
        for (const handler of [...closeAckHandlers]) {
          handler({ type: 'panes.closed.result', requestId: m.requestId, success: true })
        }
      }
    },
    onMessage: (handler: (msg: unknown) => void) => {
      closeAckHandlers.add(handler)
      return () => {
        closeAckHandlers.delete(handler)
      }
    },
  }),
}))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, closeTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer, { markTabAttention } from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import terminalMetaReducer, { upsertTerminalMeta } from '@/store/terminalMetaSlice'
import repoIconsReducer, { type RepoIconEntry } from '@/store/repoIconsSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { DeckKeyLayout, DeckTileStyle } from '@shared/settings'
import { registerTerminalTextReader, resetTerminalTextRegistryForTests } from '@/deck/terminal-text-registry'
import { FakeDeckDevice, PLUS_CAPS } from '@/deck/fake-deck-device'
import type { DeckCapabilities } from '@/deck/deck-device'
import { DeckController, type DeckControllerOptions } from '@/deck/deck-controller'
import { IconImageCache } from '@/deck/icon-image-cache'
import type { KeySpec } from '@/deck/frame'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer, terminalMeta: terminalMetaReducer, repoIcons: repoIconsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

type StoreOpts = {
  tabCount?: number
  claudeBusy?: boolean
  attention?: Record<string, boolean>
  freshAgentTab?: boolean // makes t2 a fresh-agent pane bound to session s1
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
  /** Seed state.terminalMeta.byTerminalId (terminalId/updatedAt filled in). */
  terminalMeta?: Record<string, { cwd?: string; repoRoot?: string; checkoutRoot?: string }>
  /** Seed state.repoIcons.byCwd. */
  repoIcons?: Record<string, RepoIconEntry>
  /** Dispatch updateSettingsLocal({ panes: { repoIconsOnTabs } }) BEFORE the controller starts. */
  repoIconsOnTabs?: boolean
  /**
   * Tile style. Seeds BOTH the store settings (selectDeckModel reads
   * state.settings.settings.streamDeck.tileStyle) and the controller's
   * settings() thunk (tick gating) - production call sites pass the whole
   * streamDeck settings object, so the two are always consistent there.
   */
  tileStyle?: DeckTileStyle
  /**
   * Key layout. Seeds the store settings (selectDeckModel reads
   * state.settings.settings.streamDeck.keyLayout); the controller's settings()
   * thunk does not carry keyLayout. Defaults to 'status-sorted': existing tests
   * document the STANDARD arrangement explicitly ('auto' resolves REVERSED on
   * <= 6-key decks and would silently flip Mini-based fixtures); 'auto'
   * resolution and the reversed arrangement have dedicated tests.
   */
  keyLayout?: DeckKeyLayout
}

// Mirrors the Task 3 fixture builder, parameterized by tab count: tabs t1..tN,
// terminal leaf panes p1..pN with terminalId term-N (mode 'claude'); when
// freshAgentTab is set, t2 becomes a fresh-agent pane bound to session s1.
function makeStore(opts: StoreOpts = {}) {
  const tabCount = opts.tabCount ?? 2
  const tabs = Array.from({ length: tabCount }, (_, i) => ({
    id: `t${i + 1}`, createRequestId: `c${i + 1}`, title: `tab${i + 1}`, status: 'running', mode: 'shell', createdAt: i + 1,
  }))
  const layouts: Record<string, unknown> = {}
  const activePane: Record<string, string> = {}
  for (let i = 1; i <= tabCount; i++) {
    const isAgent = !!opts.freshAgentTab && i === 2
    layouts[`t${i}`] = {
      type: 'leaf', id: `p${i}`,
      content: isAgent
        ? { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: `c${i}`, status: 'running' }
        : { kind: 'terminal', terminalId: `term-${i}`, createRequestId: `c${i}`, status: 'running', mode: 'claude' },
    }
    activePane[`t${i}`] = `p${i}`
  }
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
      tabs: { tabs, activeTabId: 't1', renameRequestTabId: null, tombstones: [] },
      panes: {
        layouts, activePane,
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: { byTerminalId: opts.claudeBusy ? { 'term-1': { phase: 'busy' } } : {} },
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
  if (opts.repoIconsOnTabs !== undefined) {
    // Precedent: deck-manager.test.ts:128 — the value must be in place BEFORE
    // setup() constructs and starts the controller.
    store.dispatch(updateSettingsLocal({ panes: { repoIconsOnTabs: opts.repoIconsOnTabs } }))
  }
  if (opts.tileStyle !== undefined) {
    store.dispatch(updateSettingsLocal({ streamDeck: { tileStyle: opts.tileStyle } }))
  }
  store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: opts.keyLayout ?? 'status-sorted' } }))
  return store
}

// Spec-recording renderer: encodes the KeySpec JSON into the pixel buffer so
// tests can decode exactly what landed on the device.
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

// Deferred loader as in icon-image-cache.test.ts: resolve/reject each url by hand.
function deferredLoader() {
  const pending = new Map<string, { resolve: (b: CanvasImageSource) => void; reject: (e: Error) => void }>()
  const loader = (url: string) =>
    new Promise<CanvasImageSource>((resolve, reject) => pending.set(url, { resolve, reject }))
  return { loader, pending }
}

const settings = () => ({ brightness: 100, idleBrightness: 10, idleTimeoutSeconds: 300, tileStyle: 'status-icons' as const })

let activeController: DeckController | null = null

function setup(opts: StoreOpts = {}, caps?: DeckCapabilities, extra?: Partial<DeckControllerOptions>) {
  const store = makeStore(opts)
  const device = new FakeDeckDevice(caps)
  const controller = new DeckController({
    store: store as never,
    device,
    renderKey: (spec) => encodeSpec(spec),
    renderStrip: (text) => new TextEncoder().encode(text) as unknown as Uint8ClampedArray,
    settings: opts.tileStyle !== undefined ? () => ({ ...settings(), tileStyle: opts.tileStyle! }) : settings,
    ...extra,
  })
  controller.start()
  activeController = controller
  return { store, device, controller }
}

function longPress(device: FakeDeckDevice, key: number) {
  device.emit({ type: 'keyDown', keyIndex: key })
  vi.advanceTimersByTime(600)
  device.emit({ type: 'keyUp', keyIndex: key })
}

function shortPress(device: FakeDeckDevice, key: number) {
  device.emit({ type: 'keyDown', keyIndex: key })
  vi.advanceTimersByTime(100)
  device.emit({ type: 'keyUp', keyIndex: key })
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

describe('DeckController', () => {
  it('paints tab tiles in tab order with active ring and asserts brightness on start', () => {
    const { device } = setup()
    expect(device.brightnessHistory[0]).toBe(100)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', title: 'tab1', active: true })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2', title: 'tab2', active: false })
    expect(decodeKey(device, 2)).toEqual({ kind: 'empty' })
    expect(decodeKey(device, 5)).toEqual({ kind: 'empty' })
  })

  it('short press focuses the tab in the browser and dismisses green', () => {
    const { store, device } = setup({ attention: { t2: true } })
    // t2 has attention (priority 1) so it sorts ahead of green-icon t1 -> key 0
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't2', fill: 'green', active: false })
    shortPress(device, 0)
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('t2')
    expect(state.turnCompletion.attentionByTab.t2).toBeFalsy()
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2', active: true, fill: 'none' })
  })

  it('acts on the tab displayed at press-down even if the sort changes mid-press', () => {
    // t1 greenIcon (key 0), t2 greenIcon (key 1); active tab defaults to t1.
    const { store, device } = setup({ tabCount: 2 })
    device.emit({ type: 'keyDown', keyIndex: 1 }) // user is pressing "t2"
    // Mid-press: t2 gains attention -> re-sort moves t2 to key 0; key 1 now shows t1.
    store.dispatch(markTabAttention({ tabId: 't2' }))
    // Sanity: the RED gate is armed - attention actually set, re-sort actually happened.
    expect(store.getState().turnCompletion.attentionByTab.t2).toBe(true)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't2' })
    vi.advanceTimersByTime(100)
    device.emit({ type: 'keyUp', keyIndex: 1 })
    // Snapshot guard: the press focuses t2 (what the user saw), not t1 (what the slot shows now)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('press on a tab that was closed mid-press is a no-op', async () => {
    const { store, device } = setup({ tabCount: 2 })
    device.emit({ type: 'keyDown', keyIndex: 1 })
    // The close gate (delta-r7-r3, F2) acknowledges pane closes before the
    // layout loses them — the dispatch promise resolves once the
    // acknowledged close completes (the mock answers inline).
    await store.dispatch(closeTab('t2'))
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1']) // t2 really gone mid-press
    vi.advanceTimersByTime(100)
    device.emit({ type: 'keyUp', keyIndex: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t1')
  })

  it('long-press opens the action layer for the press-down tab despite a mid-press re-sort', () => {
    // t2 is a fresh-agent pane with pending permission r1 -> APPROVE is enabled only
    // if the action layer targets t2; t1 is a plain terminal (approve target null).
    const { store, device } = setup({ tabCount: 2, freshAgentTab: true, pendingPermissions: { r1: { requestId: 'r1' } } })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2' }) // pre-press: t2 on key 1
    device.emit({ type: 'keyDown', keyIndex: 1 })
    store.dispatch(markTabAttention({ tabId: 't2' }))
    // Sanity: the RED gate is armed - attention set, mid-press re-sort moved t2 to key 0.
    expect(store.getState().turnCompletion.attentionByTab.t2).toBe(true)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't2' })
    vi.advanceTimersByTime(600)
    device.emit({ type: 'keyUp', keyIndex: 1 })
    // Action layer opened, targeting the press-down tab t2 (approve enabled via r1)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'action', action: 'approve', enabled: true })
  })

  it('store changes repaint only changed keys', () => {
    const { store, device } = setup()
    device.keyImages.clear()
    store.dispatch(markTabAttention({ tabId: 't1' }))
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1', fill: 'barTop' })
    expect(device.keyImages.has(1)).toBe(false)
    expect(device.keyImages.has(2)).toBe(false)
  })

  it('overflow paging: pager press advances and wraps', () => {
    const { device } = setup({ tabCount: 8 })
    // MINI: 6 keys -> 5 tab slots + pager at key 5; 8 tabs -> 2 pages
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

  it('long press opens the action layer; BACK closes; 10s auto-closes', () => {
    const { device } = setup()
    longPress(device, 0)
    expect(decodeKey(device, 0)).toEqual({ kind: 'action', action: 'back', enabled: true })
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: false })
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: false })
    device.press(0)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
    longPress(device, 0)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
    vi.advanceTimersByTime(10_500)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
  })

  it('APPROVE sends the allow frame without updatedInput and closes the layer', () => {
    const { device } = setup({ freshAgentTab: true, pendingPermissions: { r1: { requestId: 'r1' } } })
    longPress(device, 1)
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: true })
    device.press(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const frame = sendMock.mock.calls[0][0]
    expect(frame).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
      requestId: 'r1', decision: { behavior: 'allow' },
    })
    expect('updatedInput' in frame.decision).toBe(false)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
  })

  it('disabled APPROVE press keeps the layer open', () => {
    const { device } = setup({ freshAgentTab: true })
    longPress(device, 1)
    expect(decodeKey(device, 1)).toEqual({ kind: 'action', action: 'approve', enabled: false })
    device.press(1)
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'action', action: 'approve' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('STOP on a busy terminal sends ESC, then Ctrl+C within 5s', () => {
    const { device } = setup({ claudeBusy: true })
    // busy t1 (priority 3) sorts after green-icon t2 -> t1 lands on key 1
    longPress(device, 1)
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: true })
    device.press(2)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x1b' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
    // second stop within the 5s escalation window -> Ctrl+C
    longPress(device, 1)
    device.press(2)
    expect(sendMock.mock.calls[1][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x03' })
  })

  it('STOP on a busy fresh-agent pane sends freshAgent.interrupt, never terminal.input', () => {
    const { device } = setup({ freshAgentTab: true, freshAgentRunning: true })
    longPress(device, 1)
    expect(decodeKey(device, 2)).toEqual({ kind: 'action', action: 'stop', enabled: true })
    device.press(2)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0][0]).toEqual({
      type: 'freshAgent.interrupt', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    // escalation applies only to terminals: a second stop is still an interrupt frame
    longPress(device, 1)
    device.press(2)
    for (const call of sendMock.mock.calls) {
      expect(call[0].type).not.toBe('terminal.input')
    }
  })

  it('idle dim after timeout and wake on key press (wake does not swallow the press)', () => {
    const { store, device } = setup()
    vi.advanceTimersByTime(300_000)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(10)
    shortPress(device, 1)
    expect(device.brightnessHistory).toContain(10)
    expect(device.brightnessHistory[device.brightnessHistory.length - 1]).toBe(100)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('dials on PLUS: dial 0 cycles with wrap, dial 1 pages with clamp, strip updates', () => {
    const { store, device } = setup({ tabCount: 10 }, PLUS_CAPS)
    expect(decodeStrip(device)).toContain('page 1/2')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t2')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t1')
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: -1 })
    expect(store.getState().tabs.activeTabId).toBe('t10') // wrap-around
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 5 })
    expect(decodeStrip(device)).toContain('page 2/2') // clamped to last page
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't9' })
    device.emit({ type: 'dialPress', dialIndex: 1 })
    expect(decodeStrip(device)).toContain('page 1/2')
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' })
    device.emit({ type: 'dialPress', dialIndex: 0 })
    expect(store.getState().tabs.activeTabId).toBe('t10') // re-focus current active tab
  })

  it('repaints keys when an icon bitmap finishes loading (cache subscription)', async () => {
    // Deferred loader as in icon-image-cache.test.ts
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader)
    const { device } = setup({
      tabCount: 1,
      terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    }, undefined, { iconCache: cache })
    const before = decodeKey(device, 0)!
    expect(before.kind === 'tab' && before.icons[0].ready).toBe(false)
    pending.get(before.kind === 'tab' ? before.icons[0].url! : '')!.resolve({} as CanvasImageSource)
    await vi.advanceTimersByTimeAsync(0) // flush the load microtask under fake timers
    const after = decodeKey(device, 0)!
    expect(after.kind === 'tab' && after.icons[0].ready).toBe(true)
  })

  it('status-icons style: 3s of ticks paints nothing even when terminal text changes', () => {
    // A CHANGING reader is what makes this RED if polling leaks into the new style.
    let n = 0
    const unregister = registerTerminalTextReader('term-1', () => [`line ${n++}`])
    const { device } = setup({ tabCount: 1 })
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBe(0)
    unregister()
  })

  it('terminal-previews style: changing terminal text repaints within PREVIEW_REFRESH_TICKS', () => {
    let n = 0
    const unregister = registerTerminalTextReader('term-1', () => [`line ${n++}`])
    const { device } = setup({ tabCount: 1, tileStyle: 'terminal-previews' })
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBeGreaterThan(0)
    unregister()
  })

  it('terminal-previews style: static terminal text does not repaint on ticks', () => {
    const unregister = registerTerminalTextReader('term-1', () => ['same line'])
    const { device } = setup({ tabCount: 1, tileStyle: 'terminal-previews' })
    device.keyImages.clear()
    vi.advanceTimersByTime(3_000)
    expect(device.keyImages.size).toBe(0) // spec JSON unchanged -> per-key diff skips
    unregister()
  })

  it('dispatches fetchRepoIconMeta for tab cwds even when settings.panes.repoIconsOnTabs is false (deck owns the probe)', () => {
    // No repoIcons seeded: the controller itself must probe /repos/alpha. TabBar cannot be
    // relied on (its probe is gated on repoIconsOnTabs and TabBar is conditionally mounted).
    const { store } = setup({
      tabCount: 1,
      terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
      repoIconsOnTabs: false,
    })
    // The thunk's pending case records { status: 'loading' } synchronously on dispatch.
    expect(store.getState().repoIcons.byCwd['/repos/alpha']).toMatchObject({ status: 'loading' })
  })

  it('does not re-probe a cwd already present in state.repoIcons.byCwd', () => {
    const { store } = setup({
      tabCount: 1,
      terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    expect(store.getState().repoIcons.byCwd['/repos/alpha'].status).toBe('ready') // untouched, no 'loading' overwrite
  })

  it('probes a cwd that only becomes resolvable AFTER start (late terminalMeta, model JSON unchanged)', () => {
    // Fixture panes have no initialCwd, so nothing is resolvable at start(). A later
    // upsertTerminalMeta makes term-1's cwd resolvable but does NOT change the deck
    // model JSON (icons stay [] until meta AND repoIcons both exist), so this test
    // proves the probe runs BEFORE onStoreChange's model-JSON bail-out - the exact
    // TabBar-less leader scenario the deck-owned probe exists for.
    const { store } = setup({ tabCount: 1 }) // no terminalMeta seeded
    expect(store.getState().repoIcons.byCwd['/repos/alpha']).toBeUndefined()
    store.dispatch(upsertTerminalMeta([{ terminalId: 'term-1', cwd: '/repos/alpha', updatedAt: Date.now() }]))
    expect(store.getState().repoIcons.byCwd['/repos/alpha']).toMatchObject({ status: 'loading' })
  })

  it('reversed: pager pinned to key 0; newest tab on key 1; press advances and wraps', () => {
    const { device } = setup({ tabCount: 8, keyLayout: 'newest-first' }) // MINI: 5 tabs/page -> 2 pages
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't8' }) // last tab in the bar
    expect(decodeKey(device, 5)).toMatchObject({ kind: 'tab', tabId: 't4' })
    shortPress(device, 0)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 2, pageCount: 2 })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
    shortPress(device, 0) // wraps
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
  })

  it('reversed: pager press with a single page is a harmless wrap to the same page', () => {
    const { device } = setup({ tabCount: 2, keyLayout: 'newest-first' })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    shortPress(device, 0)
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2' }) // unchanged
  })

  it('auto resolves reversed on the 6-key Mini and standard on the 8-key Plus', () => {
    const mini = setup({ tabCount: 3, keyLayout: 'auto' })
    expect(decodeKey(mini.device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    expect(decodeKey(mini.device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
    const plus = setup({ tabCount: 3, keyLayout: 'auto' }, PLUS_CAPS)
    expect(decodeKey(plus.device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' }) // full mode, no pager
  })

  it('reversed: short press on key 1 focuses the newest tab', () => {
    const { store, device } = setup({ tabCount: 3, keyLayout: 'newest-first' })
    shortPress(device, 1)
    // Mirror the assertion style of 'short press focuses the tab in the browser' (:204)
    expect(store.getState().tabs.activeTabId).toBe('t3')
  })

  it('reversed: dial 0 cycles the ARRANGED tab list, not the model order (Plus, newest-first)', () => {
    const { store, device } = setup({ tabCount: 3, keyLayout: 'newest-first' }, PLUS_CAPS)
    // Focus t3 (the newest): reversed layout pins the pager to key 0, newest tab on key 1.
    shortPress(device, 1)
    expect(store.getState().tabs.activeTabId).toBe('t3')
    // Arranged list is tabIndex-descending [t3, t2, t1]: +1 from t3 must land on t2.
    // Cycling the un-arranged model order [t1, t2, t3] would wrap t3 -> t1 instead.
    device.emit({ type: 'dialRotate', dialIndex: 0, ticks: 1 })
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('reversed: press-snapshot guard - a tab opened mid-press cannot retarget the press', () => {
    // Mirrors 'acts on the tab displayed at press-down even if the sort changes
    // mid-press' (:225): keyDown on key 1 (currently t3, the newest), dispatch
    // the store action that adds a new tab t4 (shifting t3 to key 2), then keyUp
    // on key 1 - the press must still focus t3, not t4.
    const { store, device } = setup({ tabCount: 3, keyLayout: 'newest-first' })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' }) // pre-press: newest on key 1
    device.emit({ type: 'keyDown', keyIndex: 1 }) // user is pressing "t3"
    // Mid-press: a new tab t4 arrives -> the reversed arrangement moves it to key 1, shifting t3 to key 2.
    store.dispatch(addTab({ id: 't4', createRequestId: 'c4', title: 'tab4', status: 'running', mode: 'shell' }))
    // Sanity: the RED gate is armed - t4 really exists and took key 1; t3 moved to key 2.
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4'])
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't4' })
    expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't3' })
    vi.advanceTimersByTime(100)
    device.emit({ type: 'keyUp', keyIndex: 1 })
    // Snapshot guard: the press focuses t3 (what the user saw), not t4 (what the slot shows now)
    expect(store.getState().tabs.activeTabId).toBe('t3')
  })

  it('switching key layout live re-arranges keys and preserves the page when tabsPerPage is unchanged', () => {
    const { store, device } = setup({ tabCount: 8, keyLayout: 'status-sorted' })
    expect(decodeKey(device, 5)).toMatchObject({ kind: 'pager' }) // standard overflow pager, bottom-right
    shortPress(device, 5) // go to page 2 in standard
    store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 2, pageCount: 2 }) // page preserved: tabsPerPage unchanged (5), clampPage(2, 2) === 2
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' }) // reversed page 2 shows t3, t2, t1
  })

  it('switching key layout resets to page 1 when tabsPerPage changes (Plus: 8/page -> 7/page)', () => {
    const { store, device } = setup({ tabCount: 9, keyLayout: 'status-sorted' }, PLUS_CAPS)
    // Full mode standard: no pager key, 8 tabs/page -> 2 pages; page via dial 1.
    device.emit({ type: 'dialRotate', dialIndex: 1, ticks: 1 })
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't9' }) // page 2 in standard
    store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
    // tabsPerPage changed 8 -> 7: the existing tabsPerPage-change reset fires -> page 1.
    expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
    expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't9' }) // reversed page 1 starts with the newest
  })
})
