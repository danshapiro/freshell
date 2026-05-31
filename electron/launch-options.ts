import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export interface LaunchOptionsResponse {
  candidates: LaunchServerCandidate[]
  reason: string
  alwaysAskOnLaunch: boolean
  port: number
  /** Last-known remote URL, so the chooser can pre-fill it during saved-remote recovery. */
  remoteUrl: string
}

/**
 * Build the payload the launch chooser renderer requests via the
 * `get-launch-options` IPC channel. Pure so it can be unit-tested without Electron.
 */
export function buildLaunchOptions(input: {
  pending?: { candidates: LaunchServerCandidate[]; reason: string }
  desktopConfig: DesktopConfig
}): LaunchOptionsResponse {
  return {
    candidates: input.pending?.candidates ?? [],
    reason: input.pending?.reason ?? 'Choose how Freshell should connect.',
    alwaysAskOnLaunch: input.desktopConfig.alwaysAskOnLaunch,
    port: input.desktopConfig.port,
    remoteUrl: input.desktopConfig.remoteUrl ?? '',
  }
}
