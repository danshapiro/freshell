export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function isMacLike(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

export function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => a[k] === b[k])
}

export interface BuildShareUrlOptions {
  currentUrl: string
  lanIp: string | null
  token: string | null
  isDev: boolean
}

export function buildShareUrl(options: BuildShareUrlOptions): string {
  const { currentUrl, lanIp, token, isDev } = options
  const url = new URL(currentUrl)

  // In dev mode, use VITE_PORT (defaulting to 5173) for remote access
  if (isDev) {
    url.port = import.meta.env.VITE_PORT || '5173'
  }

  // Use LAN IP if provided, otherwise keep current hostname
  if (lanIp) {
    url.hostname = lanIp
  }

  // Add token if provided
  if (token) {
    url.searchParams.set('token', token)
  }

  return url.toString()
}
