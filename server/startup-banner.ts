type StartupBannerStatus = {
  remoteAccessEnabled: boolean
  remoteAccessRequested?: boolean
  remoteAccessNeedsRepair?: boolean
  accessUrl: string
  firewall?: {
    platform?: string
    portOpen?: boolean | null
  }
}

type ResolveStartupBannerArgs = {
  localUrl: string
  advertisedUrl: string
  fallbackRemoteAccessEnabled?: boolean
  status: StartupBannerStatus | null
}

export type StartupBanner = {
  kind: 'local' | 'remote'
  url: string
  noteLines: string[]
}

function isLocalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return url.includes('localhost') || url.includes('127.0.0.1')
  }
}

export function resolveStartupBanner({
  localUrl,
  advertisedUrl,
  fallbackRemoteAccessEnabled = false,
  status,
}: ResolveStartupBannerArgs): StartupBanner {
  if (status === null) {
    return fallbackRemoteAccessEnabled
      ? { kind: 'remote', url: advertisedUrl, noteLines: [] }
      : { kind: 'local', url: localUrl, noteLines: ['Run the setup wizard to enable remote access.'] }
  }

  const hasLanUrl = !isLocalUrl(advertisedUrl)

  if (status.remoteAccessNeedsRepair === true) {
    return hasLanUrl
      ? {
        kind: 'remote',
        url: advertisedUrl,
        noteLines: [
          'Remote access is active but needs firewall/port-forward repair.',
          'Open Settings and use Fix firewall to keep LAN access reliable.',
        ],
      }
      : {
        kind: 'local',
        url: localUrl,
        noteLines: [
          'Remote access is configured but needs firewall/port-forward repair.',
          'Open Settings and use Fix firewall to restore LAN access.',
        ],
      }
  }

  if (status.remoteAccessEnabled || hasLanUrl) {
    const noteLines: string[] = []
    if (
      status.firewall?.platform === 'wsl2'
      && status.remoteAccessRequested === true
      && status.firewall.portOpen === null
      && !status.remoteAccessEnabled
    ) {
      noteLines.push('Remote access is configured; reachability is still being verified.')
    }

    return {
      kind: 'remote',
      url: advertisedUrl,
      noteLines,
    }
  }

  return {
    kind: 'local',
    url: localUrl,
    noteLines: ['Run the setup wizard to enable remote access.'],
  }
}
