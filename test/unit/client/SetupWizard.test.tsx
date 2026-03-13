import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { SetupWizard } from '@/components/SetupWizard'
import { networkReducer, type NetworkState } from '@/store/networkSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { api } from '@/lib/api'

// Mock lean-qr to avoid canvas issues in jsdom
const mockGenerateQr = vi.fn().mockReturnValue({ size: 21 })
const mockToSvgDataURL = vi.fn().mockReturnValue('data:image/svg+xml;base64,mock')
vi.mock('lean-qr', () => ({
  generate: (...args: any[]) => mockGenerateQr(...args),
}))
vi.mock('lean-qr/extras/svg', () => ({
  toSvgDataURL: (...args: any[]) => mockToSvgDataURL(...args),
}))

// Mock the api module
const defaultConfigureNetworkResponse = {
  configured: true,
  host: '0.0.0.0',
  port: 3001,
  lanIps: ['192.168.1.100'],
  machineHostname: 'test',
  firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
  remoteAccessEnabled: true,
  rebinding: false,
  devMode: false,
  accessUrl: 'http://192.168.1.100:3001/?token=abc',
  rebindScheduled: false,
}
const mockPost = vi.fn().mockResolvedValue(defaultConfigureNetworkResponse)
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: (...args: any[]) => mockPost(...args),
    patch: vi.fn().mockResolvedValue({}),
  },
}))

// Mock firewall-configure for firewall button tests
const mockFetchFirewallConfig = vi.fn()
const mockCancelFirewallConfirmation = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/firewall-configure', () => ({
  fetchFirewallConfig: (...args: any[]) => mockFetchFirewallConfig(...args),
  cancelFirewallConfirmation: (...args: any[]) => mockCancelFirewallConfirmation(...args),
}))
vi.mock('@/components/setup-wizard-timing', () => ({
  SETUP_WIZARD_AUTO_ADVANCE_DELAY_MS: 10,
  SETUP_WIZARD_COPY_RESET_DELAY_MS: 20,
  SETUP_WIZARD_FIREWALL_POLL_INTERVAL_MS: 10,
  SETUP_WIZARD_FIREWALL_POLL_MAX_ATTEMPTS: 3,
}))

const defaultNetworkStatus = {
  configured: false,
  host: '127.0.0.1' as const,
  port: 3001,
  lanIps: ['192.168.1.100'],
  machineHostname: 'my-laptop',
  firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
  rebinding: false,
  devMode: false,
  accessUrl: 'http://192.168.1.100:3001/?token=abc',
}

function createTestStore(networkOverrides: Partial<NetworkState> = {}) {
  const baseStatus = { ...defaultNetworkStatus }
  const { status: _ignoredStatus, ...restNetworkOverrides } = networkOverrides
  const mergedStatus = networkOverrides.status
    ? {
        ...baseStatus,
        ...networkOverrides.status,
      }
    : baseStatus
  if (mergedStatus) {
    const isWsl = mergedStatus.firewall?.platform === 'wsl2'
    if (networkOverrides.status?.remoteAccessEnabled === undefined) {
      mergedStatus.remoteAccessEnabled = isWsl ? false : mergedStatus.host === '0.0.0.0'
    }
    if (networkOverrides.status?.remoteAccessRequested === undefined) {
      mergedStatus.remoteAccessRequested = isWsl
        ? mergedStatus.host === '0.0.0.0'
        : mergedStatus.remoteAccessEnabled
    }
  }

  return configureStore({
    reducer: {
      network: networkReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      network: {
        status: mergedStatus,
        loading: false,
        configuring: false,
        error: null,
        ...restNetworkOverrides,
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: undefined,
      },
    },
  })
}

describe('SetupWizard', () => {
  beforeEach(() => {
    mockPost.mockReset()
    mockPost.mockResolvedValue({ ...defaultConfigureNetworkResponse })
    mockFetchFirewallConfig.mockReset()
    mockCancelFirewallConfirmation.mockReset()
    mockCancelFirewallConfirmation.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
    localStorage.clear()
  })
  it('renders step 1 with setup prompt by default', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )
    expect(screen.getByText(/from your phone and other computers/i)).toBeInTheDocument()
  })

  it('renders step 2 when initialStep=2', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )
    expect(screen.queryByText(/from your phone and other computers/i)).not.toBeInTheDocument()
    expect(screen.getByText(/binding to network/i)).toBeInTheDocument()
  })

  it('shows "Yes, set it up" and "No, just this computer" buttons on step 1', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )
    expect(screen.getByRole('button', { name: /yes/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /no/i })).toBeInTheDocument()
  })

  it('calls onComplete when "No" is clicked', async () => {
    const onComplete = vi.fn()
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SetupWizard onComplete={onComplete} />
      </Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /no/i }))
    await waitFor(() => expect(onComplete).toHaveBeenCalled())
  })

  it('has dialog role with aria-modal', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('renders a high-contrast QR code on step 3', async () => {
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001/?token=abc',
            },
    })
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /yes, set it up/i }))

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /qr code for access url/i })).toBeInTheDocument()
    })

    expect(mockToSvgDataURL).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ on: 'black', off: 'white' }),
    )
  })

  it('copies a tokenized access URL on step 3', async () => {
    localStorage.setItem('freshell.auth-token', 'setup-token-123')
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    })

    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001',
      },
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /yes, set it up/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copy url/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /copy url/i }))

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith('http://192.168.1.100:3001/?token=setup-token-123')
    })
  })

  it('auto-triggers bind when initialStep=2 (re-enable remote access)', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    // Should auto-dispatch configureNetwork with host: '0.0.0.0'
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/network/configure',
        expect.objectContaining({ host: '0.0.0.0', configured: true }),
      )
    })
  })

  it('shows "Configure now" button for WSL2 firewall (empty commands)', async () => {
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
        rebinding: false,
      },
    })
    // Render at step 2, wait for bind to complete
    // Mock post to return bound state with active firewall + portOpen false
    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
      rebinding: false,
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
    })
  })

  it('treats the real WSL bind shape as bound even before firewall repair completes', async () => {
    const firewallBlocked = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        remoteAccessEnabled: false,
        remoteAccessRequested: true,
        firewall: firewallBlocked,
        rebinding: false,
      },
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
    })

    expect(mockPost).not.toHaveBeenCalled()
    expect(screen.getByText(/bound to all interfaces/i)).toBeInTheDocument()
    expect(screen.getByText(/port may be blocked by firewall/i)).toBeInTheDocument()
  })

  it('treats blocked WSL2 access as repairable even when Windows Firewall reports inactive', async () => {
    const firewallBlocked = { platform: 'wsl2', active: false, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallBlocked,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallBlocked,
      rebinding: false,
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/port may be blocked by firewall/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /continue anyway/i })).toBeInTheDocument()
    })
  })

  it('shows an admin-approval modal before starting WSL2 repair', async () => {
    mockFetchFirewallConfig
      .mockResolvedValueOnce({
        method: 'confirmation-required',
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken: 'confirm-1',
      })
      .mockResolvedValueOnce({ method: 'wsl2', status: 'started' })

    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
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

    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    expect(confirmationDialog).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /network setup wizard/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^continue$/i }))

    await waitFor(() => {
      expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
        confirmElevation: true,
        confirmationToken: 'confirm-1',
      })
    })
  })

  it('revokes the confirmation token when the user cancels the admin-approval modal', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'confirmation-required',
      title: 'Administrator approval required',
      body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
      confirmLabel: 'Continue',
      confirmationToken: 'confirm-1',
    })

    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
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
    const confirmationDialog = await screen.findByRole('dialog', { name: /administrator approval required/i })
    fireEvent.click(within(confirmationDialog).getByRole('button', { name: /^cancel$/i }))

    expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(mockCancelFirewallConfirmation).toHaveBeenCalledWith('confirm-1')
    })
  })

  it('treats an in-progress wizard repair as active work and starts polling', async () => {
    mockFetchFirewallConfig.mockResolvedValueOnce({
      method: 'in-progress',
      error: 'Firewall configuration already in progress',
    })

    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
    })

    const refreshedStatus = {
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0' as const,
      firewall: { ...firewallActive, configuring: false, portOpen: true },
      rebinding: false,
    }
    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockResolvedValue(refreshedStatus)

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
      expect(api.get).toHaveBeenCalledWith('/api/network/status')
    })
  })

  it('treats an initially configuring firewall as active work instead of an error', () => {
    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: true }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    expect(screen.getByText(/firewall configuration already in progress/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /configure firewall now/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue anyway/i })).not.toBeInTheDocument()
  })

  it('refreshes network status when the server reports no firewall changes were needed', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'none',
      message: 'No configuration changes required',
    })

    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
    })

    const refreshedStatus = {
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0' as const,
      firewall: { ...firewallActive, portOpen: true },
      rebinding: false,
    }
    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockResolvedValue(refreshedStatus)

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
      expect(api.get).toHaveBeenCalledWith('/api/network/status')
    })

    await waitFor(() => {
      expect(screen.getByText(/port is open/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /configure firewall/i })).not.toBeInTheDocument()
    })
  })

  it('returns to an actionable error state when the no-op firewall refresh fails', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'none',
      message: 'No configuration changes required',
    })

    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
    })

    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockRejectedValue(new Error('status refresh failed'))

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
      expect(screen.getByText(/failed to refresh firewall status/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /continue anyway/i })).toBeInTheDocument()
    })
  })

  it('does not advance to success when the no-op response means remote access was disabled', async () => {
    mockFetchFirewallConfig.mockResolvedValue({
      method: 'none',
      message: 'Remote access is not enabled',
    })

    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
    })

    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockResolvedValue({
      ...defaultNetworkStatus,
      configured: true,
      host: '127.0.0.1',
      firewall: { ...firewallActive, portOpen: null },
      rebinding: false,
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
      expect(screen.getAllByText(/remote access is not enabled/i)).toHaveLength(2)
      expect(screen.queryByText(/you're all set/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /configure firewall/i })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument()
    })
  })

  it('reports firewall error when portOpen is false after configuring completes', async () => {
    mockFetchFirewallConfig.mockResolvedValue({ method: 'wsl2', status: 'ok' })
    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    // Mock the configureNetwork response (auto-bind)
    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
    })

    // Mock fetchNetworkStatus to return configuring=false, portOpen=false
    const mockGet = vi.fn().mockResolvedValue({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: { ...firewallActive, configuring: false, portOpen: false },
      rebinding: false,
    })
    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockImplementation(mockGet)

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    // Wait for Configure button and click it
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))

    await waitFor(() => {
      expect(screen.getByText(/did not open the port/i)).toBeInTheDocument()
    })
  })

  it('sets error status when firewall polling times out after 10 attempts', async () => {
    mockFetchFirewallConfig.mockResolvedValue({ method: 'wsl2', status: 'ok' })
    const firewallActive = { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        firewall: firewallActive,
        rebinding: false,
      },
    })

    // Mock the configureNetwork response (auto-bind)
    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: firewallActive,
      rebinding: false,
    })

    // Mock fetchNetworkStatus to always return configuring=true (never completes)
    const mockGet = vi.fn().mockResolvedValue({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: { ...firewallActive, configuring: true },
      rebinding: false,
    })
    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockImplementation(mockGet)

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    // Wait for Configure button and click it
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))

    await waitFor(() => {
      expect(screen.getByText(/timed out/i)).toBeInTheDocument()
    })
  }, 20000)

  it('shows dev-mode restart warning on step 3 when devMode is true', async () => {
    // Mock the configureNetwork response to include devMode
    mockPost.mockResolvedValueOnce({
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      accessUrl: 'http://192.168.1.100:5173/?token=abc',
          firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
      devMode: true,
      devPort: 5173,
      rebinding: false,
    })

    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:5173/?token=abc',
              devMode: true,
        devPort: 5173,
      },
    })
    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} />
      </Provider>,
    )

    // Click "Yes" to start, then advance through steps
    fireEvent.click(screen.getByRole('button', { name: /yes/i }))

    // Wait for step 3 (auto-advance after bind completes)
    await waitFor(() => {
      expect(screen.getByText(/you're all set/i)).toBeInTheDocument()
    }, { timeout: 5000 })

    // Dev-mode warning should be visible
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/dev mode/i)).toBeInTheDocument()
    expect(screen.getByText(/npm run dev/i)).toBeInTheDocument()
  })

  it('does not auto-advance on WSL when port reachability is still unknown and remote access is not yet enabled', async () => {
    const firewallPending = { platform: 'wsl2', active: true, portOpen: null, commands: [], configuring: false }
    const store = createTestStore({
      status: {
        ...defaultNetworkStatus,
        configured: true,
        host: '0.0.0.0',
        remoteAccessEnabled: false,
        remoteAccessRequested: true,
        accessUrl: 'http://localhost:3001/?token=abc',
        firewall: firewallPending,
        rebinding: false,
      },
    })

    render(
      <Provider store={store}>
        <SetupWizard onComplete={vi.fn()} initialStep={2} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/setting up remote access/i)).toBeInTheDocument()
      expect(screen.getByText(/bound to all interfaces/i)).toBeInTheDocument()
    })

    expect(screen.queryByText(/you're all set/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /qr code for access url/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy url/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
  })
})
