import { normalizeServerUrl } from '../launch-discovery.js'
import type { LaunchChoice } from '../types.js'

const launchReasonMessages: Record<string, string> = {
  'always-ask': 'Choose whether to connect to an existing server or start a new local server.',
  'multiple-candidates': 'Multiple local Freshell servers are running. Choose one, connect to a remote server, or start a new local server.',
  'missing-token': 'The saved server needs a token. Choose a server, enter a token, or start a new local server.',
  'saved-remote-token-invalid': 'The saved remote server rejected its stored token. Enter a new token, choose another server, or start a new local server.',
  'saved-remote-unreachable': 'The saved remote server is not reachable. Choose another server or start a new local server.',
  'manual-choice': 'Choose whether to connect to an existing server or start a new local server.',
}

export function formatLaunchReason(reason: string): string {
  return launchReasonMessages[reason] ?? 'Choose whether to connect to an existing server or start a new local server.'
}

export function validateRemoteLaunchUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Enter a valid http or https URL'
    }
    return ''
  } catch {
    return 'Enter a valid http or https URL'
  }
}

/**
 * Validate a local-server port. Mirrors the chooser's number-input bounds
 * (1024–65535) and rejects non-integers (e.g. NaN from an empty field).
 * Returns an error message, or null when the port is acceptable.
 */
export function validateLaunchPort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return 'Enter a port between 1024 and 65535'
  }
  return null
}

export function buildConnectChoice(input: {
  url: string
  token?: string
  requiresAuth?: boolean
  alwaysAskOnLaunch: boolean
  remember: boolean
}): LaunchChoice {
  const choice: LaunchChoice = {
    kind: 'connect',
    url: normalizeServerUrl(input.url),
    token: input.token,
    alwaysAskOnLaunch: input.alwaysAskOnLaunch,
    remember: input.remember,
  }
  if (input.requiresAuth !== undefined) {
    choice.requiresAuth = input.requiresAuth
  }
  return choice
}

export function buildRemoteChoice(input: {
  url: string
  token: string
  alwaysAskOnLaunch: boolean
  remember: boolean
}): LaunchChoice {
  return {
    kind: 'remote',
    url: normalizeServerUrl(input.url),
    token: input.token,
    requiresAuth: true,
    alwaysAskOnLaunch: input.alwaysAskOnLaunch,
    remember: input.remember,
  }
}

export function buildStartLocalChoice(input: {
  port: number
  alwaysAskOnLaunch: boolean
  remember: boolean
}): LaunchChoice {
  return {
    kind: 'start-local',
    port: input.port,
    alwaysAskOnLaunch: input.alwaysAskOnLaunch,
    remember: input.remember,
  }
}
