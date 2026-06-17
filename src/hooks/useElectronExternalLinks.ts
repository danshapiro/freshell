import { useEffect } from 'react'
import { openExternalUrl, shouldOpenLinkExternally } from '@/lib/open-url'

function isExternalLinkAnchor(el: EventTarget): el is HTMLAnchorElement {
  return el instanceof HTMLAnchorElement && Boolean(el.href)
}

function isInAppNavAnchor(el: HTMLAnchorElement): boolean {
  if (el.dataset.openInPane != null) return true
  const target = el.getAttribute('target')
  if (target === '_self') return true
  return false
}

export function useElectronExternalLinks(): void {
  useEffect(() => {
    const desktop = (window as Window & { freshellDesktop?: { isElectron?: boolean } }).freshellDesktop
    if (!desktop?.isElectron) return

    const handleClick = (event: MouseEvent) => {
      if (!shouldOpenLinkExternally(event)) return

      const target = event.composedPath().find(isExternalLinkAnchor)
      if (!target) return
      if (isInAppNavAnchor(target)) return
      if (!/^https?:\/\//i.test(target.href)) return

      event.preventDefault()
      event.stopPropagation()
      openExternalUrl(target.href)
    }

    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [])
}
