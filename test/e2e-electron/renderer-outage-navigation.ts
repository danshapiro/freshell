interface OutageWindow {
  webContents: { session: { clearCache(): Promise<void> } }
  loadURL(url: string): Promise<void>
}

/** Self-contained so Playwright can evaluate it in the actual Electron main process. */
export async function navigateToUnavailableEndpoint(window: OutageWindow, url: string) {
  // A warm Chromium cache can mount the app even with its server stopped.
  // This fixture needs an actual native load failure to start recovery.
  await window.webContents.session.clearCache()
  try {
    await window.loadURL(url)
  } catch (error) {
    const failure = error as { code?: unknown; errno?: unknown } | null
    if (failure?.code === 'ERR_CONNECTION_REFUSED' && failure.errno === -102) {
      return { code: failure.code, errno: failure.errno }
    }
    throw error
  }
  throw new Error('Outage navigation unexpectedly loaded a document')
}
