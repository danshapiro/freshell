import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { SetupWizard } from '@/components/SetupWizard'
import SettingsView from '@/components/SettingsView'
import { networkReducer, type NetworkStatusResponse } from '@/store/networkSlice'
import { getShareAction } from '@/lib/share-utils'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'

// Mock the api module to intercept network configure calls
const mockPost = vi.fn()
const mockGet = vi.fn()
const mockFetchFirewallConfig = vi.fn()
const mockCancelFirewallConfirmation = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: any[]) => mockGet(...args),
    post: (...args: any[]) => mockPost(...args),
  },
}))
vi.mock('@/lib/firewall-configure', () => ({
  fetchFirewallConfig: (...args: any[]) => mockFetchFirewallConfig(...args),
  cancelFirewallConfirmation: (...args: any[]) => mockCancelFirewallConfirmation(...args),
}))

const unconfiguredStatus: NetworkStatusResponse = {
  configured: false,
  host: '127.0.0.1',
  port: 3001,
  lanIps: ['192.168.1.100'],
  machineHostname: 'my-laptop',
  firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
  remoteAccessEnabled: false,
  rebinding: false,
  devMode: false,
  accessUrl: 'http://192.168.1.100:3001/?token=test',
}

const configuredRemoteStatus: NetworkStatusResponse = {
  ...unconfiguredStatus,
  configured: true,
  host: '0.0.0.0',
  remoteAccessEnabled: true,
  firewall: { platform: 'linux-none', active: false, portOpen: true, commands: [], configuring: false },
}

function resetNetworkMocks(defaultPostResult: unknown = configuredRemoteStatus) {
  mockPost.mockReset()
  mockGet.mockReset()
  mockFetchFirewallConfig.mockReset()
  mockCancelFirewallConfirmation.mockReset()
  mockCancelFirewallConfirmation.mockResolvedValue(undefined)
  mockPost.mockResolvedValue(defaultPostResult)
}

function createStore(networkStatus: NetworkStatusResponse | null = unconfiguredStatus) {
  return configureStore({
    reducer: {
      network: networkReducer,
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
    },
    preloadedState: {
      network: {
        status: networkStatus,
        loading: false,
        configuring: false,
        error: null,
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: { tabs: [], activeTabId: null },
      panes: { layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
    },
  })
}

async function openSafetySettings() {
  fireEvent.click(screen.getByRole('tab', { name: /^safety$/i }))
  return screen.findByRole('switch', { name: /remote access/i })
}

describe('Network Setup Wizard (e2e)', () => {
  beforeEach(() => {
    resetNetworkMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows step 1 prompt when network not configured', () => {
    const store = createStore(unconfiguredStatus)

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )

    expect(screen.getByText(/from your phone and other computers/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /yes/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /no/i })).toBeInTheDocument()
  })

  it('dispatches localhost config and calls onComplete when "No" clicked', async () => {
    const store = createStore(unconfiguredStatus)
    const onComplete = vi.fn()
    mockPost.mockResolvedValue({ ...unconfiguredStatus, configured: true })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={onComplete} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /no/i }))

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/network/configure',
        expect.objectContaining({ host: '127.0.0.1', configured: true }),
      )
    })
  })

  it('advances to step 2 when "Yes" is clicked', async () => {
    const store = createStore(unconfiguredStatus)

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /yes/i }))

    await waitFor(() => {
      expect(screen.queryByText(/from your phone and other computers/i)).not.toBeInTheDocument()
    })
  })

  it('starts at step 2 when initialStep=2 and auto-triggers bind', async () => {
    const store = createStore(unconfiguredStatus)

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    expect(screen.queryByText(/from your phone and other computers/i)).not.toBeInTheDocument()

    // Auto-bind should dispatch configureNetwork on mount
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/network/configure',
        expect.objectContaining({ host: '0.0.0.0', configured: true }),
      )
    })
  })

  it('has accessible dialog role', () => {
    const store = createStore(unconfiguredStatus)
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows confirmation before retrying WSL firewall repair from the wizard', async () => {
    const wslFirewallStatus: NetworkStatusResponse = {
      ...configuredRemoteStatus,
      firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
    }
    const store = createStore(wslFirewallStatus)

    mockPost.mockResolvedValueOnce(wslFirewallStatus)
    mockFetchFirewallConfig
      .mockResolvedValueOnce({
        method: 'confirmation-required',
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken: 'confirm-1',
      })
      .mockResolvedValueOnce({ method: 'wsl2', status: 'started' })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))

    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    expect(confirmationDialog).toBeInTheDocument()
    expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^continue$/i }))

    await waitFor(() => {
      expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
        confirmElevation: true,
        confirmationToken: 'confirm-1',
      })
    })
  })

  it('refreshes the wizard firewall state when the server reports no changes were needed', async () => {
    const wslFirewallStatus: NetworkStatusResponse = {
      ...configuredRemoteStatus,
      firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
    }
    const store = createStore(wslFirewallStatus)

    mockPost.mockResolvedValueOnce(wslFirewallStatus)
    mockFetchFirewallConfig.mockResolvedValueOnce({
      method: 'none',
      message: 'No configuration changes required',
    })
    mockGet.mockResolvedValueOnce({
      ...wslFirewallStatus,
      firewall: { ...wslFirewallStatus.firewall, portOpen: true },
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/api/network/status')
    })

    await waitFor(() => {
      expect(screen.getByText(/port is open/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /configure firewall/i })).not.toBeInTheDocument()
    })
  })
})

describe('Share button routing logic', () => {
  it('returns wizard step 1 when unconfigured', () => {
    const action = getShareAction(unconfiguredStatus)
    expect(action).toEqual({ type: 'wizard', initialStep: 1 })
  })

  it('returns wizard step 2 when configured but localhost', () => {
    const localhostConfigured: NetworkStatusResponse = {
      ...unconfiguredStatus,
      configured: true,
      host: '127.0.0.1',
    }
    const action = getShareAction(localhostConfigured)
    expect(action).toEqual({ type: 'wizard', initialStep: 2 })
  })

  it('returns panel when fully configured with remote access', () => {
    const action = getShareAction(configuredRemoteStatus)
    expect(action).toEqual({ type: 'panel' })
  })

  it('returns loading when status is null (fetch in progress)', () => {
    const action = getShareAction(null)
    expect(action).toEqual({ type: 'loading' })
  })
})

describe('Settings network section (e2e)', () => {
  beforeEach(() => {
    resetNetworkMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders remote access toggle in settings', async () => {
    const store = createStore(unconfiguredStatus)
    render(
      <Provider store={store}>
        <SettingsView onNavigate={vi.fn()} />
      </Provider>,
    )

    expect(await openSafetySettings()).toBeInTheDocument()
  })

  it('toggles remote access on and dispatches configure', async () => {
    const store = createStore(unconfiguredStatus)
    mockPost.mockResolvedValueOnce({ configured: true, host: '0.0.0.0' })

    render(
      <Provider store={store}>
        <SettingsView onNavigate={vi.fn()} />
      </Provider>,
    )

    const toggle = await openSafetySettings()
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/network/configure',
        expect.objectContaining({ host: '0.0.0.0' }),
      )
    })
  })

  it('shows confirmation before retrying Windows firewall repair from settings', async () => {
    const store = createStore({
      ...configuredRemoteStatus,
      firewall: {
        platform: 'windows',
        active: true,
        portOpen: false,
        commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
        configuring: false,
      },
    })

    mockFetchFirewallConfig
      .mockResolvedValueOnce({
        method: 'confirmation-required',
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken: 'confirm-1',
      })
      .mockResolvedValueOnce({ method: 'windows-elevated', status: 'started' })

    render(
      <Provider store={store}>
        <SettingsView onNavigate={vi.fn()} />
      </Provider>,
    )

    await openSafetySettings()
    fireEvent.click(screen.getByRole('button', { name: /fix firewall configuration/i }))

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
})
