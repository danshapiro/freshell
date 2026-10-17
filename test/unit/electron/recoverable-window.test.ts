import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecoverableWindow } from '../../../electron/recoverable-window.js'
import { registerRendererRecovery } from '../../../electron/renderer-recovery.js'
import { initMainProcess } from '../../../electron/main.js'

const url = 'http://localhost:4455/?token=secret'
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function native(id: number) {
  let destroyed = false
  let currentUrl = 'about:blank'
  let visible = true
  const wc = Object.assign(new EventEmitter(), {
    id, getURL: vi.fn(() => currentUrl), isDestroyed: () => destroyed,
    stop: vi.fn(), forcefullyCrashRenderer: vi.fn(),
    executeJavaScript: vi.fn(async () => ({ href: currentUrl, documentUri: currentUrl, ready: true, mounted: true })),
  })
  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    loadURL: vi.fn(async (next: string) => {
      wc.emit('did-start-navigation', {}, next, false, true)
      currentUrl = next
    }),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => { destroyed = true; win.emit('closed') }),
    show: vi.fn(() => { visible = true }), hide: vi.fn(() => { visible = false }), focus: vi.fn(),
    maximize: vi.fn(), restore: vi.fn(),
    isVisible: () => visible, isFocused: () => true, isMaximized: () => true, isMinimized: () => false,
    getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }),
  })
  return win
}

function fixture(configure?: (win: ReturnType<typeof native>, index: number) => void) {
  const windows: ReturnType<typeof native>[] = []
  const identity = vi.fn()
  const logger = { log: vi.fn() }
  const options = { webPreferences: { preload: '/owned/preload.js' } }
  const construct = vi.fn((nativeOptions: Record<string, any>) => {
    const win = native(windows.length + 1)
    configure?.(win, windows.length)
    windows.push(win)
    return win
  })
  const window = createRecoverableWindow({ createNativeWindow: construct, options, onWebContentsChanged: identity, logger })
  return { window, windows, identity, logger, construct }
}

type ActiveFailure = 'initial-load-failure' | 'initial-load-timeout' | 'active-verification-timeout'
async function retiredActiveFixture(failure: ActiveFailure, candidatePhase: 'load' | 'readiness', minimizeToTray: boolean) {
  const stale = deferred<any>()
  const candidate = deferred<any>()
  const state = fixture((win, index) => {
    if (!index && failure === 'initial-load-failure') win.loadURL.mockRejectedValueOnce(new Error('offline'))
    if (!index && failure === 'initial-load-timeout') win.loadURL.mockImplementationOnce(() => stale.promise)
    if (index === 1) {
      if (candidatePhase === 'load') {
        const load = win.loadURL.getMockImplementation()!
        win.loadURL.mockImplementationOnce(async next => { await candidate.promise; await load(next) })
      } else win.webContents.executeJavaScript.mockImplementationOnce(() => candidate.promise)
    }
  })
  const { window, windows, logger } = state
  const disposeController = registerRendererRecovery({ window, loadUrl: url, serverUrl: 'http://localhost:4455', logger,
    setTimeout, clearTimeout, verifyRecovered: () => window.verifyRendererReady!(url) })
  const dispose = () => { disposeController(); window.cancelRecovery!() }
  const closed = vi.fn(dispose)
  window.on('closed', closed)
  const app = Object.assign(new EventEmitter(), {
    whenReady: async () => {}, quit: vi.fn(), requestSingleInstanceLock: () => true,
  })
  await initMainProcess({ app, createMainWindow: async () => window, stopServer: async () => {},
    disposeRendererRecovery: dispose, minimizeToTray, platform: 'linux' })
  if (failure === 'active-verification-timeout') {
    await window.loadURL(url)
    windows[0].webContents.executeJavaScript.mockImplementationOnce(() => stale.promise)
  }
  const work = failure === 'active-verification-timeout' ? window.verifyRendererReady!(url) : window.loadURL(url)
  const failed = expect(work).rejects.toThrow(failure === 'initial-load-failure' ? 'offline' : 'renderer readiness timed out')
  if (failure !== 'initial-load-failure') await vi.advanceTimersByTimeAsync(10_000)
  await failed
  await vi.advanceTimersByTimeAsync(0)
  expect(windows).toHaveLength(2)
  const settle = () => {
    const mounted = { href: url, documentUri: url, ready: true, mounted: true }
    stale.resolve(mounted)
    candidate.resolve(mounted)
  }
  return { ...state, closed, settle, dispose }
}

describe('logical native window', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['initial-load-failure', 'initial-load-timeout', 'active-verification-timeout'] as const)(
    'keeps close-to-tray working on the surviving active native after %s', async failure => {
      const state = await retiredActiveFixture(failure, 'load', true)
      const { window, windows, identity, closed, settle, dispose } = state
      try {
        const close = { preventDefault: vi.fn() }
        windows[0].emit('close', close)
        expect(close.preventDefault).toHaveBeenCalledOnce()
        expect(windows[0].hide).toHaveBeenCalledOnce()
        expect(window.isVisible!()).toBe(false)
        expect(closed).not.toHaveBeenCalled()
        windows[0].webContents.emit('did-fail-load', {}, -102, 'retired navigation', url, true)
        settle()
        await vi.advanceTimersByTimeAsync(120_000)
        expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
        expect(windows[1].destroy).not.toHaveBeenCalled()
      } finally { dispose(); settle() }
    },
  )

  it.each([
    ['initial-load-failure', 'load'], ['initial-load-failure', 'readiness'],
    ['initial-load-timeout', 'load'], ['initial-load-timeout', 'readiness'],
    ['active-verification-timeout', 'load'], ['active-verification-timeout', 'readiness'],
  ] as const)('permanently cancels pending candidate %s/%s when the surviving active native actually closes', async (failure, phase) => {
    const { window, windows, identity, logger, closed, settle, dispose } = await retiredActiveFixture(failure, phase, false)
    try {
      const close = { preventDefault: vi.fn() }
      windows[0].emit('close', close)
      expect(close.preventDefault).not.toHaveBeenCalled()
      windows[0].destroy()
      expect(closed).toHaveBeenCalledOnce()
      expect(windows[1].destroy).toHaveBeenCalledOnce()
      settle()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
      expect(windows[1].show).not.toHaveBeenCalled()
      expect(windows[1].focus).not.toHaveBeenCalled()
      expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toEqual([])
      await expect(window.webContents!.reload!()).rejects.toThrow('renderer recovery cancelled')
      expect(windows).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { dispose(); settle() }
  })

  it('keeps a genuine native abort event and rejected load promise inert through the recovery controller', async () => {
    const { window, windows, logger, identity } = fixture((win, index) => {
      if (!index) win.loadURL.mockImplementationOnce(async () => {
        win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true)
        throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      })
    })
    const dispose = registerRendererRecovery({ window, loadUrl: url, serverUrl: 'http://localhost:4455', logger,
      setTimeout, clearTimeout, verifyRecovered: () => window.verifyRendererReady!(url) })
    try {
      await expect(window.loadURL(url)).rejects.toThrow('ERR_ABORTED')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(windows).toHaveLength(1)
      expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
      expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_navigation_failed').map(([entry]) =>
        ({ code: entry.errorCode, willRecover: entry.willRecover }))).toEqual([{ code: -3, willRecover: false }])
      expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_started')).toEqual([])
      expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      // An external abort leaves the logical owner available for a later real crash.
      windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
      expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toHaveLength(1)
    } finally { dispose(); window.cancelRecovery!() }
  })

  it('verifies the hidden candidate before IPC identity, preserving geometry and retired-close isolation', async () => {
    const { window, windows, identity, construct } = fixture()
    await window.loadURL(url)
    const closed = vi.fn()
    window.on('closed', closed)
    await window.webContents!.reload!()
    expect(windows[1].webContents.executeJavaScript).toHaveBeenCalled()
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
    expect(construct.mock.calls[1][0]).toEqual(expect.objectContaining({ x: 1, y: 2, width: 800, height: 600, show: false, webPreferences: { preload: '/owned/preload.js' } }))
    expect(windows[1].maximize).toHaveBeenCalledOnce()
    expect(windows[0].destroy).toHaveBeenCalledOnce()
    expect(windows[0].webContents.listenerCount('did-start-navigation')).toBe(0)
    expect(closed).not.toHaveBeenCalled()
    await window.webContents!.reload!()
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2, 3])
    windows[2].destroy()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('preserves hidden-window policy during verified replacement', async () => {
    const { window, windows } = fixture()
    await window.loadURL(url)
    window.hide()
    await window.webContents!.reload!()
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].focus).toHaveBeenCalledOnce() // Existing adapter independently preserves focus.
    await window.webContents!.reload!()
    expect(windows).toHaveLength(3)
  })

  it('keeps a still-mounting candidate hidden and untrusted until its document is usable', async () => {
    const { window, windows, identity } = fixture((win, index) => {
      if (index) win.webContents.executeJavaScript.mockResolvedValueOnce({ href: url, documentUri: url, ready: true, mounted: false })
    })
    await window.loadURL(url)
    const replacement = window.webContents!.reload!()
    await vi.advanceTimersByTimeAsync(0)
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
    expect(window.webContents!.id).toBe(1)
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].focus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    await replacement
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
    window.cancelRecovery!()
  })

  it('rejects an unusable candidate while preserving the original identity', async () => {
    const { window, windows, identity } = fixture((win, index) => {
      if (index) win.webContents.executeJavaScript.mockResolvedValue({ href: 'chrome-error://chromewebdata/', documentUri: 'chrome-error://chromewebdata/', ready: true, mounted: false })
    })
    await window.loadURL(url)
    const failed = expect(window.webContents!.reload!()).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await failed
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
    expect(windows[0].destroy).not.toHaveBeenCalled()
    expect(windows[1].destroy).toHaveBeenCalledOnce()
  })

  it('rejects a candidate navigating away between document verification and activation', async () => {
    const { window, windows, identity } = fixture((win, index) => {
      if (index) win.webContents.executeJavaScript.mockImplementationOnce(async () => {
        queueMicrotask(() => queueMicrotask(() => {
          win.webContents.emit('did-start-navigation', {}, 'chrome-error://chromewebdata/', false, true)
        }))
        return { href: url, documentUri: url, ready: true, mounted: true }
      })
    })
    await window.loadURL(url)
    await expect(window.webContents!.reload!()).rejects.toThrow('navigation changed')
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
    expect(windows[1].destroy).toHaveBeenCalledOnce()
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].focus).not.toHaveBeenCalled()
    window.cancelRecovery!()
  })

  it('removes listeners from active and pending natives and ignores retired native events', async () => {
    const pending = deferred()
    const { window, windows } = fixture((win, index) => {
      if (index) win.loadURL.mockImplementationOnce(() => pending.promise)
    })
    await window.loadURL(url)
    const listener = vi.fn()
    window.webContents!.on('did-fail-load', listener)
    const replacement = window.webContents!.reload!()
    window.webContents!.removeListener!('did-fail-load', listener)
    for (const win of windows) win.webContents.emit('did-fail-load', {}, -102, 'refused', '', true)
    expect(listener).not.toHaveBeenCalled()
    window.cancelRecovery!()
    await expect(replacement).rejects.toThrow('renderer recovery cancelled')
    pending.resolve()
  })

  it.each(['active-load', 'candidate-load', 'evaluation'] as const)('bounds hung %s and permits a later attempt while fencing stale completion', async state => {
    const pending = deferred<any>()
    const { window, windows, identity } = fixture((win, index) => {
      if (state === 'active-load' && !index || state === 'candidate-load' && index === 1) {
        win.loadURL.mockImplementationOnce(() => pending.promise)
      }
      if (state === 'evaluation' && index === 1) win.webContents.executeJavaScript.mockImplementationOnce(() => pending.promise)
    })
    if (state !== 'active-load') await window.loadURL(url)
    const timedOut = expect(state === 'active-load' ? window.loadURL(url) : window.webContents!.reload!()).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await timedOut
    const retired = windows.at(-1)!
    await window.webContents!.reload!()
    const latest = windows.at(-1)!
    const identities = identity.mock.calls.length
    pending.resolve({ href: url, documentUri: url, ready: true, mounted: true })
    retired.webContents.emit('did-start-navigation', {}, url, false, true)
    retired.emit('closed')
    await vi.advanceTimersByTimeAsync(100)
    expect(identity).toHaveBeenCalledTimes(identities)
    expect(window.webContents!.id).toBe(latest.webContents.id)
    expect(retired.show).not.toHaveBeenCalled()
    expect(retired.focus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['active-load', 'candidate-load', 'evaluation'] as const)('permanently disposes hung %s promptly and forbids late activation', async state => {
    const pending = deferred<any>()
    const { window, windows, identity } = fixture((win, index) => {
      if (state === 'active-load' && !index || state === 'candidate-load' && index === 1) win.loadURL.mockImplementationOnce(() => pending.promise)
      if (state === 'evaluation' && index === 1) win.webContents.executeJavaScript.mockImplementationOnce(() => pending.promise)
    })
    if (state !== 'active-load') await window.loadURL(url)
    const replacement = state === 'active-load' ? window.loadURL(url) : window.webContents!.reload!()
    const cancelled = expect(replacement).rejects.toThrow('renderer recovery cancelled')
    await vi.advanceTimersByTimeAsync(0)
    window.cancelRecovery!()
    await cancelled
    pending.resolve({ href: url, documentUri: url, ready: true, mounted: true })
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(window.loadURL(url)).rejects.toThrow('renderer recovery cancelled')
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
    expect(windows.at(-1)!.show).not.toHaveBeenCalled()
    expect(windows.at(-1)!.focus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores same-document token removal but rejects a subsequent cross-document navigation during readiness', async () => {
    const { window, windows } = fixture()
    await window.loadURL(url)
    windows[0].webContents.executeJavaScript.mockImplementationOnce(async () => {
      windows[0].webContents.emit('did-start-navigation', {}, 'http://localhost:4455/', true, true)
      return { href: url, documentUri: url, ready: true, mounted: true }
    })
    await window.verifyRendererReady!(url)
    windows[0].webContents.executeJavaScript.mockImplementationOnce(async () => {
      windows[0].webContents.emit('did-start-navigation', {}, url, false, true)
      return { href: url, documentUri: url, ready: true, mounted: true }
    })
    await expect(window.verifyRendererReady!(url)).rejects.toThrow('navigation changed')
    window.cancelRecovery!()
  })

  it('starts an automatic successor when initial native loading hangs and stop emits only inert abort -3', async () => {
    const pending = deferred()
    const { window, windows, logger, identity } = fixture((win, index) => {
      if (!index) {
        win.loadURL.mockImplementationOnce(() => pending.promise)
        win.webContents.stop.mockImplementation(() => { win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true) })
      }
    })
    const dispose = registerRendererRecovery({ window, loadUrl: url, serverUrl: 'http://localhost:4455', logger,
      setTimeout, clearTimeout, verifyRecovered: () => window.verifyRendererReady!(url) })
    const initial = expect(window.loadURL(url)).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await initial
    expect(windows).toHaveLength(2)
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
    expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toHaveLength(1)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 2])
    dispose()
    window.cancelRecovery!()
  })

  it('keeps initial readiness failures recoverable after a cross-document abort', async () => {
    const { window, windows, logger } = fixture((win, index) => {
      if (!index) win.webContents.executeJavaScript.mockImplementationOnce(async () => {
        win.webContents.emit('did-start-navigation', {}, url, false, true)
        win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true)
        return { href: url, documentUri: url, ready: true, mounted: true }
      })
    })
    const dispose = registerRendererRecovery({ window, loadUrl: url, serverUrl: 'http://localhost:4455', logger,
      setTimeout, clearTimeout, verifyRecovered: () => window.verifyRendererReady!(url) })
    await expect(window.loadURL(url)).rejects.toThrow('navigation changed')
    await vi.advanceTimersByTimeAsync(0)
    expect(windows).toHaveLength(2)
    expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toHaveLength(1)
    dispose()
    window.cancelRecovery!()
  })

  it('grows the attempt budget when an overdue native evaluation settles before its timer can dispatch', async () => {
    const { window } = fixture(win => {
      const evaluate = win.webContents.executeJavaScript.getMockImplementation()!
      win.webContents.executeJavaScript.mockImplementation(async () => {
        const snapshot = await evaluate()
        // A busy main event loop can observe native completion before dispatching an overdue timer.
        vi.setSystemTime(Date.now() + 15_000)
        return snapshot
      })
    })
    await expect(window.loadURL(url)).rejects.toThrow('renderer readiness timed out')
    await expect(window.webContents!.reload!()).resolves.toBeUndefined()
    window.cancelRecovery!()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps growing deadlines finite and cancellable at the native timer limit', async () => {
    const { window } = fixture((win, index) => {
      if (index) win.loadURL.mockImplementation(() => new Promise(() => {}))
    })
    await window.loadURL(url)
    let budgetMs = 10_000
    for (let i = 0; i < 20; i += 1) {
      let settled = false
      const attempt = window.webContents!.reload!() as Promise<void>
      void attempt.then(() => { settled = true }, () => { settled = true })
      const timeout = expect(attempt).rejects.toThrow('renderer readiness timed out')
      await vi.advanceTimersByTimeAsync(budgetMs - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await timeout
      budgetMs = Math.min(2_147_483_647, budgetMs * 2)
    }
    const cancelled = expect(window.webContents!.reload!()).rejects.toThrow('renderer recovery cancelled')
    window.cancelRecovery!()
    window.cancelRecovery!()
    await cancelled
    expect(vi.getTimerCount()).toBe(0)
  })

  it('permanently retires the old destination rather than allowing a stale candidate to switch it back', async () => {
    const pending = deferred()
    const { window, windows, identity } = fixture((win, index) => {
      if (index) win.loadURL.mockImplementationOnce(() => pending.promise)
    })
    await window.loadURL(url)
    const old = expect(window.webContents!.reload!()).rejects.toThrow('renderer recovery cancelled')
    await expect(window.loadURL('http://another-server:4455/')).rejects.toThrow('renderer recovery cancelled')
    await old
    pending.resolve()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1])
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].focus).not.toHaveBeenCalled()
  })

  it.each(['candidate-load', 'evaluation'] as const)('autonomously retries a forever hung %s and ignores its later result', async state => {
    const pending = deferred<any>()
    const { window, windows, logger, identity } = fixture((win, index) => {
      if (index === 1) {
        if (state === 'candidate-load') win.loadURL.mockImplementationOnce(() => pending.promise)
        else win.webContents.executeJavaScript.mockImplementationOnce(() => pending.promise)
      }
    })
    await window.loadURL(url)
    const dispose = registerRendererRecovery({ window, loadUrl: url, serverUrl: 'http://localhost:4455', logger,
      setTimeout, clearTimeout, verifyRecovered: () => window.verifyRendererReady!(url) })
    windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(10_250)
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 3])
    expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toHaveLength(1)
    pending.resolve({ href: url, documentUri: url, ready: true, mounted: true })
    windows[1].webContents.emit('did-fail-load', {}, -102, 'stale', url, true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(windows).toHaveLength(3)
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].focus).not.toHaveBeenCalled()
    expect(identity.mock.calls.map(([id]) => id)).toEqual([1, 3])
    dispose()
    window.cancelRecovery!()
  })

  it('autonomously recovers after a hung native action, retaining increased deadlines through cooldowns and resetting on success', async () => {
    const { window, windows, logger } = fixture((win, index) => {
      if (!index) return
      const load = win.loadURL.getMockImplementation()!
      win.loadURL.mockImplementation(async next => {
        if ([2, 3, 5, 6].includes(index)) throw new Error('offline')
        await new Promise(resolve => setTimeout(resolve, index === 1 ? 15_000 : index === 4 ? 25_000 : 35_000))
        await load(next)
      })
    })
    await window.loadURL(url)
    const dispose = registerRendererRecovery({ window, loadUrl: url, serverUrl: 'http://localhost:4455', logger,
      setTimeout, clearTimeout, verifyRecovered: () => window.verifyRendererReady!(url) })
    windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(155_000)
    expect(windows).toHaveLength(8)
    expect(logger.log.mock.calls.some(([entry]) => entry.event === 'main_window_recovery_circuit_open')).toBe(true)
    expect(logger.log.mock.calls.filter(([entry]) => entry.event === 'main_window_recovery_succeeded')).toHaveLength(1)
    dispose()
    // Verified success restores the initial budget; a new 15-second navigation must time out once.
    const timeout = expect(window.webContents!.reload!()).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(10_000)
    await timeout
    const secondTimeout = expect(window.webContents!.reload!()).rejects.toThrow('renderer readiness timed out')
    await vi.advanceTimersByTimeAsync(20_000)
    await secondTimeout
    const final = window.webContents!.reload!()
    await vi.advanceTimersByTimeAsync(35_000)
    await final
    window.cancelRecovery!()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
