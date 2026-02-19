import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit'
import { api } from '@/lib/api'

export interface NetworkStatusResponse {
  configured: boolean
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  lanIps: string[]
  machineHostname: string
  rebindScheduled?: boolean
  firewall: {
    platform: string
    active: boolean
    portOpen: boolean | null
    commands: string[]
    configuring: boolean
  }
  rebinding: boolean
  devMode: boolean
  devPort?: number
  accessUrl: string
}

export interface NetworkState {
  status: NetworkStatusResponse | null
  loading: boolean
  configuring: boolean
  error: string | null
}

const initialState: NetworkState = {
  status: null,
  loading: false,
  configuring: false,
  error: null,
}

export const fetchNetworkStatus = createAsyncThunk(
  'network/fetchStatus',
  async () => {
    return api.get<NetworkStatusResponse>('/api/network/status')
  },
)

/**
 * configureNetwork resolves with the DESIRED state (the server's preview
 * response), NOT the post-rebind settled state. The actual rebind fires
 * asynchronously after the HTTP response flushes.
 *
 * If rebindScheduled is true, starts background polling that updates
 * networkSlice.status via fetchNetworkStatus() dispatches. Watch
 * networkStatus.rebinding for completion (true → false).
 */
let activePollingAbort: AbortController | null = null

export const configureNetwork = createAsyncThunk(
  'network/configure',
  async (config: { host: string; configured: boolean }, { dispatch }) => {
    const response = await api.post<NetworkStatusResponse>('/api/network/configure', config)
    if (response.rebindScheduled) {
      if (activePollingAbort) activePollingAbort.abort()
      const abortController = new AbortController()
      activePollingAbort = abortController
      let attempts = 0
      const maxAttempts = 10
      const poll = async () => {
        if (abortController.signal.aborted) return
        attempts++
        try {
          const result = await dispatch(fetchNetworkStatus()).unwrap()
          if (abortController.signal.aborted) return
          if (!result.rebinding) return
          if (attempts >= maxAttempts) {
            console.warn(`Network rebind polling timed out after ${maxAttempts} attempts`)
            return
          }
          setTimeout(poll, 1000)
        } catch {
          if (abortController.signal.aborted) return
          if (attempts >= maxAttempts) {
            console.warn(`Network rebind polling exhausted after ${maxAttempts} failed attempts`)
            dispatch(fetchNetworkStatus())
            return
          }
          setTimeout(poll, 1000)
        }
      }
      setTimeout(poll, 1000)
    }
    return response
  },
)

const networkSlice = createSlice({
  name: 'network',
  initialState,
  reducers: {
    setNetworkStatus(state, action: PayloadAction<NetworkStatusResponse>) {
      state.status = action.payload
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNetworkStatus.pending, (state) => {
        state.loading = true
        state.error = null
      })
      .addCase(fetchNetworkStatus.fulfilled, (state, action) => {
        state.loading = false
        state.status = action.payload
      })
      .addCase(fetchNetworkStatus.rejected, (state, action) => {
        state.loading = false
        state.error = action.error.message ?? 'Failed to fetch network status'
      })
      .addCase(configureNetwork.pending, (state) => {
        state.configuring = true
        state.error = null
      })
      .addCase(configureNetwork.fulfilled, (state, action) => {
        state.configuring = false
        if (action.payload.rebindScheduled) {
          state.status = { ...action.payload, rebinding: true }
        } else {
          state.status = action.payload
        }
      })
      .addCase(configureNetwork.rejected, (state, action) => {
        state.configuring = false
        state.error = action.error.message ?? 'Failed to configure network'
      })
  },
})

export const { setNetworkStatus } = networkSlice.actions
export const networkReducer = networkSlice.reducer
