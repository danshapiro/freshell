// Electron main-process helpers for opening URLs in the system browser.

const ALLOWED_PROTOCOLS = ['http:', 'https:']
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

function canonicalizeExternalUrl(url: string): URL | null {
  if (typeof url !== 'string') return null
  // Reject control characters and other shell-dangerous whitespace.
  if (CONTROL_CHAR_RE.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return null
  // Reject URLs that smuggle credentials, which could confuse users or the OS.
  if (parsed.username || parsed.password) return null
  return parsed
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
    const canonical = canonicalizeExternalUrl(url)
    if (!canonical) {
      throw new Error(`open-external-url rejected: only canonical absolute http/https URLs are allowed, got ${JSON.stringify(url)}`)
    }
    await deps.shell.openExternal(canonical.toString())
  })
}
