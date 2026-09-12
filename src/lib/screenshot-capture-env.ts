type TerminalCaptureHandler = {
  suspendWebgl: () => boolean
  resumeWebgl: () => void
}

const terminalCaptureHandlers = new Map<string, TerminalCaptureHandler>()

function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

export function registerTerminalCaptureHandler(paneId: string, handler: TerminalCaptureHandler): () => void {
  terminalCaptureHandlers.set(paneId, handler)
  return () => {
    const current = terminalCaptureHandlers.get(paneId)
    if (current === handler) {
      terminalCaptureHandlers.delete(paneId)
    }
  }
}

// Reference counting for overlapping suspensions: concurrent captures (or a
// capture racing a manual one) can each hold a suspension; the depth
// increments BEFORE the suspend work and its paint await, so a suspension
// entering DURING another's acquisition window joins the same cycle and never
// re-suspends the handlers. Resumes only release the renderers when the LAST
// one lands, and each resumer is idempotent.
let suspensionDepth = 0
let suspendedPaneIds: string[] = []

export async function suspendTerminalRenderersForScreenshot(): Promise<() => Promise<void>> {
  suspensionDepth += 1
  if (suspensionDepth === 1) {
    const ids: string[] = []
    for (const [paneId, handler] of terminalCaptureHandlers) {
      try {
        if (handler.suspendWebgl()) {
          ids.push(paneId)
        }
      } catch {
        // Best effort only.
      }
    }
    suspendedPaneIds = ids
  }
  if (suspendedPaneIds.length > 0) {
    await afterPaint()
  }

  let resumed = false
  return async () => {
    if (resumed) return
    resumed = true
    suspensionDepth -= 1
    if (suspensionDepth > 0) return

    const paneIds = suspendedPaneIds
    suspendedPaneIds = []
    for (const paneId of paneIds) {
      try {
        terminalCaptureHandlers.get(paneId)?.resumeWebgl()
      } catch {
        // Best effort only.
      }
    }

    if (paneIds.length > 0) {
      await afterPaint()
    }
  }
}
