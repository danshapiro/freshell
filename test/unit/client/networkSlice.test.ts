import { describe, it, expect } from 'vitest'
import { networkReducer, setNetworkStatus, type NetworkState } from '@/store/networkSlice'

describe('networkSlice', () => {
  it('has correct initial state', () => {
    const state = networkReducer(undefined, { type: '@@INIT' })
    expect(state.status).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.configuring).toBe(false)
    expect(state.error).toBeNull()
  })

  it('sets network status', () => {
    const mockStatus = {
      configured: true,
      host: '0.0.0.0' as const,
      port: 3001,
      lanIps: ['192.168.1.100'],
      machineHostname: 'my-laptop',
      firewall: { platform: 'linux-none' as const, active: false, portOpen: null, commands: [], configuring: false },
      rebinding: false,
      devMode: false,
      accessUrl: 'http://192.168.1.100:3001/?token=abc',
    }
    const state = networkReducer(undefined, setNetworkStatus(mockStatus))
    expect(state.status).toEqual(mockStatus)
  })

  it('clears error when setting status', () => {
    const errorState: NetworkState = {
      status: null,
      loading: false,
      configuring: false,
      error: 'previous error',
    }
    const mockStatus = {
      configured: false,
      host: '127.0.0.1' as const,
      port: 3001,
      lanIps: [],
      machineHostname: 'host',
      firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
      rebinding: false,
      devMode: false,
      accessUrl: 'http://localhost:3001/',
    }
    const state = networkReducer(errorState, setNetworkStatus(mockStatus))
    expect(state.status).toEqual(mockStatus)
    // error field is not cleared by setNetworkStatus — only by fetch/configure pending
    expect(state.error).toBe('previous error')
  })
})
