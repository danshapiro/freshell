import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import connectionReducer, { setServerInstanceId } from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { resetEnsureExtensionsRegistryCacheForTests, useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}))

const authMocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(() => 'token-test'),
}))

vi.mock('@/lib/api', () => ({
  api: apiMocks,
}))

vi.mock('@/lib/auth', () => authMocks)

vi.mock('@/lib/client-logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}))

function createDeferred<T>() {
  let resolve: ((value: T) => void) | null = null
  let reject: ((reason?: unknown) => void) | null = null
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return {
    promise,
    reject: (reason?: unknown) => reject?.(reason),
    resolve: (value: T) => resolve?.(value),
  }
}

function createStore(serverInstanceId = 'server-a') {
  return configureStore({
    reducer: {
      connection: connectionReducer,
      extensions: extensionsReducer,
    },
    preloadedState: {
      connection: {
        status: 'ready' as const,
        platform: null,
        availableClis: {},
        featureFlags: {},
        serverInstanceId,
      },
      extensions: {
        entries: [],
      },
    },
  })
}

function createWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

describe('useEnsureExtensionsRegistry', () => {
  beforeEach(() => {
    apiMocks.get.mockReset()
    authMocks.getAuthToken.mockReset()
    authMocks.getAuthToken.mockReturnValue('token-test')
    resetEnsureExtensionsRegistryCacheForTests()
  })

  afterEach(() => {
    cleanup()
    resetEnsureExtensionsRegistryCacheForTests()
  })

  it('deduplicates concurrent registry loads across multiple consumers', async () => {
    const deferred = createDeferred<Array<{ name: string; version: string; label: string; description: string; category: 'cli' }>>()
    apiMocks.get.mockReturnValue(deferred.promise)
    const store = createStore()
    const wrapper = createWrapper(store)

    const first = renderHook(() => useEnsureExtensionsRegistry(), { wrapper })
    const second = renderHook(() => useEnsureExtensionsRegistry(), { wrapper })

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledTimes(1)
      expect(first.result.current).toBe(false)
      expect(second.result.current).toBe(false)
    })

    deferred.resolve([{
      name: 'opencode',
      version: '1.0.0',
      label: 'OpenCode',
      description: 'OpenCode CLI agent',
      category: 'cli',
    }])

    await waitFor(() => {
      expect(first.result.current).toBe(true)
      expect(second.result.current).toBe(true)
      expect(store.getState().extensions.entries).toHaveLength(1)
    })
  })

  it('starts a fresh load after the server instance changes during an in-flight request', async () => {
    const deferred = createDeferred<Array<{ name: string; version: string; label: string; description: string; category: 'cli' }>>()
    apiMocks.get
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce([{
        name: 'opencode',
        version: '1.0.0',
        label: 'OpenCode',
        description: 'OpenCode CLI agent',
        category: 'cli',
      }])
    const store = createStore('server-a')
    const wrapper = createWrapper(store)

    const { result } = renderHook(() => useEnsureExtensionsRegistry(), { wrapper })

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledTimes(1)
      expect(result.current).toBe(false)
    })

    act(() => {
      store.dispatch(setServerInstanceId('server-b'))
    })

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledTimes(2)
      expect(result.current).toBe(true)
      expect(store.getState().extensions.entries).toHaveLength(1)
    })

    deferred.resolve([])
  })
})
