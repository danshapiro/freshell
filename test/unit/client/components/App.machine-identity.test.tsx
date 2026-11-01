import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import {
  MACHINE_ID_STORAGE_KEY,
  consumeActiveMachineSelectionMark,
  markActiveMachineSelection,
  peekActiveMachineSelectionMark,
  type Machine,
} from '@/lib/machine-identity'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'
import { getWindowLayoutKey } from '@/store/window-layout-keys'

vi.mock('@/components/TabContent', () => ({ default: () => <div /> }))
vi.mock('@/components/Sidebar', () => ({ default: () => <aside />, AppView: {} as any }))
vi.mock('@/components/TabBar', () => ({ default: () => <div /> }))
vi.mock('@/components/OverviewView', () => ({ default: () => <div /> }))
vi.mock('@/components/TabsView', () => ({ default: () => <div /> }))
vi.mock('@/components/TerminalInterestReporter', () => ({ TerminalInterestReporter: () => null }))
vi.mock('@/components/AuthRequiredModal', () => ({
  AuthRequiredModal: () => <div data-testid="auth-required-modal" />,
}))
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
  classifyPersistedLayoutHealth: vi.fn(),
  backfillPersistedLayoutMachineId: vi.fn(),
  clearPreMigrationLayoutEvidence: vi.fn(),
  armPreMigrationEvidenceClear: vi.fn(),
  pruneOwnStaleLayoutEnvelope: vi.fn(),
  installCrossTabSync: vi.fn(),
  startTabRegistrySync: vi.fn(),
  setHelloExtensionProvider: vi.fn(),
  connect: vi.fn(),
  onMessage: vi.fn(),
  onReconnect: vi.fn(),
  // The REAL layout-health implementations, captured by the mock factory's
  // importOriginal: the foreign-path failure tests below delegate classify/
  // backfill to them, because the fully mocked pair cannot observe the
  // machine-id stamp transition on the envelope (e3 post-cap finding 1's
  // reviewer note).
  realLayoutHealth: {} as typeof import('@/lib/recovery/layout-health'),
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

vi.mock('@/lib/recovery/layout-health', async (importOriginal) => {
  mocks.realLayoutHealth = await importOriginal<typeof import('@/lib/recovery/layout-health')>()
  return {
    classifyPersistedLayoutHealth: (...args: unknown[]) => mocks.classifyPersistedLayoutHealth(...args),
    backfillPersistedLayoutMachineId: (...args: unknown[]) => mocks.backfillPersistedLayoutMachineId(...args),
    clearPreMigrationLayoutEvidence: (...args: unknown[]) => mocks.clearPreMigrationLayoutEvidence(...args),
    armPreMigrationEvidenceClear: (...args: unknown[]) => mocks.armPreMigrationEvidenceClear(...args),
    pruneOwnStaleLayoutEnvelope: (...args: unknown[]) => mocks.pruneOwnStaleLayoutEnvelope(...args),
  }
})

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

/** Seed a real, well-formed layout envelope under THIS window's per-window
 * key (the same shape layout-health.test.ts's healthyEnvelope uses, so the
 * REAL classifier parses it and runs its full validation pipeline).
 * `machineId` omitted from overrides = an UNSTAMPED legacy envelope. */
function seedLayoutEnvelope(overrides: { machineId?: string; persistedAt?: number } = {}): string {
  const persistedAt = overrides.persistedAt ?? Date.now()
  const envelope = {
    persistedAt,
    version: 4,
    ...(overrides.machineId !== undefined ? { machineId: overrides.machineId } : {}),
    tabs: {
      activeTabId: 'tab-a',
      tabs: [{ id: 'tab-a', title: 'A', createdAt: persistedAt, updatedAt: persistedAt }],
    },
    panes: {
      layouts: {
        'tab-a': {
          type: 'leaf',
          id: 'pane-a',
          content: { kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
        },
      },
      activePane: { 'tab-a': 'pane-a' },
      paneTitles: { 'tab-a': { 'pane-a': 'A notes' } },
      paneTitleSetByUser: { 'tab-a': { 'pane-a': true } },
    },
    tombstones: [],
  }
  const key = getWindowLayoutKey()
  localStorage.setItem(key, JSON.stringify(envelope))
  return key
}

/** Delegate the gate's classify/backfill mocks to the REAL implementations
 * (captured by the mock factory's importOriginal) with exact-args
 * passthrough, so the test observes the real classification and the real
 * stamp transition on the seeded envelope. */
function useRealLayoutHealth(): void {
  mocks.classifyPersistedLayoutHealth.mockImplementation(
    (...args: unknown[]) => (mocks.realLayoutHealth.classifyPersistedLayoutHealth as (...a: unknown[]) => unknown)(...args),
  )
  mocks.backfillPersistedLayoutMachineId.mockImplementation(
    (...args: unknown[]) => (mocks.realLayoutHealth.backfillPersistedLayoutMachineId as (...a: unknown[]) => unknown)(...args),
  )
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
    sessionStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token')
    cleanup()
    vi.clearAllMocks()
    mocks.onMessage.mockReturnValue(() => {})
    mocks.onReconnect.mockReturnValue(() => {})
    mocks.connect.mockResolvedValue(undefined)
    mocks.restoreMachineWorkspace.mockResolvedValue({ restoredTabs: 0 })
    mocks.classifyPersistedLayoutHealth.mockReturnValue('healthy')
    mocks.backfillPersistedLayoutMachineId.mockReturnValue(false)
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
    sessionStorage.clear()
  })

  it('shows the authentication prompt when bootstrap auth fails before machine selection', async () => {
    mocks.apiGet.mockRejectedValue({ status: 401 })
    mocks.getMachines.mockResolvedValue([])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => {
      expect(store.getState().connection.lastError).toBe('Authentication failed')
    })
    expect(screen.getByTestId('auth-required-modal')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Preparing this machine' })).not.toBeInTheDocument()
    expect(mocks.getMachines).not.toHaveBeenCalled()
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

    // The pick handler arms the one-shot active-selection marker. jsdom's
    // reload is a navigation no-op that logs "Not implemented" via
    // console.error, so allow that one notice for this test; without the
    // arming, a chooser-picked machine would lose the non-recoverable clear
    // on the reload it triggers and keep a foreign machine's stale cache.
    ;(globalThis as unknown as { __ALLOW_CONSOLE_ERROR__?: boolean }).__ALLOW_CONSOLE_ERROR__ = true
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`Use ${MACHINE.label}`) }))
    })
    expect(mocks.restoreMachineWorkspace).not.toHaveBeenCalled()
    expect(peekActiveMachineSelectionMark()).toBe(true)
    expect(localStorage.getItem(MACHINE_ID_STORAGE_KEY)).toBe(MACHINE.id)

    // The ADD handler arms the marker too: a machine created through the
    // chooser is just as active a choice as a picked existing one.
    sessionStorage.clear()
    mocks.createMachine.mockResolvedValue({ ...MACHINE, id: 'machine-added', label: 'ADDED' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add this machine' }))
    })
    expect(peekActiveMachineSelectionMark()).toBe(true)
    expect(localStorage.getItem(MACHINE_ID_STORAGE_KEY)).toBe('machine-added')
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
    mocks.classifyPersistedLayoutHealth.mockReturnValue('absent')
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason: 'absent' })
    // Merged wiring (#774 into the Choice B gate): the boot PEEKED the
    // (unarmed) marker and fed it to the classifier — a natural reload
    // (no active chooser pick) classifies with activeSelection:false and
    // keeps a healthy local layout instead of restoring.
    expect(mocks.classifyPersistedLayoutHealth).toHaveBeenCalledWith(MACHINE.id, { activeSelection: false })
    // CONSUMED after the successful adjudication: nothing stays armed for
    // later boots.
    expect(consumeActiveMachineSelectionMark()).toBe(false)
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

  it('keeps a healthy local workspace: no restore call, backfill stamps, straight to ready', async () => {
    mocks.classifyPersistedLayoutHealth.mockReturnValue('healthy')
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).not.toHaveBeenCalled()
    // classify FIRST, then backfill — the gate calls the backfill once with
    // the resolved machine id (after classification, before any rebuild):
    expect(mocks.classifyPersistedLayoutHealth).toHaveBeenCalledTimes(1)
    expect(mocks.classifyPersistedLayoutHealth).toHaveBeenCalledWith(MACHINE.id, { activeSelection: false })
    expect(mocks.classifyPersistedLayoutHealth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.backfillPersistedLayoutMachineId.mock.invocationCallOrder[0],
    )
    expect(mocks.backfillPersistedLayoutMachineId).toHaveBeenCalledTimes(1)
    expect(mocks.backfillPersistedLayoutMachineId).toHaveBeenCalledWith(MACHINE.id)
    // The decision completed here too — the deferred own-key prune runs on
    // every adjudicated boot (healthy-keep included); it no-ops on a fresh
    // envelope.
    expect(mocks.pruneOwnStaleLayoutEnvelope).toHaveBeenCalledTimes(1)
    // Consume-clear (e2r4 finding 1): a healthy-keep boot retires the
    // durable pre-migration evidence sidecar directly — the healthy
    // envelope is ALREADY the durable state, so no pending write can
    // strand the evidence. The durable-boundary arm is never used on a
    // healthy-keep boot.
    expect(mocks.clearPreMigrationLayoutEvidence).toHaveBeenCalledTimes(1)
    expect(mocks.armPreMigrationEvidenceClear).not.toHaveBeenCalled()
    expect(store.getState().machineIdentity.status).toBe('ready')
  })

  it('KEEPS a healthy UNSTAMPED local layout for an actively chosen machine — REAL classification, the same-machine re-pick keeps the legacy layout (delta r4)', async () => {
    // Delta r4 (review finding 1), rewritten per the reviewer's exact
    // note: the previous version mocked the classifier as 'healthy' and
    // only represented an already-stamped envelope, so it could not catch
    // the rule that contradicted the ACCEPTED REQUIREMENT (a chooser
    // re-pick of the SAME machine keeps a healthy local layout — no
    // forced server resync; the rebuild would discard the exact split
    // arrangement and pane labels). This pin now exercises REAL
    // classification against an UNSTAMPED healthy envelope with the
    // chooser's one-shot marker ARMED: an unstamped envelope cannot prove
    // machine ownership either way, so the armed marker alone must not
    // demote the healthy layout. The healthy-keep backfill then stamps
    // the envelope with the resolved machine id, ending the legacy
    // transition (the accepted residual — a different-machine pick during
    // that window also keeps, pre-upgrade-consistent, bounded to the
    // transition — is pinned in layout-health.test.ts).
    markActiveMachineSelection()
    useRealLayoutHealth()
    const layoutKey = seedLayoutEnvelope()
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
    expect(mocks.classifyPersistedLayoutHealth).toHaveBeenCalledWith(MACHINE.id, { activeSelection: true })
    expect(mocks.restoreMachineWorkspace).not.toHaveBeenCalled()
    // The healthy keep's backfill stamped the legacy envelope: the next
    // boot classifies unambiguously (stamped-own healthy).
    expect(JSON.parse(localStorage.getItem(layoutKey)!).machineId).toBe(MACHINE.id)
    expect(mocks.clearPreMigrationLayoutEvidence).toHaveBeenCalledTimes(1)
    expect(mocks.armPreMigrationEvidenceClear).not.toHaveBeenCalled()
    // The adjudication completed (healthy-keep): the one-shot marker is spent.
    expect(peekActiveMachineSelectionMark()).toBe(false)
    expect(store.getState().machineIdentity.status).toBe('ready')
  })

  it.each(['absent', 'corrupt', 'foreign', 'stale'] as const)(
    'rebuilds for an unhealthy layout (%s) and passes the health as the reason',
    async (reason) => {
      mocks.classifyPersistedLayoutHealth.mockReturnValue(reason)
      localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
      mocks.getMachines.mockResolvedValue([MACHINE])
      const store = createStore()

      render(<Provider store={store}><App /></Provider>)

      await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
      expect(mocks.restoreMachineWorkspace).toHaveBeenCalledTimes(1)
      expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason })
      // order pin: restore still precedes tab-registry sync on rebuild boots
      expect(mocks.restoreMachineWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.startTabRegistrySync.mock.invocationCallOrder[0],
      )
      // e3 post-cap finding 1: an unhealthy boot NEVER stamps the old
      // envelope — the backfill is healthy-only. The eager pre-recovery
      // stamp poisoned interrupted/failed rebuilds into next-boot
      // 'healthy'; the successful rebuild's own flush is the only stamper.
      expect(mocks.backfillPersistedLayoutMachineId).not.toHaveBeenCalled()
      // e2r5 finding 1: a completed rebuild ARMS the evidence clear — the
      // sidecar is never deleted at the Redux boundary. Persistence is
      // debounced 500ms and a failed write clears the dirty flags without
      // a durable write, so a reload inside that window (or a failed
      // write) would strand the sanitized old envelope with the evidence
      // gone; the persist middleware consumes the arm only on the rebuild's
      // own successful layout write. (No forced gate-time flush: it splits
      // the rebuild's persistence in two, and the mount-dirtied second
      // flush can clobber another page's newer write — pinned by
      // local-first-reload-rust.spec.ts scenario 3.)
      expect(mocks.armPreMigrationEvidenceClear).toHaveBeenCalledTimes(1)
      expect(mocks.clearPreMigrationLayoutEvidence).not.toHaveBeenCalled()
      expect(mocks.restoreMachineWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.armPreMigrationEvidenceClear.mock.invocationCallOrder[0],
      )
      // e3 post-cap finding 2: the decision completed, so the deferred
      // own-key prune runs (the migration-boot sweep left this window's
      // envelope for the classifier; the gate retires it after deciding).
      expect(mocks.pruneOwnStaleLayoutEnvelope).toHaveBeenCalledTimes(1)
      expect(mocks.restoreMachineWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.pruneOwnStaleLayoutEnvelope.mock.invocationCallOrder[0],
      )
    },
  )

  it('a real stale envelope classifies STALE (not absent) through the gate — the reason propagates and the deferred sweep retires it after the decision (e3 post-cap finding 2)', async () => {
    // Real-boot wiring pin with the REAL classifier: the migration-boot
    // prune sweep no longer deletes this window's beyond-threshold
    // envelope before the classifier runs (that ordering relabeled every
    // real stale boot 'absent'), so the gate sees the stale envelope,
    // rebuilds with the stale reason propagated, and only then runs the
    // deferred own-key prune.
    useRealLayoutHealth()
    seedLayoutEnvelope({ machineId: MACHINE.id, persistedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason: 'stale' })
    // classifier-then-prune: the prune runs only after the decision.
    expect(mocks.pruneOwnStaleLayoutEnvelope).toHaveBeenCalledTimes(1)
    expect(mocks.restoreMachineWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pruneOwnStaleLayoutEnvelope.mock.invocationCallOrder[0],
    )
  })

  it('peeks before the restore and consumes only after success — the marker stays armed through an in-flight reload', async () => {
    // The protocol's ORDERING pin, discriminated against the
    // consume-before-await implementation: while the restore (and its
    // inventory request) is IN FLIGHT the marker must still be ARMED — a
    // manual reload here carries the active-choice state into the next
    // boot. Only a COMPLETED adjudication consumes it (a later natural
    // reload boots with activeSelection:false). Merged wiring: the armed
    // marker plus no local layout classifies absent, so the boot rebuilds
    // from the server's truth with reason:'absent' (#774's actively-chosen
    // intent — an active choice never keeps a foreign cache).
    markActiveMachineSelection()
    mocks.classifyPersistedLayoutHealth.mockReturnValue('absent')
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    let resolveRestore: ((value: { restoredTabs: number }) => void) | undefined
    mocks.restoreMachineWorkspace.mockImplementationOnce(
      () => new Promise<{ restoredTabs: number }>((resolve) => { resolveRestore = resolve }),
    )
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    // In flight: called with the classified reason, marker still armed.
    await waitFor(() => expect(mocks.restoreMachineWorkspace).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason: 'absent' })
    expect(peekActiveMachineSelectionMark()).toBe(true)

    // Success consumes the marker.
    await act(async () => { resolveRestore?.({ restoredTabs: 1 }) })
    await waitFor(() => expect(mocks.startTabRegistrySync).toHaveBeenCalledTimes(1))
    expect(peekActiveMachineSelectionMark()).toBe(false)
  })

  it('a failed rebuild never stamps the old envelope — the marker stays armed and a fresh boot re-classifies the same reason, not healthy (delta r4 re-stage)', async () => {
    // The failure path rewritten against REAL classification and backfill.
    // Delta r4 re-stage: this test previously staged the rebuild through
    // the armed + UNSTAMPED + healthy lane (pre-fix 'foreign'), which the
    // delta-r4 classifier fix now KEEPS — the same-machine re-pick
    // requirement — so the staging moved to the STALE lane, the remaining
    // rebuild lane where an UNSTAMPED envelope still rebuilds. The pin's
    // substance is unchanged: a failing rebuild must leave the old
    // envelope UNSTAMPED (an eager pre-recovery stamp would hand the next
    // boot a stamped same-machine envelope) and the marker armed, so the
    // retry boot re-enters the same classification and rebuilds again.
    // The successful rebuild's own flush is the only stamper.
    markActiveMachineSelection()
    useRealLayoutHealth()
    const layoutKey = seedLayoutEnvelope({ persistedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    let rejectRestore: ((reason: unknown) => void) | undefined
    mocks.restoreMachineWorkspace.mockImplementationOnce(
      () => new Promise<{ restoredTabs: number }>((_, reject) => { rejectRestore = reject }),
    )
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.restoreMachineWorkspace).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason: 'stale' })
    await act(async () => { rejectRestore?.(new Error('inventory unavailable')) })
    await waitFor(() => expect(store.getState().machineIdentity?.status).toBe('error'))
    expect(mocks.startTabRegistrySync).not.toHaveBeenCalled()
    // The old envelope is NOT stamped with the newly selected machine id.
    expect(JSON.parse(localStorage.getItem(layoutKey)!).machineId).toBeUndefined()
    // Still armed for the retry — the failing boot never consumed it.
    expect(peekActiveMachineSelectionMark()).toBe(true)
    // A fresh boot re-classifies the envelope STALE and retries the
    // rebuild — the failed boot must not leave durable state that
    // mis-keeps on the retry (the machineId-undefined pin above is the
    // guard against any future stamper; the stamped-other variant of
    // that guard is pinned in the test above).
    expect(mocks.realLayoutHealth.classifyPersistedLayoutHealth(MACHINE.id, { activeSelection: peekActiveMachineSelectionMark() })).toBe('stale')
    // The post-decision own-key prune never ran: the decision did not
    // complete, so the evidence envelope survives for the retry boot.
    expect(mocks.pruneOwnStaleLayoutEnvelope).not.toHaveBeenCalled()
  })

  it('an old-machine-stamped envelope keeps its old stamp through a failed foreign-path rebuild — the retry boot still classifies foreign', async () => {
    // The foreign path's stamped variant: the stamp names a DIFFERENT
    // machine, so the envelope classifies foreign regardless of the
    // marker. A failed rebuild must not rewrite the stamp to the newly
    // selected machine (the eager backfill no-ops on stamped envelopes,
    // but the pin guards the whole gate against any future stamper).
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    useRealLayoutHealth()
    const layoutKey = seedLayoutEnvelope({ machineId: 'machine-OTHER' })
    mocks.getMachines.mockResolvedValue([MACHINE])
    mocks.restoreMachineWorkspace.mockRejectedValue(new Error('inventory fetch failed'))
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(store.getState().machineIdentity.status).toBe('error'))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason: 'foreign' })
    expect(JSON.parse(localStorage.getItem(layoutKey)!).machineId).toBe('machine-OTHER')
    expect(mocks.realLayoutHealth.classifyPersistedLayoutHealth(MACHINE.id)).toBe('foreign')
  })

  it('a reload while the recovery is in flight leaves the envelope unstamped and the marker armed — the next boot re-classifies the same reason (delta r4 re-stage)', async () => {
    // The reload-before-persist vector, as an in-flight interruption: the
    // restore (and its inventory request) never settles, exactly like a
    // page that dies mid-recovery. The envelope must still be unstamped
    // and the marker still armed, so the post-reload boot re-enters the
    // same classification and retries the rebuild.
    // Delta r4 re-stage: previously staged through the armed + UNSTAMPED +
    // healthy lane (pre-fix 'foreign'), which the delta-r4 classifier fix
    // now KEEPS; the staging moved to the STALE lane, preserving the
    // pin's substance — the interrupted recovery leaves durable state
    // that retries instead of mis-keeping.
    markActiveMachineSelection()
    useRealLayoutHealth()
    const layoutKey = seedLayoutEnvelope({ persistedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    mocks.restoreMachineWorkspace.mockImplementationOnce(
      () => new Promise<{ restoredTabs: number }>(() => {}),
    )
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(mocks.restoreMachineWorkspace).toHaveBeenCalledTimes(1))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledWith(store, MACHINE.id, { reason: 'stale' })
    expect(peekActiveMachineSelectionMark()).toBe(true)
    expect(JSON.parse(localStorage.getItem(layoutKey)!).machineId).toBeUndefined()
    expect(mocks.realLayoutHealth.classifyPersistedLayoutHealth(MACHINE.id, { activeSelection: peekActiveMachineSelectionMark() })).toBe('stale')
  })

  it('leaves the pre-migration evidence sidecar when the rebuild fails — the next boot retries with the corrupt raw intact (e2r4 finding 1)', async () => {
    mocks.classifyPersistedLayoutHealth.mockReturnValue('corrupt')
    mocks.restoreMachineWorkspace.mockRejectedValue(new Error('inventory fetch failed'))
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    mocks.getMachines.mockResolvedValue([MACHINE])
    const store = createStore()

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(store.getState().machineIdentity.status).toBe('error'))
    expect(mocks.restoreMachineWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.clearPreMigrationLayoutEvidence).not.toHaveBeenCalled()
    // e2r5 finding 1: a failed rebuild never arms the durable-boundary
    // clear either — the evidence must drive the next boot's retry.
    expect(mocks.armPreMigrationEvidenceClear).not.toHaveBeenCalled()
  })
})
