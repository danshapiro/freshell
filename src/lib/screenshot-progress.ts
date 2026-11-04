let activeCaptures = 0
const listeners = new Set<() => void>()

export function subscribeScreenshotProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getScreenshotInProgress(): boolean {
  return activeCaptures > 0
}

export function beginScreenshotProgress(): () => void {
  activeCaptures += 1
  for (const listener of listeners) listener()
  let finished = false
  return () => {
    if (finished) return
    finished = true
    activeCaptures -= 1
    for (const listener of listeners) listener()
  }
}

/** Two frames let React commit the toast and the browser paint it before the
 * synchronous DOM clone. Background windows may stop frames entirely. */
export function waitForScreenshotProgressPaint(): Promise<void> {
  if (document.visibilityState !== 'visible') return Promise.resolve()
  return new Promise((resolve) => {
    let frame = 0
    const done = () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, 100)
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(done)
    })
  })
}
