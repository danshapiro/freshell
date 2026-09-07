import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import hostStatsReducer, {
  activateHostStats,
  deactivateHostStats,
  requestHostStatsRefresh,
  resolveHostStatsRefresh,
  failHostStatsRefresh,
  hostStatsPaneMounted,
  hostStatsPaneUnmounted,
  hostStatsSnapshotReceived,
  hostStatsReset,
  _resetHostStatsThunkState,
} from '@/store/hostStatsSlice'
import type { HostStatsLive, HostStatsManual } from '@shared/ws-protocol'

// Repo thunk pattern: the thunks reach the real getWsClient(); the module is
// mocked and the send spy captures frames.
const sendSpy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: sendSpy }),
}))

function makeLive(): HostStatsLive {
  return {
    machine: {
      cores: 8, memTotalBytes: 34_000_000_000, platform: 'linux', wsl: false,
      kernel: '6.6', hostname: 'test', psi: true, cgroup: 'v2',
      thermalCount: 1, batteryPresent: false, gpu: 'none',
    },
    cpu: { available: true, usagePct: 10, stealPct: 0, perCorePct: [10], freqMHz: 3400 },
    load: { available: true, load1: 0.5, load5: 0.6, load15: 0.7, cores: 8 },
    memory: {
      available: true, source: 'host', totalBytes: 10_000, usedBytes: 1_000, availableBytes: 9_000,
      cgroupLimitBytes: null, swapTotalBytes: 0, swapUsedBytes: 0,
    },
    paging: { available: true, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 },
    psi: { available: true, cpuSome10: 0.1, memSome10: 0.2, memFull10: 0, ioSome10: 0.1, ioFull10: 0 },
    diskIo: { available: true, readBps: 0, writeBps: 0, utilPct: 1, weightedAwaitMs: 5 },
    network: {
      available: true, rxBps: 0, txBps: 0,
      rxErrorsTotal: 0, txErrorsTotal: 0, rxDroppedTotal: 0, txDroppedTotal: 0,
      rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0,
    },
    limits: { available: true, fdsUsed: 100, fdsMax: 1_048_576, pidsUsed: 100, pidsMax: 4_194_304, timeWait: 10, ephemeralPorts: 28_232 },
    freshell: {
      available: true, source: 'node', ptysRunning: 1, ptysMax: 50, wsClients: 1, wsClientsMax: 50,
      eventLoopLagP99Ms: 5, rssBytes: 1_000_000, uptimeSec: 60,
    },
  }
}

function makeManual(): HostStatsManual {
  return {
    topProcesses: { available: true, dwellMs: 300, list: [{ pid: 5, name: 'node', cpuPct: 12.3, rssBytes: 1e6, state: 'S' }] },
    processHealth: { available: true, zombies: 0, dState: 0, total: 900 },
    inotify: { available: true, instances: 3, watches: 420, maxUserWatches: 1_048_576, maxUserInstances: 128 },
    disks: { available: true, list: [{ mount: '/', totalBytes: 1e12, freeBytes: 5e11, usedPct: 50, inodesTotal: 1e8, inodesFree: 9e7 }] },
    thermals: { available: true, zones: [{ label: 'cpu', celsius: 51.5 }], battery: null },
    sectionErrors: {},
  }
}

function createStore() {
  return configureStore({ reducer: { hostStats: hostStatsReducer } })
}

type TestStore = ReturnType<typeof createStore>
const st = (store: TestStore) => store.getState().hostStats
const sentFrames = () => sendSpy.mock.calls.map(([frame]) => frame as { type?: string })
const framesOfType = (type: string) => sentFrames().filter((f) => f.type === type)

describe('hostStatsSlice', () => {
  beforeEach(() => {
    sendSpy.mockClear()
  })
  afterEach(() => {
    _resetHostStatsThunkState()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts with no mounted panes, no subscription, no data, idle refresh', () => {
    const store = createStore()
    expect(st(store)).toEqual({
      mountedPanes: 0,
      subscribed: false,
      live: null,
      liveAt: null,
      clockOffsetMs: null,
      manualAt: null,
      manual: null,
      refresh: { inFlight: false, requestId: null, error: null },
    })
  })

  describe('mount refcount thunks', () => {
    it('sends hoststats.subscribe exactly once across two activations (0→1 transition only)', () => {
      const store = createStore()
      store.dispatch(activateHostStats() as any)
      store.dispatch(activateHostStats() as any)
      expect(st(store).mountedPanes).toBe(2)
      expect(st(store).subscribed).toBe(true)
      expect(framesOfType('hoststats.subscribe')).toHaveLength(1)
    })

    it('sends hoststats.unsubscribe only at the 1→0 transition', () => {
      const store = createStore()
      store.dispatch(activateHostStats() as any)
      store.dispatch(activateHostStats() as any)
      store.dispatch(deactivateHostStats() as any)
      expect(st(store).mountedPanes).toBe(1)
      expect(st(store).subscribed).toBe(true)
      expect(framesOfType('hoststats.unsubscribe')).toHaveLength(0)
      store.dispatch(deactivateHostStats() as any)
      expect(st(store).mountedPanes).toBe(0)
      expect(st(store).subscribed).toBe(false)
      expect(framesOfType('hoststats.unsubscribe')).toHaveLength(1)
    })

    it('deactivate at zero is a no-op (no spurious unsubscribe frame)', () => {
      const store = createStore()
      store.dispatch(deactivateHostStats() as any)
      expect(st(store).mountedPanes).toBe(0)
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('raw mounted/unmounted reducers are pure: refcount only, no WS side effects', () => {
      const store = createStore()
      store.dispatch(hostStatsPaneMounted())
      store.dispatch(hostStatsPaneMounted())
      store.dispatch(hostStatsPaneUnmounted())
      expect(st(store).mountedPanes).toBe(1)
      expect(st(store).subscribed).toBe(false)
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('unmounted clamps at zero', () => {
      const store = createStore()
      store.dispatch(hostStatsPaneUnmounted())
      expect(st(store).mountedPanes).toBe(0)
    })
  })

  describe('hostStatsSnapshotReceived', () => {
    it('installs clockOffsetMs = Date.now() - at', () => {
      vi.useFakeTimers({ now: 10_000_000 })
      const store = createStore()
      const live = makeLive()
      store.dispatch(hostStatsSnapshotReceived({ at: 10_000_000 - 5_000, live, manualAt: null, manual: null }))
      expect(st(store).clockOffsetMs).toBe(5_000)
      expect(st(store).live).toEqual(live)
      expect(st(store).liveAt).toBe(10_000_000 - 5_000)
    })

    it('keeps a NEGATIVE offset when the client clock is behind the server (no zero-clamp)', () => {
      vi.useFakeTimers({ now: 10_000_000 })
      const store = createStore()
      store.dispatch(hostStatsSnapshotReceived({ at: 10_000_000 + 3_000, live: makeLive(), manualAt: null, manual: null }))
      expect(st(store).clockOffsetMs).toBe(-3_000)
    })

    it('rejects |offset| > 10min as garbage and keeps the previous offset', () => {
      vi.useFakeTimers({ now: 10_000_000 })
      const store = createStore()
      store.dispatch(hostStatsSnapshotReceived({ at: 10_000_000 - 5_000, live: makeLive(), manualAt: null, manual: null }))
      expect(st(store).clockOffsetMs).toBe(5_000)
      // 700_000ms offset exceeds the 600_000ms guard: previous offset survives.
      store.dispatch(hostStatsSnapshotReceived({ at: 10_000_000 - 700_000, live: makeLive(), manualAt: null, manual: null }))
      expect(st(store).clockOffsetMs).toBe(5_000)
    })

    it('MERGE semantics: a snapshot without manual does NOT clear existing manual/manualAt', () => {
      vi.useFakeTimers({ now: 20_000_000 })
      const store = createStore()
      const manual = makeManual()
      store.dispatch(hostStatsSnapshotReceived({ at: 20_000_000, live: makeLive(), manualAt: 111_000, manual }))
      expect(st(store).manual).toEqual(manual)
      expect(st(store).manualAt).toBe(111_000)

      const live2 = makeLive()
      live2.cpu.usagePct = 55
      store.dispatch(hostStatsSnapshotReceived({ at: 20_002_000, live: live2, manualAt: null, manual: null }))
      expect(st(store).manual).toEqual(manual) // preserved
      expect(st(store).manualAt).toBe(111_000) // preserved
      expect(st(store).live).toEqual(live2)    // live always folds
      expect(st(store).liveAt).toBe(20_002_000)
    })

    it('a snapshot carrying manual replaces manual/manualAt', () => {
      const store = createStore()
      const first = makeManual()
      const second = makeManual()
      second.processHealth.zombies = 7
      store.dispatch(hostStatsSnapshotReceived({ at: 1_000, live: makeLive(), manualAt: 1_000, manual: first }))
      store.dispatch(hostStatsSnapshotReceived({ at: 2_000, live: makeLive(), manualAt: 2_000, manual: second }))
      expect(st(store).manual).toEqual(second)
      expect(st(store).manualAt).toBe(2_000)
    })
  })

  describe('requestHostStatsRefresh thunk', () => {
    it('mints an hsr- requestId, sets inFlight, sends the refresh frame', () => {
      const store = createStore()
      store.dispatch(requestHostStatsRefresh() as any)
      const { refresh } = st(store)
      expect(refresh.inFlight).toBe(true)
      expect(refresh.requestId).toMatch(/^hsr-\d+-[a-z0-9]+$/)
      expect(refresh.error).toBeNull()
      const frames = framesOfType('hoststats.refresh')
      expect(frames).toHaveLength(1)
      expect((frames[0] as { requestId?: string }).requestId).toBe(refresh.requestId)
    })

    it('allows only one in-flight refresh (second call is a no-op)', () => {
      const store = createStore()
      store.dispatch(requestHostStatsRefresh() as any)
      const firstRequestId = st(store).refresh.requestId
      store.dispatch(requestHostStatsRefresh() as any)
      expect(st(store).refresh.requestId).toBe(firstRequestId)
      expect(framesOfType('hoststats.refresh')).toHaveLength(1)
    })

    it('resolve folds the manual payload and clears inFlight', () => {
      const store = createStore()
      store.dispatch(requestHostStatsRefresh() as any)
      const requestId = st(store).refresh.requestId!
      store.dispatch(resolveHostStatsRefresh({ requestId, at: 999_000, manual: makeManual() }) as any)
      expect(st(store).refresh).toEqual({ inFlight: false, requestId: null, error: null })
      expect(st(store).manualAt).toBe(999_000)
      expect(st(store).manual).toEqual(makeManual())
    })

    it('ignores resolve/fail with an unknown requestId without throwing', () => {
      const store = createStore()
      store.dispatch(requestHostStatsRefresh() as any)
      const { refresh } = st(store)
      expect(() => {
        store.dispatch(resolveHostStatsRefresh({ requestId: 'hsr-bogus', at: 1, manual: makeManual() }) as any)
        store.dispatch(failHostStatsRefresh({ requestId: 'hsr-bogus', error: 'nope' }) as any)
      }).not.toThrow()
      expect(st(store).refresh).toEqual(refresh)
      expect(st(store).manual).toBeNull()
    })

    it('fail preserves previous manual/manualAt and records the error', () => {
      const store = createStore()
      const manual = makeManual()
      store.dispatch(hostStatsSnapshotReceived({ at: 50_000, live: makeLive(), manualAt: 42_000, manual }))
      store.dispatch(requestHostStatsRefresh() as any)
      store.dispatch(failHostStatsRefresh({ requestId: st(store).refresh.requestId!, error: 'boom' }) as any)
      expect(st(store).refresh).toEqual({ inFlight: false, requestId: null, error: 'boom' })
      expect(st(store).manual).toEqual(manual)
      expect(st(store).manualAt).toBe(42_000)
      // A fresh attempt clears the stale error.
      store.dispatch(requestHostStatsRefresh() as any)
      expect(st(store).refresh.error).toBeNull()
    })

    it('times out at exactly the 6000ms acceptance deadline with the frozen error text', () => {
      vi.useFakeTimers()
      const store = createStore()
      const manual = makeManual()
      store.dispatch(hostStatsSnapshotReceived({ at: 50_000, live: makeLive(), manualAt: 42_000, manual }))
      store.dispatch(requestHostStatsRefresh() as any)

      vi.advanceTimersByTime(5_999)
      expect(st(store).refresh.inFlight).toBe(true)
      vi.advanceTimersByTime(1)
      expect(st(store).refresh).toEqual({
        inFlight: false,
        requestId: null,
        error: 'refresh timed out — showing previous values',
      })
      expect(st(store).manual).toEqual(manual)
      expect(st(store).manualAt).toBe(42_000)
    })

    it('a resolved refresh disarms the deadline (no late failure)', () => {
      vi.useFakeTimers()
      const store = createStore()
      store.dispatch(requestHostStatsRefresh() as any)
      store.dispatch(resolveHostStatsRefresh({ requestId: st(store).refresh.requestId!, at: 1, manual: makeManual() }) as any)
      vi.advanceTimersByTime(60_000)
      expect(st(store).refresh).toEqual({ inFlight: false, requestId: null, error: null })
      expect(st(store).manualAt).toBe(1)
    })
  })

  describe('hostStatsReset', () => {
    it('keeps last live+manual, clears subscribed, keeps mountedPanes', () => {
      const store = createStore()
      const live = makeLive()
      const manual = makeManual()
      store.dispatch(activateHostStats() as any)
      store.dispatch(hostStatsSnapshotReceived({ at: 50_000, live, manualAt: 42_000, manual }))
      expect(st(store).subscribed).toBe(true)

      store.dispatch(hostStatsReset())
      expect(st(store).subscribed).toBe(false)
      expect(st(store).live).toEqual(live)
      expect(st(store).liveAt).toBe(50_000)
      expect(st(store).manual).toEqual(manual)
      expect(st(store).manualAt).toBe(42_000)
      expect(st(store).mountedPanes).toBe(1)
    })
  })
})
