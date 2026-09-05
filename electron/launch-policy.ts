import type { DesktopConfig, LaunchServerCandidate } from './types.js'

export type LaunchAction =
  | { type: 'show-setup' }
  | { type: 'start-local' }
  | { type: 'auto-connect'; candidate: LaunchServerCandidate }
  | {
    type: 'show-chooser'
    candidates: LaunchServerCandidate[]
    reason:
      | 'always-ask'
      | 'multiple-candidates'
      | 'missing-token'
      | 'saved-remote-token-invalid'
      | 'saved-remote-unreachable'
      | 'manual-choice'
  }

export interface ChooseLaunchActionOptions {
  desktopConfig: DesktopConfig
  candidates: LaunchServerCandidate[]
  savedRemoteReachable: boolean
  savedRemoteAuthenticated?: boolean
  /**
   * True when the booting profile owns its own server: always for named
   * profiles, and also for the DEFAULT profile once any named profile is
   * installed (a machine with several profiles treats Default as just another
   * tenant — it must never attach to a neighbor's server either).
   */
  ownsServer?: boolean
}

export function chooseLaunchAction(options: ChooseLaunchActionOptions): LaunchAction {
  const { desktopConfig, candidates, savedRemoteReachable, savedRemoteAuthenticated } = options

  if (!desktopConfig.setupCompleted) {
    return { type: 'show-setup' }
  }

  // A server-owning boot NEVER attaches to a discovery-surfaced instance
  // (which could belong to a neighbor profile with a different config dir and
  // identity) via auto-connect or the chooser; it starts its own server
  // (app-bound path in runStartup) or the machine daemon (daemon mode —
  // machine-global by design, see README). This runs BEFORE alwaysAskOnLaunch:
  // a chooser offered no candidates would just be an empty trap for owning
  // boots, so the question moots itself.
  if (
    options.ownsServer &&
    (desktopConfig.serverMode === 'app-bound' || desktopConfig.serverMode === 'daemon')
  ) {
    return { type: 'start-local' }
  }

  if (desktopConfig.alwaysAskOnLaunch) {
    return { type: 'show-chooser', candidates, reason: 'always-ask' }
  }

  if (desktopConfig.serverMode === 'remote' && desktopConfig.remoteUrl) {
    if (savedRemoteReachable) {
      if (!desktopConfig.remoteToken) {
        return { type: 'show-chooser', candidates, reason: 'missing-token' }
      }
      if (savedRemoteAuthenticated === false) {
        return { type: 'show-chooser', candidates, reason: 'saved-remote-token-invalid' }
      }

      const url = normalizeServerUrl(desktopConfig.remoteUrl)
      return {
        type: 'auto-connect',
        candidate: {
          id: url,
          url,
          origin: 'configured',
          ownership: 'remote',
          label: url,
          token: desktopConfig.remoteToken,
        },
      }
    }

    return { type: 'show-chooser', candidates, reason: 'saved-remote-unreachable' }
  }

  if (candidates.length > 1) {
    return { type: 'show-chooser', candidates, reason: 'multiple-candidates' }
  }

  if (candidates.length === 1) {
    if (candidates[0].requiresAuth && !candidates[0].token) {
      return { type: 'show-chooser', candidates, reason: 'missing-token' }
    }

    return { type: 'auto-connect', candidate: candidates[0] }
  }

  if (desktopConfig.serverMode === 'app-bound' || desktopConfig.serverMode === 'daemon') {
    return { type: 'start-local' }
  }

  return { type: 'show-chooser', candidates, reason: 'manual-choice' }
}

function normalizeServerUrl(url: string): string {
  const trimmed = url.trim()

  try {
    return new URL(trimmed).toString().replace(/\/$/, '')
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}
