import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import {
  createNetworkState,
  createNetworkStatus,
  createSettingsViewStore,
  installSettingsViewHooks,
  renderSettingsView,
} from './settings-view-test-utils'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

const mockFetchFirewallConfig = vi.fn()
const mockCancelFirewallConfirmation = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/firewall-configure', () => ({
  fetchFirewallConfig: (...args: any[]) => mockFetchFirewallConfig(...args),
  cancelFirewallConfirmation: (...args: any[]) => mockCancelFirewallConfirmation(...args),
}))

installSettingsViewHooks({ mockFonts: true })

describe('SettingsView network access section', () => {
  it('renders remote access toggle', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByText(/remote access/i)).toBeInTheDocument()
  })

  it('shows firewall Fix button for WSL2 even with empty commands', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('button', { name: /fix firewall/i })).toBeInTheDocument()
  })

  it('keeps WSL2 blocked-state repair visible when the firewall reports inactive', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: { platform: 'wsl2', active: false, portOpen: false, commands: [], configuring: false },
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByText(/port may be blocked/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /fix firewall/i })).toBeInTheDocument()
  })

  it('uses the server remoteAccessEnabled signal for WSL instead of the effective bind host', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: false,
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /fix firewall/i })).not.toBeInTheDocument()
  })

  it('keeps the WSL toggle on and exposes repair when remote access was requested but is not yet active', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: false,
            remoteAccessRequested: true,
            accessUrl: 'http://localhost:3001/?token=abc',
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeChecked()
    expect(screen.getByRole('button', { name: /fix firewall/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get link/i })).not.toBeInTheDocument()
  })

  it('shows an admin-approval modal before disabling exposed WSL remote access', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        method: 'confirmation-required',
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken: 'disable-1',
      })
      .mockResolvedValueOnce({ method: 'wsl2', status: 'started' })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: true,
            firewall: { platform: 'wsl2', active: true, portOpen: true, commands: [], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('switch', { name: /remote access/i }))

    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    expect(confirmationDialog).toBeInTheDocument()

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^continue$/i }))

    await waitFor(() => {
      expect(api.post).toHaveBeenNthCalledWith(2, '/api/network/disable-remote-access', {
        confirmElevation: true,
        confirmationToken: 'disable-1',
      })
    })
  })

  it('keeps WSL remote access enabled when the disable confirmation is cancelled', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.post).mockResolvedValueOnce({
      method: 'confirmation-required',
      title: 'Administrator approval required',
      body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
      confirmLabel: 'Continue',
      confirmationToken: 'disable-1',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: true,
            firewall: { platform: 'wsl2', active: true, portOpen: true, commands: [], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('switch', { name: /remote access/i }))
    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^cancel$/i }))

    expect(api.post).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(mockCancelFirewallConfirmation).toHaveBeenCalledWith('disable-1')
    })
    expect(screen.getByRole('switch', { name: /remote access/i })).toBeChecked()
  })

  it('surfaces a visible error when disabling WSL remote access fails', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.post).mockRejectedValueOnce({
      status: 500,
      message: 'Disable failed',
      details: { error: 'Disable failed' },
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: true,
            firewall: { platform: 'wsl2', active: true, portOpen: true, commands: [], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('switch', { name: /remote access/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/disable failed/i)
    })
    expect(screen.getByRole('switch', { name: /remote access/i })).toBeChecked()
  })

  it('surfaces a visible error when a direct remote access configure request is rejected', async () => {
    const { api } = await import('@/lib/api')
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Configure failed'))

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '127.0.0.1',
            remoteAccessEnabled: false,
            firewall: { platform: 'windows', active: true, portOpen: false, commands: ['netsh ...'], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('switch', { name: /remote access/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/configure failed/i)
    })
    expect(screen.getByRole('switch', { name: /remote access/i })).not.toBeChecked()
  })

  it('shows a visible error when WSL teardown polling finishes but remote access is still enabled', async () => {
    vi.useFakeTimers()
    const { api } = await import('@/lib/api')
    vi.mocked(api.post).mockResolvedValueOnce({ method: 'wsl2', status: 'started' })
    vi.mocked(api.get).mockResolvedValueOnce(createNetworkStatus({
      host: '0.0.0.0',
      remoteAccessEnabled: true,
      remoteAccessRequested: true,
      accessUrl: 'http://192.168.1.100:3001/?token=abc',
      firewall: { platform: 'wsl2', active: true, portOpen: true, commands: [], configuring: false },
    } as any))

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: true,
            remoteAccessRequested: true,
            firewall: { platform: 'wsl2', active: true, portOpen: true, commands: [], configuring: false },
          } as any),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('switch', { name: /remote access/i }))

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
    })

    expect(api.get).toHaveBeenCalledWith('/api/network/status')
    expect(screen.getByRole('alert')).toHaveTextContent(/remote access is still enabled/i)
    expect(screen.getByRole('switch', { name: /remote access/i })).toBeChecked()
  })

  it('shows an admin-approval modal before starting Windows firewall repair', async () => {
    mockFetchFirewallConfig
      .mockResolvedValueOnce({
        method: 'confirmation-required',
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken: 'confirm-1',
      })
      .mockResolvedValueOnce({ method: 'windows-elevated', status: 'started' })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'windows',
              active: true,
              portOpen: false,
              commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
              configuring: false,
            },
          }),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))

    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    expect(confirmationDialog).toBeInTheDocument()

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^continue$/i }))

    await waitFor(() => {
      expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
        confirmElevation: true,
        confirmationToken: 'confirm-1',
      })
    })
  })

  it('revokes the confirmation token when the modal is cancelled', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'confirmation-required',
      title: 'Administrator approval required',
      body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
      confirmLabel: 'Continue',
      confirmationToken: 'confirm-1',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'windows',
              active: true,
              portOpen: false,
              commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
              configuring: false,
            },
          }),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))
    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^cancel$/i }))

    expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(mockCancelFirewallConfirmation).toHaveBeenCalledWith('confirm-1')
    })
  })

  it('clears the in-progress refresh detail after the scheduled status refresh succeeds', async () => {
    vi.useFakeTimers()
    mockFetchFirewallConfig.mockResolvedValueOnce({
      method: 'in-progress',
      error: 'Firewall configuration already in progress',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'windows',
              active: true,
              portOpen: false,
              commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
              configuring: false,
            },
          }),
        }),
      },
    })

    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockResolvedValue(createNetworkStatus({
      firewall: {
        platform: 'windows',
        active: true,
        portOpen: true,
        commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
        configuring: false,
      },
    }))

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/firewall configuration already in progress/i)).toBeInTheDocument()

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
    })

    expect(api.get).toHaveBeenCalledWith('/api/network/status')
    expect(screen.getByText(/port is open/i)).toBeInTheDocument()
    expect(screen.queryByText(/firewall configuration already in progress/i)).not.toBeInTheDocument()
  })

  it('shows in-progress detail immediately after a firewall repair starts', async () => {
    mockFetchFirewallConfig.mockResolvedValueOnce({
      method: 'windows-elevated',
      status: 'started',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'windows',
              active: true,
              portOpen: false,
              commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
              configuring: false,
            },
          }),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))

    await waitFor(() => {
      expect(screen.getByText(/firewall configuration already in progress/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /fix firewall/i })).not.toBeInTheDocument()
  })

  it('hides the Fix action and shows in-progress detail when the firewall is already configuring', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'windows',
              active: true,
              portOpen: false,
              commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
              configuring: true,
            },
          }),
        }),
      },
    })

    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByText(/firewall configuration already in progress/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /fix firewall/i })).not.toBeInTheDocument()
  })

  it('stops polling and surfaces a timeout when firewall configuration never finishes', async () => {
    vi.useFakeTimers()
    mockFetchFirewallConfig.mockResolvedValueOnce({
      method: 'in-progress',
      error: 'Firewall configuration already in progress',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'windows',
              active: true,
              portOpen: false,
              commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
              configuring: false,
            },
          }),
        }),
      },
    })

    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockResolvedValue(createNetworkStatus({
      firewall: {
        platform: 'windows',
        active: true,
        portOpen: false,
        commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
        configuring: true,
      },
    }))

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(22000)
      await Promise.resolve()
    })

    expect(screen.getByText(/firewall configuration timed out/i)).toBeInTheDocument()
    const callCountAfterTimeout = vi.mocked(api.get).mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })

    expect(vi.mocked(api.get).mock.calls.length).toBe(callCountAfterTimeout)
  })

  it('refreshes network status when the server reports no firewall changes were needed', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'none',
      message: 'No configuration changes required',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'wsl2',
              active: true,
              portOpen: false,
              commands: [],
              configuring: false,
            },
          }),
        }),
      },
    })

    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockResolvedValue(createNetworkStatus({
      firewall: {
        platform: 'wsl2',
        active: true,
        portOpen: true,
        commands: [],
        configuring: false,
      },
    }))

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/network/status')
    })

    await waitFor(() => {
      expect(screen.getByText(/port is open/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /fix firewall/i })).not.toBeInTheDocument()
    })
  })

  it('surfaces refresh failures after a no-op firewall response instead of silently keeping stale state', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'none',
      message: 'No configuration changes required',
    })

    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: {
              platform: 'wsl2',
              active: true,
              portOpen: false,
              commands: [],
              configuring: false,
            },
          }),
        }),
      },
    })

    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockRejectedValue(new Error('status refresh failed'))

    renderSettingsView(store, { onNavigate: vi.fn() })

    fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))

    await waitFor(() => {
      expect(screen.getByText(/failed to refresh firewall status/i)).toBeInTheDocument()
    })
  })

  it('shows dev-mode restart warning when devMode is true', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            devMode: true,
            devPort: 5173,
            accessUrl: 'http://192.168.1.100:5173/?token=abc',
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/dev mode/i)).toBeInTheDocument()
    expect(screen.getByText(/npm run dev/i)).toBeInTheDocument()
  })

  it('suppresses dev-mode warning on WSL2', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            devMode: true,
            devPort: 5173,
            accessUrl: 'http://192.168.1.100:5173/?token=abc',
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('disables remote access toggle during rebind', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            rebinding: true,
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeDisabled()
  })

  it('disables remote access toggle during configuring', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus(),
          configuring: true,
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeDisabled()
  })

  it('disables the WSL remote access toggle while firewall repair is already in progress', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            host: '0.0.0.0',
            remoteAccessEnabled: true,
            remoteAccessRequested: true,
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: true },
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /fix firewall/i })).not.toBeInTheDocument()
  })

  it('renders Get link button when access URL is present', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus(),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByText('Get link')).toBeInTheDocument()
  })

  it('calls onSharePanel when Get link is clicked', () => {
    const onSharePanel = vi.fn()
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus(),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn(), onSharePanel })

    fireEvent.click(screen.getByText('Get link'))
    expect(onSharePanel).toHaveBeenCalledOnce()
  })
})
