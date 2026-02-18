import { api } from './api'

export type ConfigureFirewallResult =
  | { method: 'terminal'; command: string }
  | { method: 'wsl2' | 'windows-elevated'; status: string }
  | { method: 'none'; message?: string }
  | { method: 'in-progress'; error: string }

/**
 * Call the firewall configuration endpoint and return the result.
 * This is a pure API call — the calling component handles the UI flow.
 *
 * For 'terminal': caller creates a tab, lets TerminalView handle the
 * pane-owned lifecycle, then sends the command as terminal.input after
 * the terminal is ready (via a useEffect watching pane status).
 *
 * For 'wsl2'/'windows-elevated': caller polls /api/network/status.
 *
 * For 'none': nothing to do.
 */
export async function fetchFirewallConfig(): Promise<ConfigureFirewallResult> {
  return api.post<ConfigureFirewallResult>('/api/network/configure-firewall', {})
}
