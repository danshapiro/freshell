import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: any[]) => mockGet(...args),
    post: (...args: any[]) => mockPost(...args),
  },
}))

const unconfiguredStatus: NetworkStatusResponse = {
  configured: false,
  host: '127.0.0.1',
  port: 3001,
  lanIps: ['192.168.1.100'],
  machineHostname: 'my-laptop',
  firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
  rebinding: false,
  devMode: false,
  accessUrl: 'http://192.168.1.100:3001/?token=test',
}

const configuredRemoteStatus: NetworkStatusResponse = {
  ...unconfiguredStatus,
  configured: true,
  host: '0.0.0.0',
  firewall: { platform: 'linux-none', active: false, portOpen: true, commands: [], configuring: false },
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
      panes: { layouts: {}, activePane: {}, paneTitles: {} },
    },
  })
}

describe('Network Setup Wizard (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPost.mockResolvedValue(configuredRemoteStatus)
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
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders remote access toggle in settings', () => {
    const store = createStore(unconfiguredStatus)
    render(
      <Provider store={store}>
        <SettingsView onNavigate={vi.fn()} />
      </Provider>,
    )

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeInTheDocument()
  })

  it('toggles remote access on and dispatches configure', async () => {
    const store = createStore(unconfiguredStatus)
    mockPost.mockResolvedValueOnce({ configured: true, host: '0.0.0.0' })

    render(
      <Provider store={store}>
        <SettingsView onNavigate={vi.fn()} />
      </Provider>,
    )

    const toggle = screen.getByRole('switch', { name: /remote access/i })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/api/network/configure',
        expect.objectContaining({ host: '0.0.0.0' }),
      )
    })
  })
})
