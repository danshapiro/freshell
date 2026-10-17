import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import net from 'node:net'
import { navigateToUnavailableEndpoint, observeOutageNavigation, observeOutageTcp, readOutageNavigationObservation } from '../../e2e-electron/renderer-outage-navigation.js'

const url = 'http://127.0.0.1:4455/?token=owned-token'
const refused = () => Object.assign(new Error('ERR_CONNECTION_REFUSED'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 })

function cachedOfflineWindow() {
  let cachedDocument = true
  const window = {
    webContents: { session: { clearCache: vi.fn(async () => { cachedDocument = false }) } },
    loadURL: vi.fn(async (_url: string) => {
      // Chromium can mount cached Freshell bytes while its API bootstrap fails.
      if (!cachedDocument) throw refused()
    }),
  }
  return window
}

describe('renderer outage navigation fault', () => {
  it('establishes a real network failure even when the app document is cached', async () => {
    const window = cachedOfflineWindow()
    await expect(navigateToUnavailableEndpoint(window, url)).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith(url)
  })

  it('does not navigate until cache eviction has completed', async () => {
    let evict!: () => void
    const window = cachedOfflineWindow()
    const clear = window.webContents.session.clearCache.getMockImplementation()!
    window.webContents.session.clearCache.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { evict = resolve })
      await clear()
    })
    const fault = navigateToUnavailableEndpoint(window, url)
    await Promise.resolve()
    expect(window.loadURL).not.toHaveBeenCalled()
    evict()
    await expect(fault).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
  })

  it('preserves a cache-eviction failure without claiming or starting the outage navigation', async () => {
    const window = cachedOfflineWindow()
    const failure = new Error('cache eviction failed')
    window.webContents.session.clearCache.mockRejectedValueOnce(failure)
    await expect(navigateToUnavailableEndpoint(window, url)).rejects.toBe(failure)
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('refuses to count a successful app document as a native network failure', async () => {
    const window = cachedOfflineWindow()
    window.loadURL.mockResolvedValueOnce(undefined)
    await expect(navigateToUnavailableEndpoint(window, url)).rejects.toThrow('Outage navigation unexpectedly loaded a document')
  })

  it.each([
    { code: 'ERR_ABORTED', errno: -3 },
    { code: 'ERR_BLOCKED_BY_CLIENT', errno: -20 },
    { code: 'ERR_CONNECTION_REFUSED', errno: -3 },
  ])('preserves an unrelated $code/$errno failure', async details => {
    const window = cachedOfflineWindow()
    const failure = Object.assign(new Error(details.code), details)
    window.loadURL.mockRejectedValueOnce(failure)
    await expect(navigateToUnavailableEndpoint(window, url)).rejects.toBe(failure)
  })
})


describe('outage navigation retained failure observations', () => {
  it('retains the fulfilled native promise and events through the failed-helper finally path', async () => {
    const window = observedWindow()
    window.loadURL.mockImplementationOnce(async () => {
      window.webContents.emit('did-start-navigation', {}, url, false, true, 21, 22)
    })
    let attached: any
    try {
      await expect(navigateToUnavailableEndpoint(window, { url, deadline: Date.now() + 1000 }))
        .rejects.toThrow('Outage navigation unexpectedly loaded a document')
    } finally {
      // This is the same failure/finally boundary used by the fixture: an
      // exception must not erase the evidence before the attachment is made.
      attached = (window as any).__freshellOutageObservation
    }
    expect(attached?.promise).toMatchObject({ state: 'fulfilled' })
    expect(attached?.events).toContainEqual(expect.objectContaining({
      event: 'did-start-navigation', isMainFrame: true, isInPlace: false,
      processId: 21, routingId: 22, webContentsId: 19,
    }))
  })
})


function observedWindow() {
  const document = { documentURI: url, readyState: 'complete', getElementById: () => ({ childElementCount: 1 }) }
  const webContents = Object.assign(new EventEmitter(), {
    id: 19, session: { clearCache: vi.fn(async () => {}) },
    getURL: vi.fn(() => url), getOSProcessId: () => 22,
    isLoading: () => true, isLoadingMainFrame: () => true,
    executeJavaScript: vi.fn(async (script: string) => runInNewContext(script, { document })),
  })
  return { id: 7, webContents, loadURL: vi.fn(async (_url: string): Promise<void> => { throw refused() }),
    __freshellOutageObservation: undefined as Record<string, any> | undefined }
}

afterEach(() => { vi.useRealTimers() })

describe('bounded native outage observations', () => {
  it('runs both native callback serialized shapes in a fresh realm without transpiler helpers', async () => {
    const window = observedWindow()
    const navigate = runInNewContext(`(${navigateToUnavailableEndpoint.toString()})`, { setTimeout, clearTimeout, process: { pid: 11 } })
    const read = runInNewContext(`(${readOutageNavigationObservation.toString()})`)
    await expect(navigate(window, { url, deadline: Date.now() + 1000 })).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
    expect(read(window).observation.promise.state).toBe('rejected')
    expect(read(window).observation.document).toEqual({ uri: url.replace('owned-token', '[REDACTED]'), ready: 'complete', mounted: true })
    expect(read(window).target.loadingMainFrame).toBe(true)
  })

  it('retains late same-target events while still throwing the original fulfilled-await failure', async () => {
    vi.useFakeTimers()
    const window = observedWindow()
    window.loadURL.mockImplementationOnce(async () => {
      setTimeout(() => {
        window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true, 21, 22)
        window.webContents.emit('did-navigate-in-page', {}, url, false, 23, 24)
        window.webContents.emit('did-frame-navigate', {}, url, 200, 'OK', true, 21, 22)
        window.webContents.emit('did-finish-load', {})
        window.webContents.emit('did-stop-loading', {})
      }, 20)
    })
    const navigation = navigateToUnavailableEndpoint(window, { url, deadline: Date.now() + 1000 })
    const verdict = expect(navigation).rejects.toThrow('Outage navigation unexpectedly loaded a document')
    await vi.advanceTimersByTimeAsync(250)
    await verdict
    const facts = window.__freshellOutageObservation!
    expect(facts.promise.state).toBe('fulfilled')
    expect(facts.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'did-fail-load', code: -102, isMainFrame: true, processId: 21, routingId: 22 }),
      expect.objectContaining({ event: 'did-navigate-in-page', isInPlace: true, isMainFrame: false, processId: 23, routingId: 24 }),
      expect.objectContaining({ event: 'did-frame-navigate', isMainFrame: true, httpResponseCode: 200 }),
      expect.objectContaining({ event: 'did-finish-load' }), expect.objectContaining({ event: 'did-stop-loading' }),
    ]))
    expect(window.webContents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(JSON.stringify(facts)).not.toContain('owned-token')
  })

  it.each(['cache', 'native', 'document-denied', 'document-timeout', 'listener-denied', 'snapshot-denied', 'expired'])(
    'preserves the original decision with %s diagnostics and cleans owned listeners/timers', async mode => {
      vi.useFakeTimers()
      const window = observedWindow()
      const failure = new Error('original failure')
      if (mode === 'cache') window.webContents.session.clearCache.mockRejectedValueOnce(failure)
      if (mode === 'native') window.loadURL.mockRejectedValueOnce(failure)
      if (mode === 'document-denied') window.webContents.executeJavaScript.mockRejectedValueOnce(new Error('denied'))
      if (mode === 'document-timeout') window.webContents.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}))
      if (mode === 'snapshot-denied') window.webContents.getURL.mockImplementation(() => { throw new Error('target destroyed') })
      const foreign = () => {}
      window.webContents.on('did-stop-loading', foreign)
      if (mode === 'listener-denied') vi.spyOn(window.webContents, 'on').mockImplementationOnce(() => { throw new Error('listener denied') })
      const navigation = navigateToUnavailableEndpoint(window, { url, deadline: Date.now() + (mode === 'expired' ? 0 : 1000) })
      const verdict = mode === 'cache' || mode === 'native' ? expect(navigation).rejects.toBe(failure)
        : expect(navigation).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
      await vi.advanceTimersByTimeAsync(350)
      await verdict
      expect(window.webContents.listeners('did-stop-loading')).toEqual([foreign])
      expect(window.webContents.eventNames()).toEqual(['did-stop-loading'])
      expect(vi.getTimerCount()).toBe(0)
      const facts = window.__freshellOutageObservation!
      if (mode === 'cache') { expect(facts.cache).toBe('rejected'); expect(window.loadURL).not.toHaveBeenCalled() }
      if (mode === 'document-timeout') expect(facts.document).toEqual({ unavailable: 'diagnostic-timeout' })
      if (mode === 'document-denied') expect(facts.document.unavailable).toContain('denied')
      if (mode === 'snapshot-denied' || mode === 'listener-denied') expect(facts.diagnosticErrors.length).toBeGreaterThan(0)
      if (mode === 'expired') { expect(facts.document.unavailable).toBe('original-deadline-exhausted'); expect(window.webContents.executeJavaScript).not.toHaveBeenCalled() }
    },
  )

  it('fits late-event and document observations inside the original remaining deadline', async () => {
    vi.useFakeTimers()
    const started = Date.now(), window = observedWindow()
    const navigation = navigateToUnavailableEndpoint(window, { url, deadline: started + 30 })
    const verdict = expect(navigation).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
    await vi.advanceTimersByTimeAsync(30)
    await verdict
    expect(Date.now() - started).toBe(30)
    expect(window.__freshellOutageObservation!.document).toEqual({ unavailable: 'original-deadline-exhausted' })
    expect(window.webContents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('one bounded endpoint TCP observation', () => {
  it.each(['connected', 'refused', 'error', 'timeout', 'throw'])(
    'records %s without retrying or leaving the socket/timer behind', async result => {
      vi.useFakeTimers()
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const connect = vi.fn(() => {
        if (result === 'throw') throw Object.assign(new Error('denied'), { code: 'EACCES' })
        queueMicrotask(() => {
          if (result === 'connected') socket.emit('connect')
          if (result === 'refused' || result === 'error') socket.emit('error', { code: result === 'refused' ? 'ECONNREFUSED' : 'EACCES' })
        })
        return socket
      })
      const observation = observeOutageTcp(url, Date.now() + 1000, connect as any)
      await vi.advanceTimersByTimeAsync(200)
      expect(await observation).toMatchObject({ host: '127.0.0.1', port: 4455,
        state: result === 'throw' ? 'error' : result, timeoutMs: 200 })
      expect(connect).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 4455 })
      expect(socket.eventNames()).toEqual([])
      expect(socket.destroy).toHaveBeenCalledTimes(result === 'throw' ? 0 : 1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does no diagnostic IO once the original deadline is exhausted', async () => {
    const connect = vi.fn()
    expect(await observeOutageTcp(url, Date.now(), connect as any)).toMatchObject({ state: 'unavailable', reason: 'original-deadline-exhausted' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('observes actual connect and refusal on the same private endpoint', async () => {
    const listener = net.createServer(socket => socket.end())
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address() as net.AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}/?token=owned-token`
    try { expect(await observeOutageTcp(endpoint, Date.now() + 1000)).toMatchObject({ state: 'connected', port: address.port }) }
    finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())) }
    expect(await observeOutageTcp(endpoint, Date.now() + 1000)).toMatchObject({ state: 'refused', code: 'ECONNREFUSED', port: address.port })
  })
})

describe('outage fixture attachment boundary', () => {
  it.each(['fulfilled', 'refused', 'unrelated', 'stop-error', 'diagnostic-error', 'diagnostic-timeout', 'expired'])(
    'attaches retained facts in finally and preserves %s outcome', async mode => {
      vi.useFakeTimers()
      const window = observedWindow(), original = new Error('original')
      if (mode === 'fulfilled') window.loadURL.mockResolvedValueOnce(undefined)
      if (mode === 'unrelated') window.loadURL.mockRejectedValueOnce(original)
      const native = { evaluate: vi.fn(async (callback: any, argument: any) => {
        if (callback === readOutageNavigationObservation && mode === 'diagnostic-error') throw new Error('denied')
        if (callback === readOutageNavigationObservation && mode === 'diagnostic-timeout') return new Promise(() => {})
        return callback(window, argument)
      }) }
      const stopObservation = { pid: 42, port: 4455, host: '127.0.0.1' as const }
      const stop = vi.fn(async () => { if (mode === 'stop-error') throw original })
      const tcp = vi.fn(async () => ({ host: '127.0.0.1', port: 4455, state: 'refused' }))
      const attach = vi.fn(async (_facts: Record<string, unknown>) => {})
      const navigation = observeOutageNavigation({ native, url, deadline: Date.now() + (mode === 'expired' ? 0 : 1000), stopObservation, stop, tcp, attach })
      const verdict = mode === 'fulfilled' ? expect(navigation).rejects.toThrow('Outage navigation unexpectedly loaded a document')
        : mode === 'unrelated' || mode === 'stop-error' ? expect(navigation).rejects.toBe(original)
          : expect(navigation).resolves.toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
      await vi.advanceTimersByTimeAsync(600)
      await verdict
      expect(attach).toHaveBeenCalledOnce()
      const facts = attach.mock.calls[0][0] as any
      expect(facts.endpoint).toBe(stopObservation)
      if (mode === 'fulfilled') expect(facts.afterNavigation.observation.promise.state).toBe('fulfilled')
      if (mode === 'diagnostic-error') expect(facts.afterNavigation).toEqual({ unavailable: 'native-observation-error' })
      if (mode === 'diagnostic-timeout') expect(facts.afterNavigation).toEqual({ unavailable: 'diagnostic-timeout' })
      if (mode === 'expired') expect(facts.afterNavigation).toEqual({ unavailable: 'original-deadline-exhausted' })
      expect(stop).toHaveBeenCalledOnce()
      expect(tcp).toHaveBeenCalledTimes(mode === 'stop-error' ? 0 : 1)
      expect(window.webContents.eventNames()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})


it.each(['throw', 'timeout'])(
  'does not let an attachment %s replace the original helper failure or extend its remaining deadline', async mode => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const window = observedWindow(), original = new Error('original navigation failure')
      window.loadURL.mockRejectedValueOnce(original)
      const native = { evaluate: async (callback: any, argument: any) => callback(window, argument) }
      const attach = vi.fn(async (_facts: Record<string, unknown>) => {
        if (mode === 'throw') throw new Error('attachment denied')
        await new Promise(() => {})
      })
      const started = Date.now()
      const navigation = observeOutageNavigation({ native, url, deadline: started + 280,
        stop: async () => {}, stopObservation: { pid: 42, port: 4455, host: '127.0.0.1' },
        tcp: async () => { throw new Error('diagnostic probe denied') }, attach })
      const verdict = expect(navigation).rejects.toBe(original)
      await vi.advanceTimersByTimeAsync(280)
      await verdict
      expect(attach).toHaveBeenCalledOnce()
      expect((attach.mock.calls[0] as any)[0].tcp).toEqual({ unavailable: 'tcp-observation-error' })
      expect(warning).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ severity: 'warn', event: 'outage_diagnostics_attachment_failed_or_timed_out' }))
      expect(vi.getTimerCount()).toBe(0)
      expect(window.webContents.eventNames()).toEqual([])
    } finally { warning.mockRestore() }
  },
)

it('retains observations when final native state is unavailable and redacts CDP/token values', async () => {
  vi.useFakeTimers()
  const window = observedWindow()
  const endpoint = 'ws://127.0.0.1:9222/devtools/browser/private-cdp-id'
  window.webContents.executeJavaScript.mockRejectedValueOnce(new Error(`denied ${endpoint} ${url}`))
  const navigation = navigateToUnavailableEndpoint(window, { url, deadline: Date.now() + 1000 })
  await vi.advanceTimersByTimeAsync(250)
  await navigation
  window.webContents.getURL.mockImplementationOnce(() => { throw new Error('destroyed') })
  const final = readOutageNavigationObservation(window)
  expect(final.target).toEqual({ unavailable: 'native-target-state-error' })
  expect(final.observation?.promise.state).toBe('rejected')
  expect(final.observation?.document.unavailable).toContain('[REDACTED_CDP]')
  expect(JSON.stringify(final)).not.toContain('owned-token')
  expect(JSON.stringify(final)).not.toContain('private-cdp-id')
})

it('does not wait for a diagnostic attachment after the original deadline has expired', async () => {
  vi.useFakeTimers()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const window = observedWindow(), original = new Error('original navigation failure')
    window.loadURL.mockRejectedValueOnce(original)
    const native = { evaluate: async (callback: any, argument: any) => callback(window, argument) }
    let settled: unknown
    const navigation = observeOutageNavigation({ native, url, deadline: Date.now(),
      stop: async () => {}, stopObservation: { pid: 42, port: 4455, host: '127.0.0.1' },
      tcp: async () => ({ state: 'unavailable' }), attach: async () => new Promise(() => {}),
    }).catch(error => { settled = error })
    // Flush this already-settled native operation without advancing the clock.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    expect(settled).toBe(original)
    expect(vi.getTimerCount()).toBe(0)
    await navigation
  } finally { warning.mockRestore() }
})
