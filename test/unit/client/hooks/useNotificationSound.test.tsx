import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { RING_WATCHDOG_MS, useNotificationSound } from '@/hooks/useNotificationSound'
import type { ReactNode } from 'react'

const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/lib/client-logger', () => ({
  createLogger: () => logMocks,
}))

function watchdogWarnings() {
  return logMocks.warn.mock.calls.filter(
    ([entry]) => (entry as { event?: string } | undefined)?.event === 'notification_ring_watchdog_fired',
  )
}

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

type FakeAudio = {
  preload: string
  volume: number
  src: string
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  addEventListener: (type: string, cb: () => void) => void
  emit: (type: string) => void
}

describe('useNotificationSound', () => {
  let AudioSpy: ReturnType<typeof vi.fn>
  let audioInstances: FakeAudio[]
  let playImpl: () => Promise<void>

  beforeEach(() => {
    logMocks.warn.mockClear()
    audioInstances = []
    playImpl = () => Promise.resolve()
    AudioSpy = vi.fn(function () {
      const listeners = new Map<string, Array<() => void>>()
      const instance: FakeAudio = {
        preload: '',
        volume: 1,
        src: '',
        play: vi.fn(() => playImpl()),
        pause: vi.fn(),
        addEventListener: (type, cb) => {
          const list = listeners.get(type) ?? []
          list.push(cb)
          listeners.set(type, list)
        },
        emit: (type) => {
          for (const cb of [...(listeners.get(type) ?? [])]) cb()
        },
      }
      audioInstances.push(instance)
      return instance
    })
    vi.stubGlobal('Audio', AudioSpy)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
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
    expect(audioInstances[0].play).toHaveBeenCalled()
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
    expect(audioInstances).toHaveLength(0)
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
    expect(audioInstances[0].play).toHaveBeenCalled()
  })

  it('queues rings serially: the second ring starts only after the first completes', () => {
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

    // Ring 1 started immediately; ring 2 is queued and has NOT started yet.
    expect(AudioSpy).toHaveBeenCalledTimes(1)
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1)

    // Ring 1 completes (chime `ended`) → ring 2 starts on a FRESH Audio instance.
    act(() => {
      audioInstances[0].emit('ended')
    })

    expect(AudioSpy).toHaveBeenCalledTimes(2)
    expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
  })

  it('never drops rings: a third play while two are queued still yields three sequential rings', () => {
    const store = createStore(true)
    const { result } = renderHook(() => useNotificationSound(), {
      wrapper: createWrapper(store),
    })

    act(() => {
      result.current.play()
      result.current.play()
      result.current.play()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(1)

    act(() => {
      audioInstances[0].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(2)

    act(() => {
      audioInstances[1].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(3)

    // Queue drained: completing the last ring starts nothing further.
    act(() => {
      audioInstances[2].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(3)

    // Three distinct sequential rings, each played exactly once.
    expect(audioInstances).toHaveLength(3)
    for (const instance of audioInstances) {
      expect(instance.play).toHaveBeenCalledTimes(1)
    }
  })

  it('advances the queue when the chime cannot play: the fallback tone\'s completion starts the next ring', async () => {
    const toneEndedCallbacks: Array<() => void> = []
    class FakeOscillator {
      type = 'sine'
      frequency = { value: 0 }
      connect = vi.fn()
      start = vi.fn()
      stop = vi.fn()
      addEventListener = (type: string, cb: () => void) => {
        if (type === 'ended') toneEndedCallbacks.push(cb)
      }
    }
    class FakeAudioContext {
      currentTime = 0
      destination = {}
      close = vi.fn().mockResolvedValue(undefined)
      createOscillator = () => new FakeOscillator()
      createGain = () => ({ gain: {}, connect: vi.fn() })
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    // The chime file cannot play — a rejected Audio.play() never fires `ended`.
    playImpl = () => Promise.reject(new Error('chime file failed to load'))

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

    // Let the rejected play() settle so the fallback tone is armed.
    await act(async () => {
      await Promise.resolve()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(1)
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1)
    expect(toneEndedCallbacks).toHaveLength(1)

    // The fallback tone completes → ring 2 starts. The queue never stalls.
    act(() => {
      for (const cb of [...toneEndedCallbacks]) cb()
    })

    expect(AudioSpy).toHaveBeenCalledTimes(2)
    expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
  })

  it('advances the queue when the fallback AudioContext is autoplay-suspended: a dead ring never wedges later honest rings', async () => {
    const toneEndedCallbacks: Array<() => void> = []
    const suspendedContexts: Array<{ resume: ReturnType<typeof vi.fn> }> = []
    class FakeOscillator {
      type = 'sine'
      frequency = { value: 0 }
      connect = vi.fn()
      start = vi.fn()
      stop = vi.fn()
      addEventListener = (type: string, cb: () => void) => {
        if (type === 'ended') toneEndedCallbacks.push(cb)
      }
    }
    class FakeSuspendedAudioContext {
      // Autoplay policy: a context created without user activation starts
      // suspended, and resume() outside a user gesture stays suspended
      // (Firefox/Safari never auto-resume) — a suspended context's clock
      // never advances, so a tone's `ended` can NEVER fire.
      state = 'suspended'
      currentTime = 0
      destination = {}
      close = vi.fn().mockResolvedValue(undefined)
      resume = vi.fn(() => Promise.resolve())
      createOscillator = () => new FakeOscillator()
      createGain = () => ({ gain: {}, connect: vi.fn() })
      constructor() {
        suspendedContexts.push(this)
      }
    }
    vi.stubGlobal('AudioContext', FakeSuspendedAudioContext)

    // The chime file cannot play AND the fallback context is suspended —
    // no completion signal can ever fire for this ring.
    playImpl = () => Promise.reject(new Error('chime file failed to load'))

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

    // Let the rejected play() settle so the fallback is armed on ring 1.
    await act(async () => {
      await Promise.resolve()
    })

    // Ring 1's fallback could never complete, but it must not wedge the
    // queue: ring 2 starts despite no completion signal ever firing.
    expect(AudioSpy).toHaveBeenCalledTimes(2)
    expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
    // No tone was scheduled on the frozen context (its `ended` would never
    // fire), and a best-effort resume() was attempted first.
    expect(toneEndedCallbacks).toHaveLength(0)
    expect(suspendedContexts[0].resume).toHaveBeenCalled()
  })

  it('does not play a stray fallback tone when a spurious media error follows a successful ended', async () => {
    const toneEndedCallbacks: Array<() => void> = []
    class FakeOscillator {
      type = 'sine'
      frequency = { value: 0 }
      connect = vi.fn()
      start = vi.fn()
      stop = vi.fn()
      addEventListener = (type: string, cb: () => void) => {
        if (type === 'ended') toneEndedCallbacks.push(cb)
      }
    }
    class FakeAudioContext {
      currentTime = 0
      destination = {}
      close = vi.fn().mockResolvedValue(undefined)
      createOscillator = () => new FakeOscillator()
      createGain = () => ({ gain: {}, connect: vi.fn() })
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    playImpl = () => Promise.resolve() // the chime plays fine

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

    // Ring 1 completes normally → ring 2 starts.
    act(() => {
      audioInstances[0].emit('ended')
    })
    expect(AudioSpy).toHaveBeenCalledTimes(2)

    // A spurious `error` after the successful `ended` must not arm an
    // audible fallback tone for the already-finished ring.
    act(() => {
      audioInstances[0].emit('error')
    })
    expect(toneEndedCallbacks).toHaveLength(0)
  })

  describe('ring watchdog backstop', () => {
    it('releases a wedged chime that never fires ended: the next ring starts after RING_WATCHDOG_MS and one warn is logged', () => {
      vi.useFakeTimers()
      const store = createStore(true)
      const { result } = renderHook(() => useNotificationSound(), {
        wrapper: createWrapper(store),
      })

      act(() => {
        result.current.play()
        result.current.play()
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)

      // Ring 1 plays but the browser/OS pauses it without `ended` — no
      // completion signal ever arrives. Just before the backstop nothing moves.
      act(() => {
        vi.advanceTimersByTime(RING_WATCHDOG_MS - 1)
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)
      expect(watchdogWarnings()).toHaveLength(0)

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(AudioSpy).toHaveBeenCalledTimes(2)
      expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
      expect(watchdogWarnings()).toHaveLength(1)
      expect(watchdogWarnings()[0][0]).toMatchObject({ stage: 'chime' })

      // A late `ended` from the wedged ring must not double-advance the queue.
      act(() => {
        audioInstances[0].emit('ended')
      })
      expect(AudioSpy).toHaveBeenCalledTimes(2)
    })

    it('clears the watchdog when a ring finishes normally: no backstop fires later', () => {
      vi.useFakeTimers()
      const store = createStore(true)
      const { result } = renderHook(() => useNotificationSound(), {
        wrapper: createWrapper(store),
      })

      act(() => {
        result.current.play()
      })
      act(() => {
        vi.advanceTimersByTime(1_000)
        audioInstances[0].emit('ended')
      })
      expect(vi.getTimerCount()).toBe(0)

      act(() => {
        vi.advanceTimersByTime(4_500)
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)
      expect(watchdogWarnings()).toHaveLength(0)
    })

    it('does not drain the queue after unmount when a watchdog was pending', () => {
      vi.useFakeTimers()
      const store = createStore(true)
      const { result, unmount } = renderHook(() => useNotificationSound(), {
        wrapper: createWrapper(store),
      })

      act(() => {
        result.current.play()
        result.current.play()
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)

      unmount()
      expect(vi.getTimerCount()).toBe(0)

      act(() => {
        vi.advanceTimersByTime(RING_WATCHDOG_MS * 2)
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)
      expect(watchdogWarnings()).toHaveLength(0)
    })

    it('backstops a fallback tone whose ended never fires', async () => {
      vi.useFakeTimers()
      class FakeOscillator {
        type = 'sine'
        frequency = { value: 0 }
        connect = vi.fn()
        start = vi.fn()
        stop = vi.fn()
        addEventListener = vi.fn()
      }
      class FakeAudioContext {
        currentTime = 0
        destination = {}
        close = vi.fn().mockResolvedValue(undefined)
        createOscillator = () => new FakeOscillator()
        createGain = () => ({ gain: {}, connect: vi.fn() })
      }
      vi.stubGlobal('AudioContext', FakeAudioContext)
      playImpl = () => Promise.reject(new Error('chime file failed to load'))

      const store = createStore(true)
      const { result } = renderHook(() => useNotificationSound(), {
        wrapper: createWrapper(store),
      })

      act(() => {
        result.current.play()
        result.current.play()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)

      act(() => {
        vi.advanceTimersByTime(RING_WATCHDOG_MS)
      })
      expect(AudioSpy).toHaveBeenCalledTimes(2)
      expect(watchdogWarnings()).toHaveLength(1)
      expect(watchdogWarnings()[0][0]).toMatchObject({ stage: 'fallback' })
    })
  })

  describe('pause and abort release', () => {
    it('a chime paused without ended releases the queue at once', () => {
      const store = createStore(true)
      const { result } = renderHook(() => useNotificationSound(), {
        wrapper: createWrapper(store),
      })

      act(() => {
        result.current.play()
        result.current.play()
      })
      expect(AudioSpy).toHaveBeenCalledTimes(1)

      act(() => {
        audioInstances[0].emit('pause')
      })
      expect(AudioSpy).toHaveBeenCalledTimes(2)
      expect(audioInstances[1].play).toHaveBeenCalledTimes(1)

      // A natural end fires `pause` then `ended`: the trailing `ended` of the
      // same ring must not advance the queue a second time.
      act(() => {
        audioInstances[0].emit('ended')
      })
      expect(AudioSpy).toHaveBeenCalledTimes(2)
    })

    it('an aborted chime plays the fallback tone once and the queue continues after it', () => {
      const toneEndedCallbacks: Array<() => void> = []
      const oscillatorStarts: number[] = []
      class FakeOscillator {
        type = 'sine'
        frequency = { value: 0 }
        connect = vi.fn()
        start = vi.fn(() => {
          oscillatorStarts.push(1)
        })
        stop = vi.fn()
        addEventListener = (type: string, cb: () => void) => {
          if (type === 'ended') toneEndedCallbacks.push(cb)
        }
      }
      class FakeAudioContext {
        currentTime = 0
        destination = {}
        close = vi.fn().mockResolvedValue(undefined)
        createOscillator = () => new FakeOscillator()
        createGain = () => ({ gain: {}, connect: vi.fn() })
      }
      vi.stubGlobal('AudioContext', FakeAudioContext)

      const store = createStore(true)
      const { result } = renderHook(() => useNotificationSound(), {
        wrapper: createWrapper(store),
      })

      act(() => {
        result.current.play()
        result.current.play()
      })

      act(() => {
        audioInstances[0].emit('abort')
      })
      expect(oscillatorStarts).toHaveLength(1)
      expect(AudioSpy).toHaveBeenCalledTimes(1)

      // A trailing media error for the same dead ring must not arm a second tone.
      act(() => {
        audioInstances[0].emit('error')
      })
      expect(oscillatorStarts).toHaveLength(1)

      act(() => {
        for (const cb of [...toneEndedCallbacks]) cb()
      })
      expect(AudioSpy).toHaveBeenCalledTimes(2)
      expect(audioInstances[1].play).toHaveBeenCalledTimes(1)
    })
  })
})
