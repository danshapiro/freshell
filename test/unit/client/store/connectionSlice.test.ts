import { describe, it, expect, beforeEach, vi } from 'vitest'
import connectionReducer, {
  setStatus,
  setError,
  setPlatform,
  ConnectionState,
  ConnectionStatus,
} from '../../../../src/store/connectionSlice'

describe('connectionSlice', () => {
  describe('initial state', () => {
    it('has correct default values', () => {
      const state = connectionReducer(undefined, { type: 'unknown' })

      expect(state.status).toBe('disconnected')
      expect(state.lastError).toBeUndefined()
      expect(state.lastReadyAt).toBeUndefined()
    })
  })

  describe('setStatus', () => {
    it('updates connection status to connecting', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
      }

      const state = connectionReducer(initialState, setStatus('connecting'))

      expect(state.status).toBe('connecting')
    })

    it('updates connection status to connected', () => {
      const initialState: ConnectionState = {
        status: 'connecting',
      }

      const state = connectionReducer(initialState, setStatus('connected'))

      expect(state.status).toBe('connected')
    })

    it('updates connection status to ready', () => {
      const initialState: ConnectionState = {
        status: 'connected',
      }

      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)

      const state = connectionReducer(initialState, setStatus('ready'))

      expect(state.status).toBe('ready')
      expect(state.lastReadyAt).toBe(now)

      vi.restoreAllMocks()
    })

    it('updates connection status to disconnected', () => {
      const initialState: ConnectionState = {
        status: 'ready',
        lastReadyAt: 1234567890,
      }

      const state = connectionReducer(initialState, setStatus('disconnected'))

      expect(state.status).toBe('disconnected')
      // lastReadyAt should be preserved
      expect(state.lastReadyAt).toBe(1234567890)
    })

    it('sets lastReadyAt only when status is ready', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
      }

      // Test that connecting does not set lastReadyAt
      let state = connectionReducer(initialState, setStatus('connecting'))
      expect(state.lastReadyAt).toBeUndefined()

      // Test that connected does not set lastReadyAt
      state = connectionReducer(state, setStatus('connected'))
      expect(state.lastReadyAt).toBeUndefined()

      // Test that ready sets lastReadyAt
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)
      state = connectionReducer(state, setStatus('ready'))
      expect(state.lastReadyAt).toBe(now)

      vi.restoreAllMocks()
    })

    it('updates lastReadyAt each time status is set to ready', () => {
      const firstTime = 1000000
      const secondTime = 2000000

      vi.spyOn(Date, 'now').mockReturnValue(firstTime)
      let state = connectionReducer(undefined, setStatus('ready'))
      expect(state.lastReadyAt).toBe(firstTime)

      // Disconnect and reconnect
      state = connectionReducer(state, setStatus('disconnected'))
      state = connectionReducer(state, setStatus('connecting'))
      state = connectionReducer(state, setStatus('connected'))

      vi.spyOn(Date, 'now').mockReturnValue(secondTime)
      state = connectionReducer(state, setStatus('ready'))
      expect(state.lastReadyAt).toBe(secondTime)

      vi.restoreAllMocks()
    })
  })

  describe('setError', () => {
    it('stores error message', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
      }

      const state = connectionReducer(initialState, setError('Connection failed'))

      expect(state.lastError).toBe('Connection failed')
    })

    it('replaces existing error message', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
        lastError: 'Previous error',
      }

      const state = connectionReducer(initialState, setError('New error'))

      expect(state.lastError).toBe('New error')
    })

    it('clears error when passed undefined', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
        lastError: 'Some error',
      }

      const state = connectionReducer(initialState, setError(undefined))

      expect(state.lastError).toBeUndefined()
    })

    it('preserves connection status when setting error', () => {
      const initialState: ConnectionState = {
        status: 'connecting',
      }

      const state = connectionReducer(initialState, setError('Connection timeout'))

      expect(state.status).toBe('connecting')
      expect(state.lastError).toBe('Connection timeout')
    })

    it('preserves lastReadyAt when setting error', () => {
      const initialState: ConnectionState = {
        status: 'ready',
        lastReadyAt: 1234567890,
      }

      const state = connectionReducer(initialState, setError('Temporary error'))

      expect(state.lastReadyAt).toBe(1234567890)
      expect(state.lastError).toBe('Temporary error')
    })
  })

  describe('platform state', () => {
    it('has null platform in initial state', () => {
      const state = connectionReducer(undefined, { type: 'unknown' })
      expect(state.platform).toBeNull()
    })

    it('sets platform with setPlatform action', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
        platform: null,
      }
      const state = connectionReducer(initialState, setPlatform('win32'))
      expect(state.platform).toBe('win32')
    })

    it('accepts darwin platform', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
        platform: null,
      }
      const state = connectionReducer(initialState, setPlatform('darwin'))
      expect(state.platform).toBe('darwin')
    })

    it('accepts linux platform', () => {
      const initialState: ConnectionState = {
        status: 'disconnected',
        platform: null,
      }
      const state = connectionReducer(initialState, setPlatform('linux'))
      expect(state.platform).toBe('linux')
    })
  })

  describe('state transitions', () => {
    it('handles typical connection lifecycle', () => {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)

      // Start disconnected
      let state = connectionReducer(undefined, { type: 'unknown' })
      expect(state.status).toBe('disconnected')

      // Begin connecting
      state = connectionReducer(state, setStatus('connecting'))
      expect(state.status).toBe('connecting')

      // Connected
      state = connectionReducer(state, setStatus('connected'))
      expect(state.status).toBe('connected')

      // Ready
      state = connectionReducer(state, setStatus('ready'))
      expect(state.status).toBe('ready')
      expect(state.lastReadyAt).toBe(now)

      // Error occurs
      state = connectionReducer(state, setError('Network error'))
      expect(state.lastError).toBe('Network error')

      // Disconnect
      state = connectionReducer(state, setStatus('disconnected'))
      expect(state.status).toBe('disconnected')
      expect(state.lastError).toBe('Network error') // Error persists
      expect(state.lastReadyAt).toBe(now) // lastReadyAt persists

      // Clear error before reconnect
      state = connectionReducer(state, setError(undefined))
      expect(state.lastError).toBeUndefined()

      vi.restoreAllMocks()
    })
  })
})
