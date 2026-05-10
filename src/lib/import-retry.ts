const CHUNK_ERROR_RE =
  /(?:failed to fetch|error loading).*dynamically imported module|importing a module script|loading chunk \d+ failed/i

export const RELOAD_KEY = 'freshell.chunk-reload'
const RELOAD_COOLDOWN_MS = 10_000

export function isChunkLoadError(err: unknown): boolean {
  return err instanceof TypeError && CHUNK_ERROR_RE.test(err.message)
}

export function shouldReload(): boolean {
  try {
    const last = sessionStorage.getItem(RELOAD_KEY)
    if (last && Date.now() - parseInt(last, 10) < RELOAD_COOLDOWN_MS) {
      return false
    }
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    return true
  } catch {
    return true
  }
}

export function withChunkErrorRecovery<T>(importPromise: Promise<T>): Promise<T> {
  return importPromise.catch((err: unknown) => {
    if (isChunkLoadError(err)) {
      if (shouldReload()) {
        window.location.reload()
        return new Promise<never>(() => {})
      }
      throw err
    }
    throw err
  })
}

let recoveryInitialized = false

export function initChunkErrorRecovery(): void {
  if (recoveryInitialized) return
  recoveryInitialized = true

  window.addEventListener('vite:preloadError', (event) => {
    if (shouldReload()) {
      event.preventDefault()
      window.location.reload()
    }
  })

  window.addEventListener('unhandledrejection', (event) => {
    if (isChunkLoadError(event.reason) && shouldReload()) {
      event.preventDefault()
      window.location.reload()
    }
  })
}
