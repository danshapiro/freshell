import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import { networkReducer } from '@/store/networkSlice'
import tabRegistryReducer, { type TabRegistryState } from '@/store/tabRegistrySlice'
import { DEVICE_DISMISSED_STORAGE_KEY } from '@/store/storage-keys'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

function makeRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
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

function createTabRegistryState(overrides: Partial<TabRegistryState> = {}): TabRegistryState {
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

function createStore(tabRegistryState: Partial<TabRegistryState> = {}) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
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
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: undefined,
      },
      tabRegistry: createTabRegistryState(tabRegistryState),
    },
  })
}

describe('settings devices management flow (e2e)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('collapses duplicate machine rows, deletes a remote device, and renders Devices last', async () => {
    const store = createStore({
      remoteOpen: [
        makeRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
      ],
      closed: [
        makeRecord({
          deviceId: 'remote-b',
          deviceLabel: 'studio-mac',
          tabKey: 'remote-b:tab-2',
          tabId: 'tab-2',
          status: 'closed',
          closedAt: 5,
          updatedAt: 5,
        }),
      ],
    })

    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>,
    )

    expect(screen.getAllByLabelText('Device name for studio-mac')).toHaveLength(1)

    const devicesHeading = screen.getByText('Devices')
    const networkHeading = screen.getByText('Network Access')
    expect(devicesHeading.compareDocumentPosition(networkHeading) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete device studio-mac' }))

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByLabelText('Device name for studio-mac')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(DEVICE_DISMISSED_STORAGE_KEY) || '[]').sort()).toEqual(['remote-a', 'remote-b'])
  })
})
