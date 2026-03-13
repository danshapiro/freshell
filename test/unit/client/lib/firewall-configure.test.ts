import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    post: vi.fn(),
  },
}))

import { cancelFirewallConfirmation, fetchFirewallConfig } from '@/lib/firewall-configure'
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

  it('returns confirmation-required payloads', async () => {
    vi.mocked(api.post).mockResolvedValue({
      method: 'confirmation-required',
      title: 'Administrator approval required',
      body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
      confirmLabel: 'Continue',
      confirmationToken: 'confirm-1',
    })

    const result = await fetchFirewallConfig()
    expect(result).toMatchObject({
      method: 'confirmation-required',
      confirmationToken: 'confirm-1',
    })
  })

  it('passes confirmElevation and confirmationToken when explicitly requested', async () => {
    vi.mocked(api.post).mockResolvedValue({ method: 'windows-elevated', status: 'started' })

    await fetchFirewallConfig({
      confirmElevation: true,
      confirmationToken: 'confirm-1',
    })

    expect(api.post).toHaveBeenCalledWith('/api/network/configure-firewall', {
      confirmElevation: true,
      confirmationToken: 'confirm-1',
    })
  })

  it('translates the API 409 conflict into an in-progress firewall result', async () => {
    vi.mocked(api.post).mockRejectedValue({
      status: 409,
      message: 'Firewall configuration already in progress',
      details: {
        error: 'Firewall configuration already in progress',
        method: 'in-progress',
      },
    })

    await expect(fetchFirewallConfig()).resolves.toEqual({
      method: 'in-progress',
      error: 'Firewall configuration already in progress',
    })
  })

  it('posts the server-issued token when canceling a confirmation', async () => {
    vi.mocked(api.post).mockResolvedValue({})

    await cancelFirewallConfirmation('confirm-1')

    expect(api.post).toHaveBeenCalledWith('/api/network/cancel-firewall-confirmation', {
      confirmationToken: 'confirm-1',
    })
  })
})
