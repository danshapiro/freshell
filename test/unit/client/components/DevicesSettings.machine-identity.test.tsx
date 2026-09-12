import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import DevicesSettings from '@/components/settings/DevicesSettings'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import machineIdentityReducer, { setMachineReady } from '@/store/machineIdentitySlice'
import { MACHINE_ID_STORAGE_KEY } from '@/lib/machine-identity'

const renameMachine = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  renameMachine: (...args: unknown[]) => renameMachine(...args),
}))

const MACHINE = {
  id: 'machine-desktop',
  label: 'DANDESKTOP',
  createdAt: 1_789_171_200_000,
  lastSeenAt: 1_789_171_200_000,
}

let originalLocation: Location
let reloadPage: ReturnType<typeof vi.fn>

function createStore() {
  const store = configureStore({
    reducer: {
      tabRegistry: tabRegistryReducer,
      machineIdentity: machineIdentityReducer,
    },
  })
  store.dispatch(setMachineReady({ machine: MACHINE, mode: 'server-managed' }))
  return store
}

describe('DevicesSettings machine controls', () => {
  beforeEach(() => {
    localStorage.clear()
    renameMachine.mockReset()
    originalLocation = window.location
    reloadPage = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadPage },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('renames the selected machine through the server and keeps its canonical label on the wire', async () => {
    renameMachine.mockResolvedValue({ ...MACHINE, label: 'Dan desktop' })
    const store = createStore()

    render(<Provider store={store}><DevicesSettings /></Provider>)

    expect(screen.getByRole('heading', { name: 'Machine' })).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Machine name' })
    fireEvent.change(input, { target: { value: 'Dan desktop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename machine' }))

    await waitFor(() => {
      expect(renameMachine).toHaveBeenCalledWith(MACHINE.id, 'Dan desktop')
    })
    expect(store.getState().machineIdentity.selectedMachine?.label).toBe('Dan desktop')
    expect(store.getState().tabRegistry).toMatchObject({
      deviceId: MACHINE.id,
      deviceLabel: 'Dan desktop',
    })
  })

  it('offers an accessible switch control and clears the current server selection before reloading', () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, MACHINE.id)
    const store = createStore()

    render(<Provider store={store}><DevicesSettings /></Provider>)

    fireEvent.click(screen.getByRole('button', { name: 'Switch machine' }))
    expect(localStorage.getItem(MACHINE_ID_STORAGE_KEY)).toBeNull()
    expect(reloadPage).toHaveBeenCalledTimes(1)
  })
})
