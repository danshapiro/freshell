import { describe, expect, it } from 'vitest'
import { chooseLaunchAction } from '../../../electron/launch-policy.js'
import type { DesktopConfig, LaunchServerCandidate } from '../../../electron/types.js'

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
    ...overrides,
  }
}

function candidate(url: string, token?: string): LaunchServerCandidate {
  return {
    id: url,
    url,
    origin: 'port-scan',
    ownership: 'detected-local',
    label: url,
    ready: true,
    requiresAuth: true,
    token,
  }
}

describe('server ownership', () => {
  it('a named app-bound profile ALWAYS starts its own server (never auto-connects to a discovered one)', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ serverMode: 'app-bound', port: 3002 }),
      candidates: [candidate('http://localhost:3001', 'tok')],
      savedRemoteReachable: false,
      ownsServer: true,
    })).toEqual({ type: 'start-local' })
  })

  it('a named daemon profile skips discovery-driven chooser/auto-connect', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ serverMode: 'daemon' }),
      candidates: [candidate('http://localhost:3001', 'tok')],
      savedRemoteReachable: false,
      ownsServer: true,
    })).toEqual({ type: 'start-local' })
  })

  it('a default boot inside a multi-profile install owns its server too', () => {
    // When the registry names any profile, the Default boot behaves like any
    // other tenant: it must NEVER auto-attach to a neighbor profile's server.
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates: [candidate('http://localhost:3001', 'tok')],
      savedRemoteReachable: false,
      ownsServer: true,
    })).toEqual({ type: 'start-local' })
  })

  it('a legacy default boot (ownsServer unset) keeps historical discovery behavior', () => {
    const c = candidate('http://localhost:3001', 'tok')
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates: [c],
      savedRemoteReachable: false,
      ownsServer: false,
    })).toEqual({ type: 'auto-connect', candidate: c })
  })

  it('an absent ownsServer (legacy call shape) keeps historical discovery behavior', () => {
    const c = candidate('http://localhost:3001', 'tok')
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates: [c],
      savedRemoteReachable: false,
    })).toEqual({ type: 'auto-connect', candidate: c })
  })
  it('owning boots honor alwaysAskOnLaunch (chooser still reachable — its remote/manual sections stay useful)', () => {
    const result = chooseLaunchAction({
      desktopConfig: config({ alwaysAskOnLaunch: true }),
      candidates: [candidate('http://localhost:3001', 'tok')],
      savedRemoteReachable: false,
      ownsServer: true,
    })
    expect(result.type).toBe('show-chooser')
    if (result.type === 'show-chooser') {
      expect(result.reason).toBe('always-ask')
    }
  })

  it('an owning remote-mode boot with no saved URL NEVER auto-connects a discovered candidate', () => {
    const result = chooseLaunchAction({
      desktopConfig: config({ serverMode: 'remote' }),
      candidates: [candidate('http://localhost:3001', 'tok')],
      savedRemoteReachable: false,
      ownsServer: true,
    })
    expect(result.type).toBe('show-chooser')
    if (result.type === 'show-chooser') {
      expect(result.reason).toBe('manual-choice')
    }
  })
})

describe('launch policy', () => {
  it('shows setup when setup is incomplete', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ setupCompleted: false }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({ type: 'show-setup' })
  })

  it('shows chooser when alwaysAskOnLaunch is true even with one candidate', () => {
    const candidates = [candidate('http://localhost:3001', 'token')]
    expect(chooseLaunchAction({
      desktopConfig: config({ alwaysAskOnLaunch: true }),
      candidates,
      savedRemoteReachable: false,
    })).toEqual({
      type: 'show-chooser',
      candidates,
      reason: 'always-ask',
    })
  })

  it('auto-connects to one detected candidate with a token', () => {
    const candidates = [candidate('http://localhost:3001', 'token')]
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates,
      savedRemoteReachable: false,
    })).toEqual({
      type: 'auto-connect',
      candidate: candidates[0],
    })
  })

  it('shows chooser for multiple candidates', () => {
    const candidates = [
      candidate('http://localhost:3001', 'token-a'),
      candidate('http://localhost:3002', 'token-b'),
    ]
    expect(chooseLaunchAction({
      desktopConfig: config(),
      candidates,
      savedRemoteReachable: false,
    })).toEqual({
      type: 'show-chooser',
      candidates,
      reason: 'multiple-candidates',
    })
  })

  it('starts local for app-bound config when no candidates exist', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ serverMode: 'app-bound' }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({ type: 'start-local' })
  })

  it('continues configured daemon startup when no candidates exist', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({ serverMode: 'daemon' }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({ type: 'start-local' })
  })

  it('auto-connects to reachable saved remote config', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'vpn-token',
      }),
      candidates: [],
      savedRemoteReachable: true,
      savedRemoteAuthenticated: true,
    })).toEqual({
      type: 'auto-connect',
      candidate: {
        id: 'http://10.0.0.5:3001',
        url: 'http://10.0.0.5:3001',
        origin: 'configured',
        ownership: 'remote',
        label: 'http://10.0.0.5:3001',
        token: 'vpn-token',
      },
    })
  })

  it('shows chooser for reachable saved remote config with no token', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
      }),
      candidates: [],
      savedRemoteReachable: true,
      savedRemoteAuthenticated: false,
    })).toEqual({
      type: 'show-chooser',
      candidates: [],
      reason: 'missing-token',
    })
  })

  it('shows chooser for reachable saved remote config with an invalid token', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'stale-token',
      }),
      candidates: [],
      savedRemoteReachable: true,
      savedRemoteAuthenticated: false,
    })).toEqual({
      type: 'show-chooser',
      candidates: [],
      reason: 'saved-remote-token-invalid',
    })
  })

  it('shows chooser for unreachable saved remote config', () => {
    expect(chooseLaunchAction({
      desktopConfig: config({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'vpn-token',
      }),
      candidates: [],
      savedRemoteReachable: false,
    })).toEqual({
      type: 'show-chooser',
      candidates: [],
      reason: 'saved-remote-unreachable',
    })
  })
})
