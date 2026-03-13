import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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

  it('server/index.ts wires startup WSL repair through the saved remote-access intent', () => {
    const indexPath = path.resolve(__dirname, '../../../server/index.ts')
    const indexContent = fs.readFileSync(indexPath, 'utf8')

    expect(indexContent).toContain("import { setupWslPortForwarding } from './wsl-port-forward.js'")
    expect(indexContent).toContain("from './wsl-port-forward-startup.js'")
    expect(indexContent).toContain('shouldSetupWslPortForwardingAtStartup(bindHost, currentSettings.network)')
    expect(indexContent).toContain('setupWslPortForwarding(vitePort)')
  })
})
