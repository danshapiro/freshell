import type { ComponentProps } from 'react'
import { cleanup, render } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, vi } from 'vitest'
import SettingsView from '@/components/SettingsView'
import settingsReducer, {
  defaultSettings,
  mergeSettings,
  type SettingsState,
} from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer, type NetworkState, type NetworkStatusResponse } from '@/store/networkSlice'
import tabRegistryReducer, { type TabRegistryState } from '@/store/tabRegistrySlice'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import type { AppSettings } from '@/store/types'
import type { DeepPartial } from '@/lib/type-utils'
import type { ClientExtensionEntry } from '@shared/extension-types'

type SettingsViewProps = ComponentProps<typeof SettingsView>

interface CreateSettingsViewStoreOptions {
  settings?: DeepPartial<AppSettings>
  settingsState?: Omit<Partial<SettingsState>, 'settings'>
  extraPreloadedState?: Record<string, unknown>
}

interface InstallSettingsViewHooksOptions {
  clearLocalStorage?: boolean
  fakeTimers?: boolean
  mockFonts?: boolean
}

let originalFonts: Document['fonts'] | undefined

const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude',
    version: '1.0.0',
    label: 'Claude CLI',
    description: '',
    category: 'cli',
    cli: {
      supportsPermissionMode: true,
      supportsResume: true,
      resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'],
    },
  },
  {
    name: 'codex',
    version: '1.0.0',
    label: 'Codex CLI',
    description: '',
    category: 'cli',
    cli: {
      supportsModel: true,
      supportsSandbox: true,
      supportsResume: true,
      resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'],
    },
  },
]

export function createSettings(overrides?: DeepPartial<AppSettings>): AppSettings {
  return overrides ? mergeSettings(defaultSettings, overrides) : defaultSettings
}

export function makeRegistryRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
  return {
    tabKey: 'remote-a:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-test',
    deviceId: 'remote-a',
    deviceLabel: 'studio-mac',
    tabName: 'work item',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

export function createTabRegistryState(overrides: Partial<TabRegistryState> = {}): TabRegistryState {
  return {
    ...(tabRegistryReducer(undefined, { type: '@@INIT' }) as TabRegistryState),
    deviceId: 'local-device',
    deviceLabel: 'local-device',
    localOpen: [],
    remoteOpen: [],
    closed: [],
    localClosed: {},
    loading: false,
    searchRangeDays: 30,
    ...overrides,
  }
}

export function createNetworkStatus(overrides: Partial<NetworkStatusResponse> = {}): NetworkStatusResponse {
  return {
    configured: true,
    host: '0.0.0.0',
    port: 3001,
    lanIps: ['192.168.1.100'],
    machineHostname: 'my-laptop',
    firewall: {
      platform: 'linux-none',
      active: false,
      portOpen: null,
      commands: [],
      configuring: false,
    },
    rebinding: false,
    devMode: false,
    accessUrl: 'http://192.168.1.100:3001/?token=abc',
    ...overrides,
  }
}

export function createNetworkState(overrides: Partial<NetworkState> = {}): NetworkState {
  return {
    status: null,
    loading: false,
    configuring: false,
    error: null,
    ...overrides,
  }
}

export function createSettingsViewStore(options: CreateSettingsViewStoreOptions = {}) {
  const { settings, settingsState, extraPreloadedState = {} } = options

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      extensions: extensionsReducer,
      network: networkReducer,
      tabRegistry: tabRegistryReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: createSettings(settings),
        loaded: true,
        lastSavedAt: undefined,
        ...settingsState,
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      tabRegistry: createTabRegistryState(),
      ...extraPreloadedState,
    },
  })
}

export type SettingsViewStore = ReturnType<typeof createSettingsViewStore>

export function renderSettingsView(store: SettingsViewStore, props: SettingsViewProps = {}) {
  return render(
    <Provider store={store}>
      <SettingsView {...props} />
    </Provider>,
  )
}

export function mockAvailableFonts(check: (font: string) => boolean = () => true) {
  Object.defineProperty(document, 'fonts', {
    value: {
      check: vi.fn(check),
      ready: Promise.resolve(),
    },
    configurable: true,
  })
}

// Keep SettingsView tests split by section-specific files so Vitest can
// parallelize future additions instead of growing a single hotspot.
export function installSettingsViewHooks(options: InstallSettingsViewHooksOptions = {}) {
  const {
    clearLocalStorage = true,
    fakeTimers = false,
    mockFonts = false,
  } = options

  beforeEach(() => {
    originalFonts = document.fonts
    if (mockFonts) {
      mockAvailableFonts()
    }
    if (clearLocalStorage) {
      localStorage.clear()
    }
    if (fakeTimers) {
      vi.useFakeTimers()
    } else {
      vi.useRealTimers()
    }
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    if (originalFonts) {
      Object.defineProperty(document, 'fonts', {
        value: originalFonts,
        configurable: true,
      })
    } else {
      // @ts-expect-error jsdom test cleanup for fonts override
      delete document.fonts
    }
  })
}
