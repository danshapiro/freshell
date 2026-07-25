import { getWsClient } from './ws-client'
import { markTerminalReleased } from './terminal-release-marks'

/**
 * Send terminal.kill for a terminal, marking it released first so the
 * detach middleware does not follow up with a redundant terminal.detach
 * when the pane reference disappears from the layouts.
 *
 * Every production terminal.kill send in the client goes through here.
 * (Test harness escape hatch sendWsMessage in App.tsx can bypass it.)
 */
export function sendTerminalKill(terminalId: string): void {
  markTerminalReleased(terminalId)
  getWsClient().send({ type: 'terminal.kill', terminalId })
}
