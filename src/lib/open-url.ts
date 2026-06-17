interface ElectronDesktopApi {
  openExternal?: (url: string) => Promise<void>
}

function getDesktopApi(): ElectronDesktopApi | undefined {
  return (typeof window !== 'undefined' && (window as Window & { freshellDesktop?: ElectronDesktopApi }).freshellDesktop) || undefined
}

export function openExternalUrl(url: string): void {
  const desktop = getDesktopApi()
  if (typeof desktop?.openExternal === 'function') {
    void desktop.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function shouldOpenLinkExternally(event: MouseEvent): boolean {
  return event.ctrlKey || event.shiftKey
}
