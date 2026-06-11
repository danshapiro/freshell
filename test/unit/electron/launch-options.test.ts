import { describe, expect, it } from 'vitest'
import { buildLaunchOptions } from '../../../electron/launch-options.js'
import type { DesktopConfig } from '../../../electron/types.js'

function config(overrides: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverMode: 'remote',
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

describe('buildLaunchOptions', () => {
  it('includes the saved remote URL so the chooser can pre-fill it for recovery', () => {
    const result = buildLaunchOptions({
      pending: { candidates: [], reason: 'saved-remote-unreachable' },
      desktopConfig: config({ remoteUrl: 'http://10.0.0.5:3001' }),
    })
    expect(result.remoteUrl).toBe('http://10.0.0.5:3001')
    expect(result.reason).toBe('saved-remote-unreachable')
    expect(result.alwaysAskOnLaunch).toBe(false)
    expect(result.port).toBe(3001)
    expect(result.candidates).toEqual([])
  })

  it('defaults remoteUrl to empty string and supplies a fallback reason when no chooser is pending', () => {
    const result = buildLaunchOptions({
      desktopConfig: config({ serverMode: 'app-bound', remoteUrl: undefined }),
    })
    expect(result.remoteUrl).toBe('')
    expect(result.candidates).toEqual([])
    expect(result.reason).toContain('Choose how Freshell should connect')
  })

  it('passes through pending candidates and reason', () => {
    const candidate = {
      id: 'a',
      url: 'http://localhost:3001',
      origin: 'port-scan' as const,
      ownership: 'detected-local' as const,
    }
    const result = buildLaunchOptions({
      pending: { candidates: [candidate], reason: 'multiple-candidates' },
      desktopConfig: config(),
    })
    expect(result.candidates).toEqual([candidate])
    expect(result.reason).toBe('multiple-candidates')
  })
})
