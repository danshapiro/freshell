const SW_RELOAD_SENTINEL = 'freshell.sw.controller-reload'

interface RegisterServiceWorkerOptions {
  enabled?: boolean
  reload?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

export function registerServiceWorker(options?: RegisterServiceWorkerOptions): void {
  if (!('serviceWorker' in navigator)) return
  const enabled = options?.enabled ?? import.meta.env.PROD
  if (!enabled) return
  const reload = options?.reload ?? (() => window.location.reload())
  const storage = options?.storage ?? window.sessionStorage

  try {
    if (storage.getItem(SW_RELOAD_SENTINEL) === '1') {
      storage.removeItem(SW_RELOAD_SENTINEL)
    }
  } catch {
    // Ignore sessionStorage access failures.
  }

  let reloading = false
  const onControllerChange = () => {
    if (reloading) return
    reloading = true
    try {
      storage.setItem(SW_RELOAD_SENTINEL, '1')
    } catch {
      // Ignore sessionStorage access failures.
    }
    reload()
  }

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
      .then((registration) => registration.update?.())
      .catch(() => {
        // Non-fatal: app still functions without offline cache support.
      })
  })
}
