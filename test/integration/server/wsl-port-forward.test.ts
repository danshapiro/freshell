import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('WSL port forwarding integration', () => {
  it('exports only the WSL planning helpers needed by the manual repair flow', async () => {
    const wslModule = await import('../../../server/wsl-port-forward.js')

    expect(typeof wslModule.computeWslPortForwardingPlan).toBe('function')
    expect(typeof wslModule.computeWslPortForwardingTeardownPlan).toBe('function')
    expect(typeof wslModule.getWslIp).toBe('function')
    expect(typeof wslModule.getRequiredPorts).toBe('function')
    expect('setupWslPortForwarding' in wslModule).toBe(false)
    expect(typeof wslModule.buildPortForwardingScript).toBe('function')
    expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
    expect(typeof wslModule.buildPortForwardingTeardownScript).toBe('function')
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
