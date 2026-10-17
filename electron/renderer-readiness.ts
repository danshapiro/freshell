/** The native window is deliberately structural so readiness can be tested without Electron. */
export interface RendererDocumentWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    getURL(): string
    executeJavaScript(script: string): Promise<unknown>
  }
}

interface RendererReadinessOptions {
  signal?: AbortSignal
  isCurrent?: () => boolean
  /** Absolute end of the owning native attempt, including navigation time. */
  deadline?: number
}

export class RendererReadinessTimeout extends Error {
  constructor() { super('renderer readiness timed out') }
}

const DOCUMENT_SNAPSHOT = `(() => ({
  href: location.href,
  documentUri: document.documentURI,
  ready: document.readyState === 'interactive' || document.readyState === 'complete',
  mounted: Boolean(document.getElementById('root')?.hasChildNodes())
}))()`

function matchesDocument(value: unknown, intended: URL): boolean {
  if (typeof value !== 'string') return false
  try {
    const actual = new URL(value)
    return actual.origin === intended.origin && actual.pathname === intended.pathname
  } catch {
    return false
  }
}

/** Verify the current native document, rather than treating loadURL completion as readiness. */
export function verifyRendererReady(
  window: RendererDocumentWindow,
  loadUrl: string,
  options: RendererReadinessOptions = {},
): Promise<void> {
  const intended = new URL(loadUrl)
  const deadline = options.deadline ?? Date.now() + 10_000
  return new Promise((resolve, reject) => {
    let finished = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(pollTimer)
      clearTimeout(deadlineTimer)
      options.signal?.removeEventListener('abort', cancelled)
      if (error) reject(error)
      else resolve()
    }
    const cancellationError = () => options.signal?.reason instanceof Error && options.signal.reason.name !== 'AbortError'
      ? options.signal.reason : new Error('renderer recovery cancelled')
    const cancelled = () => finish(cancellationError())
    const check = () => {
      if (options.signal?.aborted) throw cancellationError()
      if (options.isCurrent && !options.isCurrent()) throw new Error('renderer navigation changed')
      if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('renderer window destroyed')
      if (Date.now() >= deadline) throw new RendererReadinessTimeout()
    }
    const poll = async () => {
      try {
        check()
        // The deadline and abort handlers settle this promise even if native evaluation never returns.
        let snapshot: unknown
        try {
          snapshot = await window.webContents.executeJavaScript(DOCUMENT_SNAPSHOT)
        } catch {
          // A document can lose its execution context while loading; the owner check below
          // distinguishes that transition from an attempt which has been retired.
        }
        if (finished) return
        check()
        const document = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : undefined
        if (matchesDocument(window.webContents.getURL(), intended)
          && matchesDocument(document?.href, intended)
          && matchesDocument(document?.documentUri, intended)
          && document?.ready === true && document?.mounted === true) {
          finish()
          return
        }
        pollTimer = setTimeout(() => { void poll() }, Math.min(100, deadline - Date.now()))
      } catch (error) {
        finish(error)
      }
    }
    options.signal?.addEventListener('abort', cancelled, { once: true })
    deadlineTimer = setTimeout(() => finish(new RendererReadinessTimeout()), Math.max(0, deadline - Date.now()))
    void poll()
  })
}
