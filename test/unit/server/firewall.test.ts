import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { detectFirewall, firewallCommands, type FirewallDeps } from '../../../server/firewall.js'

/**
 * Creates mock deps for detectFirewall() using dependency injection.
 *
 * This avoids vi.mock('node:fs') and vi.mock('node:child_process') which
 * don't reliably intercept Node built-in modules in vitest's threads pool.
 *
 * @param isWSL2 - Whether the environment should be detected as WSL2
 * @param responses - Map of command name → stdout string (or Error to simulate failure)
 */
function createMockDeps(
  isWSL2: boolean,
  responses: Record<string, string | Error>,
): FirewallDeps {
  return {
    isWSL2: () => isWSL2,
    tryExec: async (cmd: string) => {
      const response = responses[cmd]
      if (response instanceof Error) {
        return null
      } else if (response !== undefined) {
        return response
      } else {
        return null
      }
    },
  }
}

describe('firewall', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  describe('detectFirewall', () => {
    it('detects ufw active on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(false, { ufw: 'Status: active\n' })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-ufw')
      expect(result.active).toBe(true)
    })

    it('detects ufw inactive on Linux (no firewalld)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(false, {
        ufw: 'Status: inactive\n',
        'firewall-cmd': new Error('not found'),
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-ufw')
      expect(result.active).toBe(false)
    })

    it('falls through to firewalld when ufw is inactive', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(false, {
        ufw: 'Status: inactive\n',
        'firewall-cmd': 'running\n',
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-firewalld')
      expect(result.active).toBe(true)
    })

    it('detects firewalld on Linux when ufw not found', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(false, {
        ufw: new Error('not found'),
        'firewall-cmd': 'running\n',
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-firewalld')
      expect(result.active).toBe(true)
    })

    it('detects no firewall on Linux when neither ufw nor firewalld', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(false, {
        ufw: new Error('not found'),
        'firewall-cmd': new Error('not found'),
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-none')
      expect(result.active).toBe(false)
    })

    it('detects macOS firewall enabled', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const deps = createMockDeps(false, { defaults: '1\n' })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('macos')
      expect(result.active).toBe(true)
    })

    it('detects macOS firewall disabled', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const deps = createMockDeps(false, { defaults: '0\n' })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('macos')
      expect(result.active).toBe(false)
    })

    it('detects WSL2 and checks Windows firewall via full path', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(true, {
        '/mnt/c/Windows/System32/netsh.exe': 'State                                 ON\n',
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('wsl2')
      expect(result.active).toBe(true)
    })

    it('detects WSL2 with Windows firewall OFF', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const deps = createMockDeps(true, {
        '/mnt/c/Windows/System32/netsh.exe': 'State                                 OFF\n',
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('wsl2')
      expect(result.active).toBe(false)
    })

    it('does NOT detect WSL1 as WSL2', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      // WSL1 is not WSL2, so isWSL2 = false; fall through to Linux detection
      const deps = createMockDeps(false, {
        ufw: 'Status: inactive\n',
        'firewall-cmd': new Error('not found'),
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-ufw')
      expect(result.active).toBe(false)
    })

    it('detects native Windows firewall', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const deps = createMockDeps(false, {
        netsh: 'State                                 ON\n',
      })
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('windows')
      expect(result.active).toBe(true)
    })

    it('returns linux-none for unknown platform', async () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })
      const deps = createMockDeps(false, {})
      const result = await detectFirewall(deps)
      expect(result.platform).toBe('linux-none')
      expect(result.active).toBe(false)
    })
  })

  describe('firewallCommands', () => {
    it('generates ufw commands for given ports', () => {
      const cmds = firewallCommands('linux-ufw', [3001])
      expect(cmds).toEqual(['sudo ufw allow 3001/tcp'])
    })

    it('generates ufw commands for multiple ports', () => {
      const cmds = firewallCommands('linux-ufw', [3001, 5173])
      expect(cmds).toEqual([
        'sudo ufw allow 3001/tcp',
        'sudo ufw allow 5173/tcp',
      ])
    })

    it('generates firewalld commands', () => {
      const cmds = firewallCommands('linux-firewalld', [3001])
      expect(cmds).toEqual([
        'sudo firewall-cmd --add-port=3001/tcp --permanent && sudo firewall-cmd --reload',
      ])
    })

    it('generates firewalld commands for multiple ports', () => {
      const cmds = firewallCommands('linux-firewalld', [3001, 5173])
      expect(cmds).toEqual([
        'sudo firewall-cmd --add-port=3001/tcp --add-port=5173/tcp --permanent && sudo firewall-cmd --reload',
      ])
    })

    it('generates macOS commands', () => {
      const cmds = firewallCommands('macos', [3001])
      expect(cmds.length).toBe(1)
      expect(cmds[0]).toContain('socketfilterfw')
    })

    it('generates Windows netsh commands with profile=private', () => {
      const cmds = firewallCommands('windows', [3001])
      expect(cmds).toEqual([
        'netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private',
      ])
    })

    it('returns empty for WSL2 (handled separately)', () => {
      const cmds = firewallCommands('wsl2', [3001])
      expect(cmds).toEqual([])
    })

    it('returns empty for no-firewall platforms', () => {
      const cmds = firewallCommands('linux-none', [3001])
      expect(cmds).toEqual([])
    })
  })
})
