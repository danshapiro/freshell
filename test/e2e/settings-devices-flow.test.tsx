import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import { networkReducer } from '@/store/networkSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import machineIdentityReducer, { setMachineReady } from '@/store/machineIdentitySlice'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

const renameMachine = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  renameMachine: (...args: unknown[]) => renameMachine(...args),
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

const MACHINE = {
  id: 'machine-desktop',
  label: 'DANDESKTOP',
  createdAt: 1_789_171_200_000,
  lastSeenAt: 1_789_171_200_000,
}

function createStore() {
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = resolveLocalSettings()
  const store = configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      network: networkReducer,
      tabRegistry: tabRegistryReducer,
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
    },
  })
  store.dispatch(setMachineReady({ machine: MACHINE, mode: 'server-managed' }))
  return store
}

describe('settings machine management flow (e2e)', () => {
  beforeEach(() => {
    localStorage.clear()
    renameMachine.mockReset()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('renames the selected machine and exposes the switch control through Settings', async () => {
    renameMachine.mockResolvedValue({ ...MACHINE, label: 'Dan desktop' })
    const store = createStore()

    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('tab', { name: /^advanced$/i }))
    expect(screen.getByRole('heading', { name: 'Machine' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Machine name' }), {
      target: { value: 'Dan desktop' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rename machine' }))

    await waitFor(() => {
      expect(renameMachine).toHaveBeenCalledWith(MACHINE.id, 'Dan desktop')
    })
    expect(store.getState().machineIdentity.selectedMachine?.label).toBe('Dan desktop')
    expect(screen.getByRole('button', { name: 'Switch machine' })).toBeInTheDocument()
  })
})
