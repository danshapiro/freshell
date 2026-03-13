import type { NetworkSettings } from './config-store.js'

export function shouldSetupWslPortForwardingAtStartup(
  bindHost: string,
  network: Pick<NetworkSettings, 'host'> | undefined,
): boolean {
  return bindHost === '0.0.0.0' && network?.host === '0.0.0.0'
}
