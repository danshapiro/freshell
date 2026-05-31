import { describe, expect, it } from 'vitest'
import {
  buildConnectChoice,
  buildRemoteChoice,
  buildStartLocalChoice,
  formatLaunchReason,
  localCandidatePort,
  validateLaunchPort,
  validateRemoteLaunchUrl,
} from '../../../../electron/launch-chooser/chooser-logic.js'

describe('launch chooser logic', () => {
  it('validates remote launch URLs', () => {
    expect(validateRemoteLaunchUrl('http://10.0.0.5:3001')).toBe('')
    expect(validateRemoteLaunchUrl('https://freshell.internal')).toBe('')
    expect(validateRemoteLaunchUrl('localhost:3001')).toBe('Enter a valid http or https URL')
    expect(validateRemoteLaunchUrl('ftp://example.com')).toBe('Enter a valid http or https URL')
  })

  it('builds a connect choice', () => {
    expect(buildConnectChoice({
      url: 'http://localhost:3001',
      token: 'local-token',
      alwaysAskOnLaunch: true,
      remember: true,
    })).toEqual({
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'local-token',
      alwaysAskOnLaunch: true,
      remember: true,
    })
  })

  it('builds a remote choice', () => {
    expect(buildRemoteChoice({
      url: 'http://10.0.0.5:3001/',
      token: 'vpn-token',
      alwaysAskOnLaunch: false,
      remember: true,
    })).toEqual({
      kind: 'remote',
      url: 'http://10.0.0.5:3001',
      token: 'vpn-token',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    })
  })

  it('builds a start-local choice', () => {
    expect(buildStartLocalChoice({
      port: 3003,
      alwaysAskOnLaunch: false,
      remember: true,
    })).toEqual({
      kind: 'start-local',
      port: 3003,
      alwaysAskOnLaunch: false,
      remember: true,
    })
  })

  it('formats launch reasons for users', () => {
    expect(formatLaunchReason('saved-remote-token-invalid')).toContain('rejected its stored token')
    expect(formatLaunchReason('missing-token')).toContain('needs a token')
    expect(formatLaunchReason('unknown')).toContain('connect to an existing server')
  })

  it('accepts ports inside the allowed range', () => {
    expect(validateLaunchPort(1024)).toBeNull()
    expect(validateLaunchPort(3001)).toBeNull()
    expect(validateLaunchPort(65535)).toBeNull()
  })

  it('rejects ports outside the allowed range or that are not whole numbers', () => {
    for (const port of [0, 80, 1023, 65536, 70000, -1, Number.NaN, 3001.5]) {
      expect(validateLaunchPort(port)).toContain('between 1024 and 65535')
    }
  })

  it('extracts the port of localhost candidates and ignores remote ones', () => {
    expect(localCandidatePort('http://localhost:3001')).toBe(3001)
    expect(localCandidatePort('http://127.0.0.1:4000')).toBe(4000)
    expect(localCandidatePort('https://localhost')).toBe(443)
    expect(localCandidatePort('http://localhost')).toBe(80)
    expect(localCandidatePort('http://10.0.0.5:3001')).toBeNull()
    expect(localCandidatePort('not-a-url')).toBeNull()
  })
})
