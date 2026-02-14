import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn(),
  },
}))

import { fetchFirewallConfig } from '@/lib/firewall-configure'
import { api } from '@/lib/api'

describe('fetchFirewallConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns terminal method with command for Linux/macOS', async () => {
    vi.mocked(api.post).mockResolvedValue({
      method: 'terminal',
      command: 'sudo ufw allow 3001/tcp',
    })

    const result = await fetchFirewallConfig()
    expect(result.method).toBe('terminal')
    expect(result).toHaveProperty('command', 'sudo ufw allow 3001/tcp')
    expect(api.post).toHaveBeenCalledWith('/api/network/configure-firewall', {})
  })

  it('returns wsl2 method for WSL2 platform', async () => {
    vi.mocked(api.post).mockResolvedValue({
      method: 'wsl2',
      status: 'started',
    })

    const result = await fetchFirewallConfig()
    expect(result.method).toBe('wsl2')
  })

  it('returns none method when no firewall detected', async () => {
    vi.mocked(api.post).mockResolvedValue({ method: 'none' })

    const result = await fetchFirewallConfig()
    expect(result.method).toBe('none')
  })
})
