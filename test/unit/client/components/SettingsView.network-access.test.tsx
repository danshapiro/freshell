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
vi.mock('@/lib/firewall-configure', () => ({
  fetchFirewallConfig: (...args: any[]) => mockFetchFirewallConfig(...args),
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

  it('does not re-issue the firewall request when the modal is cancelled', async () => {
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
  })

  it('treats an in-progress settings repair as a refresh path instead of a no-op', async () => {
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
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(api.get).toHaveBeenCalledWith('/api/network/status')
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
