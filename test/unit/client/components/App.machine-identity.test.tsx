import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import machineIdentityReducer from '@/store/machineIdentitySlice'
import { networkReducer } from '@/store/networkSlice'
import { MACHINE_ID_STORAGE_KEY, type Machine } from '@/lib/machine-identity'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

vi.mock('@/components/TabContent', () => ({ default: () => <div /> }))
vi.mock('@/components/Sidebar', () => ({ default: () => <aside />, AppView: {} as any }))
vi.mock('@/components/TabBar', () => ({ default: () => <div /> }))
vi.mock('@/components/OverviewView', () => ({ default: () => <div /> }))
vi.mock('@/components/TabsView', () => ({ default: () => <div /> }))
vi.mock('@/components/TerminalInterestReporter', () => ({ TerminalInterestReporter: () => null }))
vi.mock('@/components/AuthRequiredModal', () => ({ AuthRequiredModal: () => null }))
vi.mock('@/components/DeadSessionPanel', () => ({ DeadSessionPanel: () => null }))
vi.mock('@/components/ReconcileWarmingBanner', () => ({ ReconcileWarmingBanner: () => null }))
vi.mock('@/components/SetupWizard', () => ({ SetupWizard: () => null }))
vi.mock('@/components/RecoveryOfferPanel', () => ({ RecoveryOfferPanel: () => null }))
vi.mock('@/components/VirtualDeckPanel', () => ({ default: () => null }))
vi.mock('@/hooks/useTheme', () => ({ useThemeEffect: () => {} }))
vi.mock('@/hooks/useTurnCompletionNotifications', () => ({ useTurnCompletionNotifications: () => {} }))
vi.mock('@/hooks/useElectronExternalLinks', () => ({ useElectronExternalLinks: () => {} }))
vi.mock('@/hooks/useFocusStealGuard', () => ({ useFocusStealGuard: () => {} }))
vi.mock('@/hooks/useStreamDeck', () => ({ useStreamDeck: () => {} }))
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => false }))
vi.mock('@/hooks/useOrientation', () => ({ useOrientation: () => ({ isLandscape: false }) }))
vi.mock('@/hooks/useFullscreen', () => ({ useFullscreen: () => ({ isFullscreen: false, exitFullscreen: vi.fn() }) }))

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  getMachines: vi.fn(),
  createMachine: vi.fn(),
  fetchSidebarSessionsSnapshot: vi.fn(),
  restoreMachineWorkspace: vi.fn(),
  installCrossTabSync: vi.fn(),
  startTabRegistrySync: vi.fn(),
  setHelloExtensionProvider: vi.fn(),
  connect: vi.fn(),
  onMessage: vi.fn(),
  onReconnect: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  },
  api: {
    get: (path: string) => mocks.apiGet(path),
    patch: vi.fn(),
    post: vi.fn(),
  },
  getMachines: () => mocks.getMachines(),
  createMachine: (label: string) => mocks.createMachine(label),
  fetchSidebarSessionsSnapshot: (...args: unknown[]) => mocks.fetchSidebarSessionsSnapshot(...args),
  isApiUnauthorizedError: (error: unknown) => (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 401
  ),
  isTransientRequestFailure: () => false,
}))

vi.mock('@/lib/machine-workspace', () => ({
  restoreMachineWorkspace: (...args: unknown[]) => mocks.restoreMachineWorkspace(...args),
}))

vi.mock('@/store/crossTabSync', () => ({
  installCrossTabSync: (...args: unknown[]) => mocks.installCrossTabSync(...args),
}))

vi.mock('@/store/tabRegistrySync', () => ({
  getCurrentTabRegistryClientInstanceId: () => 'window-identity-test',
  startTabRegistrySync: (...args: unknown[]) => mocks.startTabRegistrySync(...args),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    connect: mocks.connect,
    onMessage: mocks.onMessage,
    onReconnect: mocks.onReconnect,
    setHelloExtensionProvider: mocks.setHelloExtensionProvider,
    cancelCreate: vi.fn(),
    setReconcilePendingCreates: vi.fn(),
    clearReconcileCreateHold: vi.fn(),
    poke: vi.fn(),
    isReady: false,
    serverInstanceId: undefined,
  }),
}))

const MACHINE: Machine = {
  id: 'machine-desktop',
  label: 'DANDESKTOP',
  createdAt: 1_789_171_200_000,
  lastSeenAt: 1_789_171_200_000,
}

function createStore() {
  const serverSettings = createDefaultServerSettings({ loggingDebug: defaultSettings.logging.debug })
  const localSettings = resolveLocalSettings()
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
      terminalMeta: terminalMetaReducer,
      network: networkReducer,
      extensions: extensionsReducer,
      machineIdentity: machineIdentityReducer,
    },
    middleware: (getDefault) => getDefault({
      serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
    }),
    preloadedState: {
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
        lastSavedAt: undefined,
      },
      connection: { status: 'disconnected', lastError: undefined, platform: null, availableClis: {} },
      sessions: { projects: [], expandedProjects: new Set<string>(), wsSnapshotReceived: false, isLoading: false, error: null },
      terminalMeta: { byTerminalId: {} },
      network: { status: null, loading: false, configuring: false, error: null },
      extensions: { entries: [] },
    },
  })
}

describe('App machine identity bootstrap', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
    vi.clearAllMocks()
    mocks.onMessage.mockReturnValue(() => {})
    mocks.onReconnect.mockReturnValue(() => {})
    mocks.connect.mockResolvedValue(undefined)
    mocks.restoreMachineWorkspace.mockResolvedValue({ restoredTabs: 0 })
    mocks.installCrossTabSync.mockReturnValue(() => {})
    mocks.startTabRegistrySync.mockReturnValue(() => {})
    mocks.fetchSidebarSessionsSnapshot.mockResolvedValue([])
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/api/bootstrap') {
        return Promise.resolve({
          settings: createDefaultServerSettings({ loggingDebug: defaultSettings.logging.debug }),
          platform: { platform: 'linux', availableClis: {}, featureFlags: {} },
        })
      }
      if (path === '/api/version') return Promise.resolve({ currentVersion: '0.0.0' })
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('holds hello and tab sync behind the explicit chooser for a fresh browser with existing machines', async () => {
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    expect(await screen.findByRole('dialog', { name: 'Choose a machine' })).toBeInTheDocument()
    expect(mocks.restoreMachineWorkspace).not.toHaveBeenCalled()
    expect(mocks.installCrossTabSync).not.toHaveBeenCalled()
    expect(mocks.startTabRegistrySync).not.toHaveBeenCalled()
    expect(mocks.setHelloExtensionProvider).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('does not auto-create a machine after its bootstrap is cancelled', async () => {
    let resolveMachines: ((machines: Machine[]) => void) | undefined
    mocks.getMachines.mockImplementation(() => new Promise<Machine[]>((resolve) => {
      resolveMachines = resolve
    }))
    mocks.createMachine.mockResolvedValue(MACHINE)
    const store = createStore()

    const rendered = render(<Provider store={store}><App /></Provider>)
    await waitFor(() => expect(mocks.getMachines).toHaveBeenCalledTimes(1))
    rendered.unmount()

    await act(async () => {
      resolveMachines?.([])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mocks.createMachine).not.toHaveBeenCalled()
    expect(mocks.startTabRegistrySync).not.toHaveBeenCalled()
  })

  it('restores the selected machine before configuring the hello and tab-sync transport', async () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id)
    expect(mocks.restoreMachineWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.startTabRegistrySync.mock.invocationCallOrder[0],
    )
    expect(store.getState().tabRegistry).toMatchObject({
      deviceId: MACHINE.id,
      deviceLabel: MACHINE.label,
    })

    const helloProvider = mocks.setHelloExtensionProvider.mock.calls[0]?.[0] as () => Record<string, unknown>
    expect(helloProvider()).toMatchObject({
      deviceId: MACHINE.id,
      clientInstanceId: 'window-identity-test',
    })
  })
})
