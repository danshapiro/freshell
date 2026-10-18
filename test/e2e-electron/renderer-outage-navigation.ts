import net from 'node:net'
import type { OwnedServerStopObservation } from './owned-server-teardown.js'

interface OutageWindow {
  id?: number
  webContents: {
    id?: number
    session: {
      clearCache(): Promise<void>
      clearStorageData(options: { origin: string; storages: Array<'serviceworkers' | 'cachestorage'> }): Promise<void>
    }
    getURL?(): string
    getOSProcessId?(): number
    isLoading?(): boolean
    isLoadingMainFrame?(): boolean
    on?(event: string, listener: (...args: any[]) => void): unknown
    removeListener?(event: string, listener: (...args: any[]) => void): unknown
    executeJavaScript?(script: string): Promise<unknown>
  }
  loadURL(url: string): Promise<void>
  __freshellOutageObservation?: Record<string, any>
}

/** Self-contained: Playwright serializes this into the existing Electron actor. */
export function readOutageNavigationObservation(window: OutageWindow) {
  const observation = window.__freshellOutageObservation ?? null
  try {
    return { observation, target: {
      windowId: window.id, webContentsId: window.webContents.id,
      url: window.webContents.getURL?.().replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]')
        .replace(/wss?:\/\/[^\s"']*\/devtools\/[^\s"']*/gi, '[REDACTED_CDP]').slice(0, 2048),
      loading: window.webContents.isLoading?.() ?? 'unavailable',
      loadingMainFrame: window.webContents.isLoadingMainFrame?.() ?? 'unavailable',
    } }
  } catch { return { observation, target: { unavailable: 'native-target-state-error' } } }
}

/** Self-contained so Playwright can evaluate it in the actual Electron main process. */
export async function navigateToUnavailableEndpoint(window: OutageWindow, input: string | { url: string; deadline: number }) {
  const url = typeof input === 'string' ? input : input.url
  const deadline = typeof input === 'string' ? 0 : input.deadline
  const observation: Record<string, any> | undefined = typeof input === 'string' ? undefined : {
    startedAt: Date.now(), windowId: window.id, webContentsId: window.webContents.id,
    cache: 'pending', storage: 'not-started', promise: { state: 'not-started' }, events: [], diagnosticErrors: [],
    document: { unavailable: 'not-observed' },
  }
  const listeners: Array<[string, (...args: any[]) => void]> = []
  // Object methods deliberately keep this callback serializable without lexical
  // transpiler name helpers. Diagnostics never take part in the verdict below.
  const diagnostics = {
    text(value: unknown) {
      return String(value).replace(/([?&]token=)[^&#\s"']*/gi, '$1[REDACTED]')
        .replace(/wss?:\/\/[^\s"']*\/devtools\/[^\s"']*/gi, '[REDACTED_CDP]').slice(0, 2048)
    },
    snapshot() {
      return { at: Date.now(), windowId: window.id, webContentsId: window.webContents.id,
        mainPid: process.pid, rendererPid: window.webContents.getOSProcessId?.() ?? 'unavailable',
        url: diagnostics.text(window.webContents.getURL?.() ?? 'unavailable'),
        loading: window.webContents.isLoading?.() ?? 'unavailable',
        loadingMainFrame: window.webContents.isLoadingMainFrame?.() ?? 'unavailable' }
    },
    record(event: string, fields: Record<string, unknown> = {}) {
      if (observation && observation.events.length < 64) {
        observation.events.push({ event, at: Date.now(), webContentsId: window.webContents.id, ...fields })
      }
    },
    async bounded(operation: Promise<unknown>, cap: number) {
      const remaining = Math.min(cap, deadline - Date.now())
      if (remaining <= 0) return { unavailable: 'original-deadline-exhausted' }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([operation, new Promise(resolve => {
          timer = setTimeout(() => resolve({ unavailable: 'diagnostic-timeout' }), remaining)
        })])
      } catch (error) { return { unavailable: diagnostics.text(error) } }
      finally { if (timer !== undefined) clearTimeout(timer) }
    },
  }
  if (observation) {
    window.__freshellOutageObservation = observation
    try {
      observation.before = diagnostics.snapshot()
      listeners.push(
        ['did-start-navigation', (_event, targetUrl, isInPlace, isMainFrame, processId, routingId) =>
          diagnostics.record('did-start-navigation', { url: diagnostics.text(targetUrl), isInPlace, isMainFrame, processId, routingId })],
        ['did-frame-navigate', (_event, targetUrl, httpResponseCode, httpStatusText, isMainFrame, processId, routingId) =>
          diagnostics.record('did-frame-navigate', { url: diagnostics.text(targetUrl), httpResponseCode, httpStatusText: diagnostics.text(httpStatusText), isMainFrame, processId, routingId })],
        ['did-navigate-in-page', (_event, targetUrl, isMainFrame, processId, routingId) =>
          diagnostics.record('did-navigate-in-page', { url: diagnostics.text(targetUrl), isInPlace: true, isMainFrame, processId, routingId })],
        ['did-fail-load', (_event, code, description, targetUrl, isMainFrame, processId, routingId) =>
          diagnostics.record('did-fail-load', { code, description: diagnostics.text(description), url: diagnostics.text(targetUrl), isMainFrame, processId, routingId })],
        ['did-start-loading', () => diagnostics.record('did-start-loading')],
        ['did-finish-load', () => diagnostics.record('did-finish-load')],
        ['did-stop-loading', () => diagnostics.record('did-stop-loading')],
      )
      if (!window.webContents.on) observation.diagnosticErrors.push('native event API unavailable')
      else for (const [event, listener] of listeners) window.webContents.on(event, listener)
    } catch (error) { observation.diagnosticErrors.push(diagnostics.text(error)) }
  }
  try {
    // HTTP cache eviction alone leaves Freshell's offline worker shell usable.
    // Isolate that fixture fallback before the same native navigation.
    await window.webContents.session.clearCache()
    if (observation) { observation.cache = 'fulfilled'; observation.storage = 'pending' }
    await window.webContents.session.clearStorageData({ origin: new URL(url).origin,
      storages: ['serviceworkers', 'cachestorage'] })
    if (observation) { observation.storage = 'fulfilled'; observation.promise = { state: 'pending', at: Date.now() } }
    try {
      await window.loadURL(url)
      if (observation) observation.promise = { state: 'fulfilled', at: Date.now() }
    } catch (error) {
      const failure = error as { code?: unknown; errno?: unknown } | null
      if (observation) observation.promise = { state: 'rejected', at: Date.now(),
        code: failure?.code, errno: failure?.errno, error: diagnostics.text(error) }
      if (failure?.code === 'ERR_CONNECTION_REFUSED' && failure.errno === -102) {
        return { code: failure.code, errno: failure.errno }
      }
      throw error
    }
    throw new Error('Outage navigation unexpectedly loaded a document')
  } finally {
    if (observation) {
      if (observation.cache === 'pending') observation.cache = 'rejected'
      if (observation.storage === 'pending') observation.storage = 'rejected'
      try {
        // Retain late native callbacks without reclassifying a fulfilled await.
        const remaining = Math.min(250, deadline - Date.now())
        observation.postSettlementMs = Math.max(0, remaining)
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
        observation.after = diagnostics.snapshot()
        observation.document = deadline <= Date.now() ? { unavailable: 'original-deadline-exhausted' }
          : window.webContents.executeJavaScript ? await diagnostics.bounded(window.webContents.executeJavaScript(
            '({ uri: String(document.documentURI).replace(/([?&]token=)[^&#]*/gi, "$1[REDACTED]"), ready: document.readyState, mounted: !!document.getElementById("root")?.childElementCount })',
          ), 100) : { unavailable: 'native document API unavailable' }
        if (observation.document && typeof observation.document.uri === 'string') {
          observation.document.uri = diagnostics.text(observation.document.uri)
        }
      } catch (error) { observation.diagnosticErrors.push(diagnostics.text(error)) }
      finally {
        for (const [event, listener] of listeners) {
          try { window.webContents.removeListener?.(event, listener) }
          catch (error) { observation.diagnosticErrors.push(diagnostics.text(error)) }
        }
        observation.finishedAt = Date.now()
      }
    }
  }
}

/** Exactly one diagnostic connect; never an outage acceptance condition. */
export async function observeOutageTcp(url: string, deadline: number,
  connect: typeof net.createConnection = net.createConnection) {
  const endpoint = new URL(url)
  const host = endpoint.hostname, port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80))
  const timeoutMs = Math.min(200, deadline - Date.now())
  if (timeoutMs <= 0) return { host, port, state: 'unavailable', reason: 'original-deadline-exhausted' }
  return new Promise<Record<string, unknown>>(resolve => {
    let socket: net.Socket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = {
      settle(state: string, code?: string) {
        if (timer !== undefined) clearTimeout(timer)
        socket?.removeListener('connect', observer.connected)
        socket?.removeListener('error', observer.failed)
        socket?.destroy()
        resolve({ host, port, state, code, at: Date.now(), timeoutMs })
      },
      connected() { observer.settle('connected') },
      failed(error: NodeJS.ErrnoException) { observer.settle(error.code === 'ECONNREFUSED' ? 'refused' : 'error', error.code) },
    }
    try {
      socket = connect({ host, port })
      socket.once('connect', observer.connected)
      socket.once('error', observer.failed)
      timer = setTimeout(() => observer.settle('timeout'), timeoutMs)
    } catch (error) { observer.failed(error as NodeJS.ErrnoException) }
  })
}

interface OutageNativeHandle {
  evaluate<R, A>(callback: (window: OutageWindow, argument: A) => R | Promise<R>, argument: A): Promise<R>
}

/** Existing native actor and attachment route, including the failed-helper path. */
export async function observeOutageNavigation(options: {
  native: OutageNativeHandle
  url: string
  deadline: number
  stop: () => Promise<void>
  stopObservation: OwnedServerStopObservation
  attach: (facts: Record<string, unknown>) => Promise<void>
  tcp?: typeof observeOutageTcp
}) {
  const facts: Record<string, unknown> = { endpoint: options.stopObservation }
  // Bound read-only native diagnostics to the original test deadline. A
  // missing observation must neither gate navigation nor mask its failure.
  const observeNativeState = async (key: string) => {
    const remaining = Math.min(100, options.deadline - Date.now())
    if (remaining <= 0) { facts[key] = { unavailable: 'original-deadline-exhausted' }; return }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      facts[key] = await Promise.race([
        options.native.evaluate(readOutageNavigationObservation, undefined),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'diagnostic-timeout' }), remaining) }),
      ])
    } catch { facts[key] = { unavailable: 'native-observation-error' } }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  try {
    await observeNativeState('beforeStop')
    await options.stop()
    try { facts.tcp = await (options.tcp ?? observeOutageTcp)(options.url, options.deadline) }
    catch { facts.tcp = { unavailable: 'tcp-observation-error' } }
    const failure = await options.native.evaluate(navigateToUnavailableEndpoint, { url: options.url, deadline: options.deadline })
    facts.failure = failure
    return failure
  } finally {
    await observeNativeState('afterNavigation')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const attachment = options.attach(facts)
      const remaining = Math.min(100, options.deadline - Date.now())
      if (remaining <= 0) {
        // Start the existing attachment route, but never await diagnostics
        // past the original deadline or leave a rejection unobserved.
        void attachment.catch(() => {})
        throw new Error('original deadline exhausted before attachment settlement')
      }
      await Promise.race([attachment, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('attachment observation deadline')), remaining)
      })])
    } catch { console.warn(JSON.stringify({ severity: 'warn', event: 'outage_diagnostics_attachment_failed_or_timed_out' })) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
}
