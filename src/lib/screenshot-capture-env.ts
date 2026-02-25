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

export async function suspendTerminalRenderersForScreenshot(): Promise<() => Promise<void>> {
  const suspendedPaneIds: string[] = []

  for (const [paneId, handler] of terminalCaptureHandlers) {
    try {
      if (handler.suspendWebgl()) {
        suspendedPaneIds.push(paneId)
      }
    } catch {
      // Best effort only.
    }
  }

  if (suspendedPaneIds.length > 0) {
    await afterPaint()
  }

  return async () => {
    for (const paneId of suspendedPaneIds) {
      try {
        terminalCaptureHandlers.get(paneId)?.resumeWebgl()
      } catch {
        // Best effort only.
      }
    }

    if (suspendedPaneIds.length > 0) {
      await afterPaint()
    }
  }
}
