export function registerServiceWorker(options?: { enabled?: boolean }): void {
  if (!('serviceWorker' in navigator)) return
  const enabled = options?.enabled ?? import.meta.env.PROD
  if (!enabled) return

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal: app still functions without offline cache support.
    })
  })
}
