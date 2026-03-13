import type { NetworkSettings } from './config-store.js'
import type { FirewallPlatform } from './firewall.js'

export function isRemoteAccessEnabled(
  network: Pick<NetworkSettings, 'configured' | 'host'> | undefined,
  effectiveHost: '127.0.0.1' | '0.0.0.0',
  firewallPlatform: FirewallPlatform,
): boolean {
  if (network?.host === '0.0.0.0') {
    return true
  }

  if (firewallPlatform === 'wsl2') {
    return false
  }

  return network?.configured !== true && effectiveHost === '0.0.0.0'
}
