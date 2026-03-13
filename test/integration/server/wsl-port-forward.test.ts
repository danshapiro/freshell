import { describe, expect, it } from 'vitest'

describe('WSL port forwarding integration', () => {
  it('exports the startup WSL repair helpers alongside the planning helpers', async () => {
    const wslModule = await import('../../../server/wsl-port-forward.js')

    expect(typeof wslModule.computeWslPortForwardingPlan).toBe('function')
    expect(typeof wslModule.getWslIp).toBe('function')
    expect(typeof wslModule.getRequiredPorts).toBe('function')
    expect(typeof wslModule.setupWslPortForwarding).toBe('function')
    expect(typeof wslModule.buildPortForwardingScript).toBe('function')
    expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
  })

  it('gates startup WSL repair on both the effective bind host and saved remote-access intent', async () => {
    const { shouldSetupWslPortForwardingAtStartup } = await import('../../../server/wsl-port-forward-startup.js')

    expect(shouldSetupWslPortForwardingAtStartup('0.0.0.0', { host: '0.0.0.0', configured: true })).toBe(true)
    expect(shouldSetupWslPortForwardingAtStartup('0.0.0.0', { host: '127.0.0.1', configured: true })).toBe(false)
    expect(shouldSetupWslPortForwardingAtStartup('127.0.0.1', { host: '0.0.0.0', configured: true })).toBe(false)
  })
})
