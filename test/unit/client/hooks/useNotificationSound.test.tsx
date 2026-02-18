import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { useNotificationSound } from '@/hooks/useNotificationSound'
import type { ReactNode } from 'react'

function createStore(soundEnabled: boolean) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
    },
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          notifications: { soundEnabled },
        },
        loaded: true,
      },
    },
  })
}

function createWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

describe('useNotificationSound', () => {
  let AudioSpy: ReturnType<typeof vi.fn>
  let mockAudioInstance: { preload: string; volume: number; pause: () => void; play: () => Promise<void>; currentTime: number; src: string }

  beforeEach(() => {
    mockAudioInstance = {
      preload: '',
      volume: 1,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      currentTime: 0,
      src: '',
    }
    AudioSpy = vi.fn(() => mockAudioInstance)
    vi.stubGlobal('Audio', AudioSpy)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('plays sound when soundEnabled is true', () => {
    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalledWith('/your-code-is-ready.mp3')
    expect(mockAudioInstance.play).toHaveBeenCalled()
  })

  it('does not play sound when soundEnabled is false', () => {
    const store = createStore(false)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })

    expect(AudioSpy).not.toHaveBeenCalled()
    expect(mockAudioInstance.play).not.toHaveBeenCalled()
  })

  it('defaults to enabled when notifications config is missing', () => {
    const store = configureStore({
      reducer: {
        settings: settingsReducer,
      },
      preloadedState: {
        settings: {
          settings: {
            ...defaultSettings,
            // Simulate old config without notifications key
            notifications: undefined as unknown as typeof defaultSettings.notifications,
          },
          loaded: true,
        },
      },
    })

    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalled()
    expect(mockAudioInstance.play).toHaveBeenCalled()
  })

  it('reuses the same Audio element on repeated plays', () => {
    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
    })
    act(() => {
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(1)
    expect(mockAudioInstance.play).toHaveBeenCalledTimes(2)
    expect(mockAudioInstance.pause).toHaveBeenCalledTimes(2) // pause called each time to reset
  })
})
