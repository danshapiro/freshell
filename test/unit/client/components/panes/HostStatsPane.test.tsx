import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import hostStatsReducer, {
  failHostStatsRefresh,
  hostStatsSnapshotReceived,
  requestHostStatsRefresh,
  resolveHostStatsRefresh,
  _resetHostStatsThunkState,
} from '@/store/hostStatsSlice'
import type { HostStatsLive, HostStatsManual } from '@shared/ws-protocol'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import PaneIcon from '@/components/icons/PaneIcon'
import HostStatsPane from '@/components/panes/HostStatsPane'

// Repo thunk pattern (hostStatsSlice.test.ts): the thunks reach the real
// '@/lib/host-stats-ws' module, which reaches the mocked ws-client.
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
    cpu: { available: true, usagePct: 10, stealPct: 0, perCorePct: [10, 20, 30, 40], freqMHz: 3400 },
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
    limits: { available: true, fdsUsed: 321, fdsMax: 0, pidsUsed: 100, pidsMax: 4_194_304, timeWait: 10, ephemeralPorts: 28_232 },
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

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      hostStats: hostStatsReducer,
    },
  })

type TestStore = ReturnType<typeof createMockStore>

function renderHostStatsPane(store: TestStore = createMockStore()) {
  return {
    store,
    ...render(
      <Provider store={store}>
        <HostStatsPane tabId="tab-1" paneId="pane-1" />
      </Provider>,
    ),
  }
}

function seedLive(store: TestStore, live: HostStatsLive, at: number = 50_000) {
  store.dispatch(hostStatsSnapshotReceived({ at, live, manualAt: null, manual: null }))
}

function seedLiveAndManual(store: TestStore, live: HostStatsLive, manual: HostStatsManual, at: number) {
  store.dispatch(hostStatsSnapshotReceived({ at, live, manualAt: at, manual }))
}

const verdictStrip = () => screen.getByText((_content, el) =>
  el?.getAttribute('role') === 'status' && !el.classList.contains('sr-only'))
const onRequestGroup = () =>
  screen.getByText('ON REQUEST').closest('[data-host-stats-on-request]') as HTMLElement
const ageLabel = () => onRequestGroup().querySelector('[data-host-stats-age]') as HTMLElement
const tileValue = (tileId: string) =>
  document.querySelector(`[data-host-stats-tile="${tileId}"] [data-host-stats-value]`) as HTMLElement

describe('HostStatsPane', () => {
  beforeEach(() => {
    sendSpy.mockClear()
  })

  afterEach(() => {
    cleanup()
    _resetHostStatsThunkState()
    vi.useRealTimers()
  })

  describe('(a) mount subscription lifecycle', () => {
    it('sends exactly one hoststats.subscribe on mount and one hoststats.unsubscribe on unmount', () => {
      const { unmount } = renderHostStatsPane()
      const sendsAfterMount = sendSpy.mock.calls.map(([frame]) => frame)
      expect(sendsAfterMount).toEqual([{ type: 'hoststats.subscribe' }])

      unmount()
      const sendsAfterUnmount = sendSpy.mock.calls.map(([frame]) => frame)
      expect(sendsAfterUnmount).toEqual([
        { type: 'hoststats.subscribe' },
        { type: 'hoststats.unsubscribe' },
      ])
    })

    it('a second mounted pane does not re-subscribe (client-side mount refcount)', () => {
      const store = createMockStore()
      const first = render(
        <Provider store={store}>
          <HostStatsPane tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      const second = render(
        <Provider store={store}>
          <HostStatsPane tabId="tab-1" paneId="pane-2" />
        </Provider>,
      )
      expect(sendSpy.mock.calls.map(([frame]) => frame)).toEqual([
        { type: 'hoststats.subscribe' },
      ])
      first.unmount()
      expect(sendSpy.mock.calls.map(([frame]) => frame)).toHaveLength(1)
      second.unmount()
      expect(sendSpy.mock.calls.map(([frame]) => frame)).toEqual([
        { type: 'hoststats.subscribe' },
        { type: 'hoststats.unsubscribe' },
      ])
    })
  })

  describe('(b) verdict strip + tile words from seeded live state', () => {
    it('composes ELEVATED with offender names joined (BUSY tile at cpu 85%)', () => {
      const store = createMockStore()
      const live = makeLive()
      live.cpu.usagePct = 85
      seedLive(store, live)
      renderHostStatsPane(store)

      expect(verdictStrip()).toHaveTextContent('ELEVATED — CPU BUSY')
      expect(verdictStrip().className).toContain('bg-warning/15')
      const cpuTile = document.querySelector('[data-host-stats-tile="cpu"]') as HTMLElement
      expect(cpuTile.querySelector('[data-host-stats-value]')).toHaveTextContent('85.0%')
      // The tile pill carries the same display word the strip names.
      expect(cpuTile).toHaveTextContent('BUSY')
    })

    it('composes the ok verdict with the deliberate "nothing needs attention" suffix', () => {
      const store = createMockStore()
      seedLive(store, makeLive())
      renderHostStatsPane(store)

      expect(verdictStrip()).toHaveTextContent('ALL GOOD — nothing needs attention')
      expect(verdictStrip().className).toContain('bg-success/15')
    })

    it('composes TROUBLE with bad offenders first', () => {
      const store = createMockStore()
      const live = makeLive()
      live.cpu.usagePct = 99 // maxed (bad)
      live.memory.usedBytes = 9_000 // 90% of 10_000 → tight (warn)
      seedLive(store, live)
      renderHostStatsPane(store)

      expect(verdictStrip()).toHaveTextContent('TROUBLE — CPU MAXED · MEMORY TIGHT')
      expect(verdictStrip().className).toContain('bg-destructive/10')
    })

    it('a *Max === 0 (no-cap convention) renders as —, never a zero', () => {
      const store = createMockStore()
      seedLive(store, makeLive()) // makeLive has fdsMax: 0
      renderHostStatsPane(store)

      const limitsTile = document.querySelector('[data-host-stats-tile="limits"]') as HTMLElement
      expect(limitsTile).toHaveTextContent('fds')
      expect(limitsTile.textContent).toContain('—')
      // fdsUsed is 321 in the fixture; a rendered cap would show it — the — must not.
      expect(limitsTile.textContent).not.toContain('321')
    })
  })

  describe('(c) manualAt === null → neutral on-request group', () => {
    it('renders the on-request group at saturate(0) with an empty age label', () => {
      renderHostStatsPane()

      expect(onRequestGroup().style.filter).toBe('saturate(0)')
      expect(ageLabel()).toHaveTextContent('')
    })

    it('pre-first-snapshot frame: strip and tile values are neutral placeholders, never bright green ALL GOOD', () => {
      renderHostStatsPane()

      // No live snapshot yet — the strip must NOT claim ALL GOOD (nit: zeros
      // would lie); it renders a neutral grey '—' instead.
      expect(verdictStrip()).toHaveTextContent('—')
      expect(verdictStrip().textContent).not.toContain('ALL GOOD')
      expect(verdictStrip().className).toContain('bg-muted')
      expect(tileValue('cpu')).toHaveTextContent('—')
      expect(tileValue('disks')).toHaveTextContent('—')
    })
  })

  describe('(d) desaturation ramp against server-now', () => {
    it('fresh manual renders saturate(1); after 60s the group moves toward grey', () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const store = createMockStore()
      seedLiveAndManual(store, makeLive(), makeManual(), 1_000_000)
      renderHostStatsPane(store)

      expect(onRequestGroup().style.filter).toBe('saturate(1)')
      expect(ageLabel()).toHaveTextContent('just now')

      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      // 60s old: 1 - (60_000-30_000)/270_000 = 0.888… (past the full-color floor,
      // not yet grey) — recomputed by the pane-local 1s interval.
      const match = onRequestGroup().style.filter.match(/^saturate\(([\d.]+)\)$/)
      expect(match).not.toBeNull()
      const sat = Number(match![1])
      expect(sat).toBeGreaterThan(0.8)
      expect(sat).toBeLessThan(1)
      expect(sat).toBeCloseTo(1 - 30_000 / 270_000, 5)
      expect(ageLabel()).toHaveTextContent('updated 1m 0s ago')
    })

    it('a manual older than 5 minutes renders fully grey (saturate(0))', () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const store = createMockStore()
      // A fresh snapshot (at=now) can carry an older manual (on-request
      // measurements age independently of the live cadence).
      store.dispatch(hostStatsSnapshotReceived({
        at: 1_000_000,
        live: makeLive(),
        manualAt: 1_000_000 - 301_000,
        manual: makeManual(),
      }))
      renderHostStatsPane(store)

      expect(onRequestGroup().style.filter).toBe('saturate(0)')
      expect(ageLabel()).toHaveTextContent('updated 5m 1s ago')
    })
  })

  describe('(e) refresh interaction', () => {
    it('click sends hoststats.refresh with an hsr- requestId and shows the Collecting state', () => {
      const store = createMockStore()
      seedLiveAndManual(store, makeLive(), makeManual(), 42_000)
      renderHostStatsPane(store)

      const button = screen.getByRole('button', { name: 'Refresh on-request measurements' })
      fireEvent.click(button)

      const refreshFrames = sendSpy.mock.calls
        .map(([frame]) => frame as { type?: string; requestId?: string })
        .filter((frame) => frame.type === 'hoststats.refresh')
      expect(refreshFrames).toHaveLength(1)
      expect(refreshFrames[0].requestId).toMatch(/^hsr-\d+-[a-z0-9]+$/)
      expect(button).toBeDisabled()
      expect(button).toHaveTextContent('Collecting…')
    })

    it('failure shows role=alert and preserves the old manual values + age (no visual blanking)', () => {
      const store = createMockStore()
      seedLiveAndManual(store, makeLive(), makeManual(), 42_000)
      renderHostStatsPane(store)

      fireEvent.click(screen.getByRole('button', { name: 'Refresh on-request measurements' }))
      const requestId = store.getState().hostStats.refresh.requestId!
      act(() => {
        store.dispatch(failHostStatsRefresh({ requestId, error: 'server exploded' }) as any)
      })

      expect(screen.getByRole('alert')).toHaveTextContent('server exploded')
      expect(screen.getByRole('button', { name: 'Refresh on-request measurements' })).toBeEnabled()
      // Old values AND the original manualAt stay rendered (slice guarantee, visually pinned).
      expect(document.querySelector('[data-host-stats-tile="top-processes"]')).toHaveTextContent('node')
      expect(ageLabel().textContent).toMatch(/updated .*ago|just now/)
    })

    it('resolution announces "Measurements refreshed" once via a sr-only role=status, cleared on the next tick', () => {
      vi.useFakeTimers({ now: 1_000_000 })
      const store = createMockStore()
      seedLive(store, makeLive(), 1_000_000)
      renderHostStatsPane(store)

      act(() => {
        store.dispatch(requestHostStatsRefresh() as any)
      })
      const requestId = store.getState().hostStats.refresh.requestId!
      act(() => {
        store.dispatch(resolveHostStatsRefresh({ requestId, at: 1_000_000, manual: makeManual() }) as any)
      })

      const announcer = () => screen.getAllByRole('status').find((el) => el.classList.contains('sr-only'))
      expect(announcer()).toHaveTextContent('Measurements refreshed')

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(announcer()).toHaveTextContent('')
    })
  })

  describe('(f) title + icon helpers', () => {
    it('derivePaneTitle returns Host Stats for host-stats content', () => {
      expect(derivePaneTitle({ kind: 'host-stats' })).toBe('Host Stats')
    })

    it('PaneIcon renders the Gauge icon for host-stats content', () => {
      const { container } = render(<PaneIcon content={{ kind: 'host-stats' }} />)
      const svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg!.getAttribute('class')).toContain('lucide-gauge')
    })
  })
})
