import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('WSL port forwarding integration', () => {
  it('exports only the manual WSL helper surface', async () => {
    const wslModule = await import('../../../server/wsl-port-forward.js')

    expect(typeof wslModule.computeWslPortForwardingPlan).toBe('function')
    expect(typeof wslModule.getWslIp).toBe('function')
    expect(typeof wslModule.buildPortForwardingScript).toBe('function')
    expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
    expect('getRequiredPorts' in wslModule).toBe(false)
    expect('setupWslPortForwarding' in wslModule).toBe(false)
  })

  it('server/index.ts does not import or call the startup-only WSL helper path', () => {
    const indexPath = path.resolve(__dirname, '../../../server/index.ts')
    const indexContent = fs.readFileSync(indexPath, 'utf8')

    expect(indexContent).not.toContain("from './wsl-port-forward-startup.js'")
    expect(indexContent).not.toContain('setupWslPortForwarding(')
    expect(indexContent).not.toContain('shouldSetupWslPortForwardingAtStartup')
  })
})
