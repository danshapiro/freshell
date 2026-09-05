import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { HostStatsLive, HostStatsManual } from '@shared/ws-protocol'
import { requestHostStatsRefreshWs, subscribeHostStats, unsubscribeHostStats } from '@/lib/host-stats-ws'
import type { AppDispatch, RootState } from './store'

/**
 * Client-side state for the hoststats.* protocol. The connection-level
 * subscription is owned by a client-side mount refcount: N mounted Host Stats
 * panes share a single `hoststats.subscribe`. Reducers are PURE — all WS side
 * effects live in the thunks below, fired exactly on the 0→1 / 1→0 refcount
 * transitions (computed by reading state AFTER the pure dispatch). Components
 * must NEVER dispatch the raw reducers — always the thunks.
 */

export type HostStatsRefreshState = {
  inFlight: boolean
  requestId: string | null
  error: string | null
}

export type HostStatsState = {
  mountedPanes: number
  subscribed: boolean
  live: HostStatsLive | null
  liveAt: number | null
  /**
   * `Date.now() - snapshot.at`, refreshed per snapshot; NEVER zero-clamped —
   * a client behind the server yields a correctly negative offset so
   * `serverNow = Date.now() - clockOffsetMs` stays skew-correct.
   */
  clockOffsetMs: number | null
  manualAt: number | null
  manual: HostStatsManual | null
  refresh: HostStatsRefreshState
}

/** |Date.now() - at| beyond this is treated as unparseable garbage; previous offset kept. */
export const HOST_STATS_CLOCK_OFFSET_REJECT_MS = 10 * 60 * 1000

/** Client-side acceptance deadline for one refresh round trip. */
export const HOST_STATS_REFRESH_TIMEOUT_MS = 6_000

export const HOST_STATS_REFRESH_TIMEOUT_ERROR = 'refresh timed out — showing previous values'

function createInitialState(): HostStatsState {
  return {
    mountedPanes: 0,
    subscribed: false,
    live: null,
    liveAt: null,
    clockOffsetMs: null,
    manualAt: null,
    manual: null,
    refresh: { inFlight: false, requestId: null, error: null },
  }
}

const initialState = createInitialState()

type HostStatsSnapshotPayload = {
  at: number
  live: HostStatsLive
  manualAt: number | null
  manual: HostStatsManual | null
}

const hostStatsSlice = createSlice({
  name: 'hostStats',
  initialState,
  reducers: {
    /** PURE refcount mutation — the WS side effect belongs to the thunk. */
    hostStatsPaneMounted(state) {
      state.mountedPanes += 1
    },
    /** PURE refcount mutation — the WS side effect belongs to the thunk. */
    hostStatsPaneUnmounted(state) {
      state.mountedPanes = Math.max(0, state.mountedPanes - 1)
    },
    /** The ONLY writer of `subscribed`. */
    hostStatsSubscribedSet(state, action: PayloadAction<boolean>) {
      state.subscribed = action.payload
    },
    hostStatsSnapshotReceived(state, action: PayloadAction<HostStatsSnapshotPayload>) {
      const { at, live, manualAt, manual } = action.payload
      state.live = live
      state.liveAt = at
      const offset = Date.now() - at
      if (Math.abs(offset) <= HOST_STATS_CLOCK_OFFSET_REJECT_MS) {
        state.clockOffsetMs = offset
      }
      // MERGE: a snapshot without manual MUST NOT clear existing manual/manualAt.
      if (manualAt !== null) {
        state.manualAt = manualAt
        state.manual = manual
      }
    },
    hostStatsRefreshStarted(state, action: PayloadAction<{ requestId: string }>) {
      state.refresh = { inFlight: true, requestId: action.payload.requestId, error: null }
    },
    hostStatsRefreshResolved(state, action: PayloadAction<{ at: number; manual: HostStatsManual }>) {
      state.manual = action.payload.manual
      state.manualAt = action.payload.at
      state.refresh = { inFlight: false, requestId: null, error: null }
    },
    hostStatsRefreshFailed(state, action: PayloadAction<{ error: string }>) {
      // Previous values AND the original manualAt are preserved; only the
      // refresh slot clears and records the error text.
      state.refresh = { inFlight: false, requestId: null, error: action.payload.error }
    },
    hostStatsReset(state) {
      // On ws disconnect/'ready': the subscription died with the old socket,
      // but the last live/manual values are still the freshest known — keep them.
      state.subscribed = false
    },
  },
})

export const {
  hostStatsPaneMounted,
  hostStatsPaneUnmounted,
  hostStatsSubscribedSet,
  hostStatsSnapshotReceived,
  hostStatsRefreshStarted,
  hostStatsRefreshResolved,
  hostStatsRefreshFailed,
  hostStatsReset,
} = hostStatsSlice.actions

export default hostStatsSlice.reducer

// ── Thunks (WS side effects live here only) ─────────────────────────────

// requestId → acceptance-deadline timer. Module-level (not store state): the
// WS client is a process singleton shared by every store view, and timers are
// not persisted/serializable state. Tests drain it via _resetHostStatsThunkState.
const refreshDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearRefreshDeadline(requestId: string): void {
  const timer = refreshDeadlineTimers.get(requestId)
  if (timer !== undefined) {
    clearTimeout(timer)
    refreshDeadlineTimers.delete(requestId)
  }
}

export function _resetHostStatsThunkState(): void {
  for (const requestId of [...refreshDeadlineTimers.keys()]) {
    clearRefreshDeadline(requestId)
  }
}

/** Mount-side thunk: refcount++, send subscribe iff this is the 0→1 transition. */
export function activateHostStats() {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    dispatch(hostStatsPaneMounted())
    if (getState().hostStats.mountedPanes === 1) {
      subscribeHostStats()
      dispatch(hostStatsSubscribedSet(true))
    }
  }
}

/** Unmount-side thunk: refcount--, send unsubscribe iff this is the 1→0 transition. */
export function deactivateHostStats() {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    if (getState().hostStats.mountedPanes === 0) return
    dispatch(hostStatsPaneUnmounted())
    if (getState().hostStats.mountedPanes === 0) {
      unsubscribeHostStats()
      dispatch(hostStatsSubscribedSet(false))
    }
  }
}

/**
 * Mint `hsr-<epoch>-<rand>`, mark inFlight, send the refresh frame, and arm the
 * 6000ms acceptance deadline → hostStatsRefreshFailed(timeout) on expiry.
 * One in-flight refresh per client; a second call while inFlight is a no-op.
 */
export function requestHostStatsRefresh() {
  return (dispatch: AppDispatch, getState: () => RootState): string | null => {
    if (getState().hostStats.refresh.inFlight) return null
    const requestId = `hsr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    dispatch(hostStatsRefreshStarted({ requestId }))
    requestHostStatsRefreshWs(requestId)
    const timer = setTimeout(() => {
      refreshDeadlineTimers.delete(requestId)
      dispatch(failHostStatsRefresh({ requestId, error: HOST_STATS_REFRESH_TIMEOUT_ERROR }))
    }, HOST_STATS_REFRESH_TIMEOUT_MS)
    refreshDeadlineTimers.set(requestId, timer)
    return requestId
  }
}

/**
 * Fold an ok refresh response. Ref-map semantics keyed by requestId: a frame
 * whose id is not the current in-flight request is ignored without throwing.
 */
export function resolveHostStatsRefresh(payload: { requestId: string; at: number; manual: HostStatsManual }) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    // `hostStats?.` mirrors the state.freshAgent?.sessions precedent: App-level
    // folds dispatch these thunks against deliberately partial stores in tests.
    const refresh = getState().hostStats?.refresh
    if (!refresh?.inFlight || refresh.requestId !== payload.requestId) return
    clearRefreshDeadline(payload.requestId)
    dispatch(hostStatsRefreshResolved({ at: payload.at, manual: payload.manual }))
  }
}

/** Fold a failed refresh response (or the client-side acceptance deadline). */
export function failHostStatsRefresh(payload: { requestId: string; error: string }) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const refresh = getState().hostStats?.refresh
    if (!refresh?.inFlight || refresh.requestId !== payload.requestId) return
    clearRefreshDeadline(payload.requestId)
    dispatch(hostStatsRefreshFailed({ error: payload.error }))
  }
}
