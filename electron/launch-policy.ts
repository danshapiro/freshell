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

  if (candidates.length > 1) {
    return { type: 'show-chooser', candidates, reason: 'multiple-candidates' }
  }

  if (candidates.length === 1) {
    if (candidates[0].requiresAuth && !candidates[0].token) {
      return { type: 'show-chooser', candidates, reason: 'missing-token' }
    }

    return { type: 'auto-connect', candidate: candidates[0] }
  }

  if (desktopConfig.serverMode === 'app-bound') {
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
