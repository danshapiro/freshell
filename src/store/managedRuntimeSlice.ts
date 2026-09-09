import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeReadiness,
  ManagedRuntimeSoul,
  ManagedRuntimeViewIntent,
} from '@shared/managed-runtime'

export type ManagedRuntimeClientStatus =
  | 'unavailable'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'

export interface ManagedRuntimeClientState {
  available: boolean
  status: ManagedRuntimeClientStatus
  revision: number
  readiness?: ManagedRuntimeReadiness
  souls: ManagedRuntimeSoul[]
  viewIntents: ManagedRuntimeViewIntent[]
  pendingProjectionCount: number
  lastError?: string
  lastRefreshAt?: number
  lastRefreshReason?: string
  reconstructedViewCount: number
}

const initialState: ManagedRuntimeClientState = {
  available: false,
  status: 'unavailable',
  revision: 0,
  souls: [],
  viewIntents: [],
  pendingProjectionCount: 0,
  reconstructedViewCount: 0,
}

export const managedRuntimeSlice = createSlice({
  name: 'managedRuntime',
  initialState,
  reducers: {
    setManagedRuntimeAvailable: (state, action: PayloadAction<boolean>) => {
      state.available = action.payload
      if (!action.payload) {
        state.status = 'unavailable'
        state.lastError = undefined
      } else if (state.status === 'unavailable') {
        state.status = 'idle'
      }
    },
    managedRuntimeRefreshStarted: (state, action: PayloadAction<string>) => {
      state.available = true
      state.status = 'loading'
      state.lastRefreshReason = action.payload
      state.lastError = undefined
    },
    managedRuntimeSnapshotReceived: (
      state,
      action: PayloadAction<{
        snapshot: ManagedRuntimeInventorySnapshot
        reconstructedViewCount: number
      }>,
    ) => {
      const { snapshot, reconstructedViewCount } = action.payload
      // WebSocket notifications and HTTP fetches may complete out of order.
      // The supervisor revision is authoritative; never fold an older snapshot.
      if (snapshot.revision < state.revision) return
      state.available = true
      state.status = 'ready'
      state.revision = snapshot.revision
      state.readiness = snapshot.readiness
      state.souls = snapshot.souls
      state.viewIntents = snapshot.viewIntents
      state.pendingProjectionCount = snapshot.pendingProjectionCount
      state.reconstructedViewCount = reconstructedViewCount
      state.lastRefreshAt = Date.now()
      state.lastError = undefined
    },
    managedRuntimeRefreshFailed: (state, action: PayloadAction<string>) => {
      state.status = 'error'
      state.lastError = action.payload
      state.lastRefreshAt = Date.now()
    },
    managedRuntimeDisconnected: (state) => {
      if (state.available) state.status = 'idle'
    },
  },
})

export const {
  setManagedRuntimeAvailable,
  managedRuntimeRefreshStarted,
  managedRuntimeSnapshotReceived,
  managedRuntimeRefreshFailed,
  managedRuntimeDisconnected,
} = managedRuntimeSlice.actions

export default managedRuntimeSlice.reducer
