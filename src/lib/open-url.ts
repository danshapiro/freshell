interface ElectronDesktopApi {
  openExternal?: (url: string) => Promise<void>
}

function getDesktopApi(): ElectronDesktopApi | undefined {
  return (typeof window !== 'undefined' && (window as Window & { freshellDesktop?: ElectronDesktopApi }).freshellDesktop) || undefined
}

function toAbsoluteUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Already absolute; preserve the caller's formatting.
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return url
    }
  } catch {
    // Not absolute — fall through to resolve against the page URL.
  }
  try {
    return new URL(url, window.location.href).toString()
  } catch {
    return url
  }
}

export function openExternalUrl(url: string): void {
  if (typeof url !== 'string') {
    console.warn('openExternalUrl: expected a string URL, got', typeof url)
    return
  }

  const absoluteUrl = toAbsoluteUrl(url)
  const desktop = getDesktopApi()
  if (typeof desktop?.openExternal === 'function') {
    desktop.openExternal(absoluteUrl).catch((err: unknown) => {
      console.warn('Failed to open external URL via Electron:', absoluteUrl, err)
    })
    return
  }
  window.open(absoluteUrl, '_blank', 'noopener,noreferrer')
}

export function shouldOpenLinkExternally(event: MouseEvent): boolean {
  return event.ctrlKey || event.shiftKey
}
