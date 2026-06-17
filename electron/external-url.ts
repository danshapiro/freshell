// Electron main-process helpers for opening URLs in the system browser.

const ALLOWED_PROTOCOLS = ['http:', 'https:']

function isAllowedExternalUrl(url: string): boolean {
  if (typeof url !== 'string') return false
  try {
    return ALLOWED_PROTOCOLS.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

export interface ExternalUrlDeps {
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle(channel: string, listener: (event: any, url: string) => Promise<void>): void
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  isAllowedSender: (event: { sender?: { id?: number } }) => boolean
}

export function registerOpenExternalHandler(deps: ExternalUrlDeps): void {
  deps.ipcMain.handle('open-external-url', async (event, url) => {
    if (!deps.isAllowedSender(event)) {
      throw new Error(`open-external-url rejected: sender not allowed`)
    }
    if (!isAllowedExternalUrl(url)) {
      throw new Error(`open-external-url rejected: only absolute http/https URLs are allowed, got ${JSON.stringify(url)}`)
    }
    await deps.shell.openExternal(url)
  })
}
