import { describe, expect, it } from 'vitest'
import { resolveStartupBanner } from '../../../server/startup-banner.js'

describe('resolveStartupBanner', () => {
  it('keeps advertising the LAN URL when WSL reachability is still unknown', () => {
    const banner = resolveStartupBanner({
      localUrl: 'http://localhost:3001/?token=test',
      advertisedUrl: 'http://192.168.1.100:3001/?token=test',
      status: {
        remoteAccessEnabled: false,
        remoteAccessRequested: true,
        remoteAccessNeedsRepair: false,
        accessUrl: 'http://192.168.1.100:3001/?token=test',
        firewall: {
          platform: 'wsl2',
          portOpen: null,
        },
      },
    })

    expect(banner.kind).toBe('remote')
    expect(banner.url).toBe('http://192.168.1.100:3001/?token=test')
    expect(banner.noteLines).toContain('Remote access is configured; reachability is still being verified.')
  })

  it('keeps advertising the LAN URL when remote access is active but also needs repair', () => {
    const banner = resolveStartupBanner({
      localUrl: 'http://localhost:5173/?token=test',
      advertisedUrl: 'http://192.168.1.100:5173/?token=test',
      status: {
        remoteAccessEnabled: true,
        remoteAccessRequested: true,
        remoteAccessNeedsRepair: true,
        accessUrl: 'http://192.168.1.100:5173/?token=test',
        firewall: {
          platform: 'wsl2',
          portOpen: false,
        },
      },
    })

    expect(banner.kind).toBe('remote')
    expect(banner.url).toBe('http://192.168.1.100:5173/?token=test')
    expect(banner.noteLines).toContain('Remote access is active but needs firewall/port-forward repair.')
  })

  it('falls back to the local banner when WSL remote access needs repair and no LAN URL is available', () => {
    const banner = resolveStartupBanner({
      localUrl: 'http://localhost:3001/?token=test',
      advertisedUrl: 'http://localhost:3001/?token=test',
      status: {
        remoteAccessEnabled: false,
        remoteAccessRequested: true,
        remoteAccessNeedsRepair: true,
        accessUrl: 'http://localhost:3001/?token=test',
        firewall: {
          platform: 'wsl2',
          portOpen: false,
        },
      },
    })

    expect(banner.kind).toBe('local')
    expect(banner.url).toBe('http://localhost:3001/?token=test')
    expect(banner.noteLines).toContain('Remote access is configured but needs firewall/port-forward repair.')
  })
})
