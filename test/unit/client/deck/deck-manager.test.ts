import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import deckReducer from '@/store/deckSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import antigravityActivityReducer from '@/store/antigravityActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import { FakeDeckDevice } from '@/deck/fake-deck-device'
import { DeckOpenError } from '@/deck/webhid-transport'
import {
  installStreamDeckManager, requestDeckConnect, resetStreamDeckManagerForTests,
} from '@/deck/deck-manager'

// jsdom has no navigator.hid: define a stub with add/removeEventListener so the
// manager can install hotplug listeners.
function stubHid() {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const hid = {
    addEventListener: (t: string, cb: (e: unknown) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(cb)
    },
    removeEventListener: (t: string, cb: (e: unknown) => void) => listeners.get(t)?.delete(cb),
    fire: (t: string) => listeners.get(t)?.forEach((cb) => cb({})),
  }
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true })
  return hid
}

// jsdom has no navigator.locks either: a minimal exclusive-lock stub with FIFO
// handoff and AbortSignal support (per the Web Locks spec, aborting the signal
// of a still-queued request withdraws it and rejects with AbortError), for the
// leader-election tests. The manager treats a missing navigator.locks as
// "immediately leader", so the other tests need no stub.
function stubLocks() {
  let busy = false
  const waiters: Array<{ grant: () => void }> = []
  const locks = {
    async request(name: string, opts: { mode?: string; signal?: AbortSignal }, cb: (lock: unknown) => unknown) {
      const signal = opts?.signal
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (busy) {
        await new Promise<void>((resolve, reject) => {
          const entry = { grant: resolve }
          waiters.push(entry)
          signal?.addEventListener('abort', () => {
            const i = waiters.indexOf(entry)
            if (i >= 0) waiters.splice(i, 1) // withdrawn: handoff skips this waiter
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      busy = true
      try {
        return await cb({ name })
      } finally {
        busy = false
        waiters.shift()?.grant()
      }
    },
  }
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
  return locks
}

// jsdom has no canvas 2D context (test/setup/dom.ts makes getContext() return
// null, and tile-renderer's defaultCtxFactory is runtime-only by design), so
// the manager-created DeckController gets byte-array renderers injected via the
// transports test seam — the same injection pattern deck-controller.test.ts uses.
const stubRenderers = {
  renderKey: () => new Uint8ClampedArray(4),
  renderStrip: () => new Uint8ClampedArray(4),
}

function makeStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      deck: deckReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      turnCompletion: turnCompletionReducer,
      freshAgent: freshAgentReducer,
      codexActivity: codexActivityReducer,
      claudeActivity: claudeActivityReducer,
      amplifierActivity: amplifierActivityReducer,
      antigravityActivity: antigravityActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
      // The real controller's probeRepoIcons() dereferences these slices even
      // with zero tabs; without the reducers every test that reaches start()
      // would die in a swallowed TypeError and never report 'connected'.
      terminalMeta: terminalMetaReducer,
      repoIcons: repoIconsReducer,
    },
  })
}

describe('deck-manager', () => {
  let hid: ReturnType<typeof stubHid>
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    hid = stubHid()
  })

  afterEach(() => {
    uninstall?.()
    uninstall = null
    resetStreamDeckManagerForTests()
    // remove the hid + locks stubs
    Reflect.deleteProperty(navigator as object, 'hid')
    Reflect.deleteProperty(navigator as object, 'locks')
  })

  it('marks unsupported and does nothing when navigator.hid is missing', () => {
    Reflect.deleteProperty(navigator as object, 'hid')
    const store = makeStore()
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted: vi.fn() })
    expect(store.getState().deck.status).toBe('unsupported')
  })

  it('auto-reconnects a previously granted deck when the toggle turns on', async () => {
    const store = makeStore()
    const device = new FakeDeckDevice()
    const getGranted = vi.fn(async () => device)
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted, ...stubRenderers })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
    expect(store.getState().deck).toMatchObject({ model: 'Fake Mini', keyCount: 6 })
    expect(device.brightnessHistory[0]).toBe(100) // controller started
  })

  it('auto-reconnects on install when enabled is already true (page-reload persistence)', async () => {
    // Returning-user path: settings hydrate synchronously from localStorage BEFORE the
    // manager installs, so there is no enabled transition to observe — install itself
    // must evaluate the current value and run the enable path. A transition-only
    // change detector (prev seeded from the current store value) fails this test.
    const store = makeStore()
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    const device = new FakeDeckDevice()
    const getGranted = vi.fn(async () => device)
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted, ...stubRenderers })
    // No further dispatches after install: the connection must come from the install-time check.
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
    expect(getGranted).toHaveBeenCalledTimes(1)
  })

  it('disabling the toggle tears down cleanly', async () => {
    const store = makeStore()
    const device = new FakeDeckDevice()
    const getGranted = vi.fn(async () => device)
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted, ...stubRenderers })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: false } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('disconnected'))
    expect(device.closed).toBe(true)
  })

  it('unplug -> disconnected without errors; replug (hid connect event) -> reconnected', async () => {
    const store = makeStore()
    const devices: FakeDeckDevice[] = []
    const getGranted = vi.fn(async () => {
      const device = new FakeDeckDevice()
      devices.push(device)
      return device
    })
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted, ...stubRenderers })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
    devices[0].disconnect()
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('disconnected'))
    hid.fire('connect')
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
    expect(devices).toHaveLength(2)
  })

  it('open failure held-elsewhere -> in-use, retried on window focus', async () => {
    const store = makeStore()
    const device = new FakeDeckDevice()
    const getGranted = vi.fn()
      .mockRejectedValueOnce(new DeckOpenError('in-use', 'held'))
      .mockResolvedValueOnce(device)
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted, ...stubRenderers })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('in-use'))
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
  })

  it('non-leader window shows in-use while another window holds the leader lock, connects on handoff', async () => {
    const locks = stubLocks()
    // simulate the other freshell window's manager holding the leader lock
    let releaseOther: () => void = () => {}
    void locks.request('freshell-stream-deck', { mode: 'exclusive' }, () => new Promise<void>((r) => { releaseOther = r }))
    const store = makeStore()
    const device = new FakeDeckDevice()
    uninstall = installStreamDeckManager(store as never, {
      request: vi.fn(), getGranted: vi.fn(async () => device), ...stubRenderers,
    })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('in-use'))
    releaseOther() // leader closes/disables -> lock handoff
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('connected'))
  })

  it('disable while waiting for the leader lock withdraws the request; later handoff must NOT connect', async () => {
    // The disable-while-waiting case: without the AbortSignal the queued request
    // would fire on handoff and connect with the toggle OFF. A pending
    // locks.request can only be withdrawn via its signal - resolving leaderGate
    // does not dequeue it.
    const locks = stubLocks()
    let releaseOther: () => void = () => {}
    void locks.request('freshell-stream-deck', { mode: 'exclusive' }, () => new Promise<void>((r) => { releaseOther = r }))
    const store = makeStore()
    const getGranted = vi.fn(async () => new FakeDeckDevice())
    uninstall = installStreamDeckManager(store as never, { request: vi.fn(), getGranted, ...stubRenderers })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('in-use'))
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: false } })) // aborts the queued request
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('disconnected'))
    releaseOther() // previous leader hands off; the withdrawn request must not run
    await new Promise((r) => setTimeout(r, 25))
    expect(store.getState().deck.status).toBe('disconnected')
    expect(getGranted).not.toHaveBeenCalled()
  })

  it('requestDeckConnect adopts the picked device; picker cancel (or Electron []) keeps prior status', async () => {
    const store = makeStore()
    const device = new FakeDeckDevice()
    const request = vi.fn(async () => device)
    const getGranted = vi.fn(async () => null) // nothing granted yet: enable path lands on 'disconnected'
    uninstall = installStreamDeckManager(store as never, { request, getGranted, ...stubRenderers })
    store.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store.getState().deck.status).toBe('disconnected'))
    await requestDeckConnect()
    expect(store.getState().deck.status).toBe('connected')
    expect(store.getState().deck).toMatchObject({ model: 'Fake Mini', keyCount: 6 })

    // then reset; picker cancel (or Electron's handler-less requestDevice() -> [])
    // resolves null -> clean no-op, prior status unchanged
    uninstall()
    uninstall = null
    resetStreamDeckManagerForTests()
    const store2 = makeStore()
    const cancelRequest = vi.fn(async () => null)
    uninstall = installStreamDeckManager(store2 as never, {
      request: cancelRequest, getGranted: vi.fn(async () => null), ...stubRenderers,
    })
    store2.dispatch(updateSettingsLocal({ streamDeck: { enabled: true } }))
    await vi.waitFor(() => expect(store2.getState().deck.status).toBe('disconnected'))
    await requestDeckConnect()
    expect(cancelRequest).toHaveBeenCalledTimes(1)
    expect(store2.getState().deck.status).toBe('disconnected')
  })
})
