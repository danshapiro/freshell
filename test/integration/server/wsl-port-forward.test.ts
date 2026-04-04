import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('WSL port forwarding integration', () => {
  it('exports only the async WSL planning helpers (no sync planning exports)', async () => {
    const wslModule = await import('../../../server/wsl-port-forward.js')

    expect(typeof wslModule.computeWslPortForwardingPlanAsync).toBe('function')
    expect(typeof wslModule.computeWslPortForwardingTeardownPlanAsync).toBe('function')
    expect(typeof wslModule.getRequiredPorts).toBe('function')
    expect('setupWslPortForwarding' in wslModule).toBe(false)
    expect(typeof wslModule.buildPortForwardingScript).toBe('function')
    expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
    expect(typeof wslModule.buildPortForwardingTeardownScript).toBe('function')
    // Sync functions removed
    expect('computeWslPortForwardingPlan' in wslModule).toBe(false)
    expect('computeWslPortForwardingTeardownPlan' in wslModule).toBe(false)
    expect('getWslIp' in wslModule).toBe(false)
    expect('getExistingPortProxyRules' in wslModule).toBe(false)
    expect('getExistingFirewallPorts' in wslModule).toBe(false)
  })

  it('keeps boot-time WSL repair removed from the server startup path', () => {
    const indexPath = path.resolve(__dirname, '../../../server/index.ts')
    const startupHelperPath = path.resolve(__dirname, '../../../server/wsl-port-forward-startup.ts')
    const indexContent = fs.readFileSync(indexPath, 'utf8')

    expect(indexContent).not.toContain("import { setupWslPortForwarding } from './wsl-port-forward.js'")
    expect(indexContent).not.toContain("from './wsl-port-forward-startup.js'")
    expect(indexContent).not.toContain('setupWslPortForwarding(')
    expect(fs.existsSync(startupHelperPath)).toBe(false)
  })
})
