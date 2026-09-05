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

  // Owning-boot override. Runs AFTER remote-mode handling on purpose: a saved
  // remote URL is a per-profile intent that stays valid even against an empty
  // candidate list. For every other owning boot: app-bound/daemon start their
  // own server; remote-without-a-URL goes to the manual chooser — NEVER to a
  // discovery-derived auto-connect, which would attach a neighbor profile's
  // server with a token resolved from the wrong config dir.
  if (options.ownsServer) {
    if (desktopConfig.serverMode === 'app-bound' || desktopConfig.serverMode === 'daemon') {
      return { type: 'start-local' }
    }
    return { type: 'show-chooser', candidates, reason: 'manual-choice' }
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
