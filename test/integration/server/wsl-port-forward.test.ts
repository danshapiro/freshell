// test/integration/server/wsl-port-forward.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// This test verifies the bootstrap integration without actually running elevated commands
describe('WSL port forwarding bootstrap integration', () => {
  it('wsl-port-forward module exports all required functions', async () => {
    // Dynamically import to verify the module structure
    const wslModule = await import('../../../server/wsl-port-forward.js')

    expect(typeof wslModule.setupWslPortForwarding).toBe('function')
    expect(typeof wslModule.getWslIp).toBe('function')
    expect(typeof wslModule.getRequiredPorts).toBe('function')
    expect(typeof wslModule.needsPortForwardingUpdate).toBe('function')
    expect(typeof wslModule.buildPortForwardingScript).toBe('function')
  })

  it('server/index.ts imports and calls setupWslPortForwarding after security validation', async () => {
    // Verify the integration by checking that server/index.ts:
    // 1. Imports setupWslPortForwarding from wsl-port-forward
    // 2. Calls it AFTER validateStartupSecurity() (inside main())
    const indexPath = path.resolve(__dirname, '../../../server/index.ts')
    const indexContent = fs.readFileSync(indexPath, 'utf-8')

    // Check import exists
    expect(indexContent).toContain("import { setupWslPortForwarding } from './wsl-port-forward.js'")

    // Check call exists inside main() after validateStartupSecurity
    expect(indexContent).toContain('setupWslPortForwarding()')

    // Verify ordering: validateStartupSecurity must come before setupWslPortForwarding
    const validatePos = indexContent.indexOf('validateStartupSecurity()')
    const setupCallPos = indexContent.indexOf('setupWslPortForwarding()')

    expect(validatePos).toBeGreaterThan(-1)
    expect(setupCallPos).toBeGreaterThan(-1)
    expect(setupCallPos).toBeGreaterThan(validatePos)

    // Verify both are inside main() (after "async function main()")
    const mainFnPos = indexContent.indexOf('async function main()')
    expect(mainFnPos).toBeGreaterThan(-1)
    expect(validatePos).toBeGreaterThan(mainFnPos)
    expect(setupCallPos).toBeGreaterThan(mainFnPos)
  })

  it('bootstrap.ts does NOT call setupWslPortForwarding (moved to index.ts)', async () => {
    // Verify bootstrap no longer calls setupWslPortForwarding
    // This ensures .env values are loaded before port forwarding reads them
    const bootstrapPath = path.resolve(__dirname, '../../../server/bootstrap.ts')
    const bootstrapContent = fs.readFileSync(bootstrapPath, 'utf-8')

    // Should NOT import or call setupWslPortForwarding
    expect(bootstrapContent).not.toContain('setupWslPortForwarding')
  })
})
