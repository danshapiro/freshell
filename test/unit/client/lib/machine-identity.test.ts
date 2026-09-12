import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_DEVICE_ID_STORAGE_KEY,
  MACHINE_ID_STORAGE_KEY,
  MACHINE_SELECTIONS_STORAGE_KEY,
  clearSelectedMachineId,
  getBrowserMachineLabel,
  getSelectedMachineId,
  getSuggestedMachineLabel,
  persistSelectedMachineId,
  resolveMachineIdentity,
  type Machine,
} from '@/lib/machine-identity'

const WINDOWS_MACHINE: Machine = {
  id: 'machine-windows',
  label: 'Windows device 1',
  createdAt: 1_789_171_200_000,
  lastSeenAt: 1_789_171_200_000,
}

describe('machine identity', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    delete window.freshellDesktop
  })

  it('keeps a saved machine when the server recognizes it', async () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, WINDOWS_MACHINE.id)
    const createMachine = async () => {
      throw new Error('must not create a machine when the saved one is recognized')
    }

    const result = await resolveMachineIdentity({
      machines: [WINDOWS_MACHINE],
      createMachine,
      suggestedLabel: 'Windows device',
    })

    expect(result).toEqual({ kind: 'selected', machine: WINDOWS_MACHINE, source: 'saved' })
    expect(getSelectedMachineId()).toBe(WINDOWS_MACHINE.id)
  })

  it('migrates a recognized legacy device id without changing that id', async () => {
    localStorage.setItem(LEGACY_DEVICE_ID_STORAGE_KEY, 'legacy-device-id')
    const legacyMachine: Machine = { ...WINDOWS_MACHINE, id: 'legacy-device-id', label: 'DANDESKTOP' }

    const result = await resolveMachineIdentity({
      machines: [legacyMachine],
      createMachine: async () => {
        throw new Error('must not create a machine for a recognized legacy id')
      },
      suggestedLabel: 'Windows device',
      serverInstanceId: 'srv-50',
    })

    expect(result).toEqual({ kind: 'selected', machine: legacyMachine, source: 'legacy' })
    expect(localStorage.getItem(MACHINE_ID_STORAGE_KEY)).toBe('legacy-device-id')
    expect(localStorage.getItem(LEGACY_DEVICE_ID_STORAGE_KEY)).toBe('legacy-device-id')
    expect(JSON.parse(localStorage.getItem(MACHINE_SELECTIONS_STORAGE_KEY) || '{}')).toEqual({
      'srv-50': 'legacy-device-id',
    })
  })

  it('migrates a recognized legacy id when a stale selection belongs to another server', async () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-from-another-server')
    localStorage.setItem(LEGACY_DEVICE_ID_STORAGE_KEY, 'legacy-device-id')
    const legacyMachine: Machine = { ...WINDOWS_MACHINE, id: 'legacy-device-id', label: 'DANDESKTOP' }

    const result = await resolveMachineIdentity({
      machines: [legacyMachine],
      createMachine: async () => {
        throw new Error('must not create a machine for a recognized legacy id')
      },
      suggestedLabel: 'Windows device',
    })

    expect(result).toEqual({ kind: 'selected', machine: legacyMachine, source: 'legacy' })
    expect(getSelectedMachineId()).toBe('legacy-device-id')
  })

  it('creates and saves a machine automatically only when the server has no machines', async () => {
    const createMachine = async (label: string) => ({ ...WINDOWS_MACHINE, label })

    const result = await resolveMachineIdentity({
      machines: [],
      createMachine,
      suggestedLabel: 'Windows device',
    })

    expect(result).toEqual({
      kind: 'selected',
      machine: { ...WINDOWS_MACHINE, label: 'Windows device' },
      source: 'created',
    })
    expect(getSelectedMachineId()).toBe(WINDOWS_MACHINE.id)
  })

  it('requires an explicit choice instead of auto-creating beside existing machines', async () => {
    let created = false

    const result = await resolveMachineIdentity({
      machines: [WINDOWS_MACHINE],
      createMachine: async () => {
        created = true
        return WINDOWS_MACHINE
      },
      suggestedLabel: 'Windows device',
    })

    expect(result).toEqual({
      kind: 'chooser',
      machines: [WINDOWS_MACHINE],
      suggestedLabel: 'Windows device',
    })
    expect(created).toBe(false)
    expect(getSelectedMachineId()).toBeUndefined()
  })

  it('does not let a retained legacy id override an explicit Switch machine choice', async () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, WINDOWS_MACHINE.id)
    localStorage.setItem(LEGACY_DEVICE_ID_STORAGE_KEY, WINDOWS_MACHINE.id)

    clearSelectedMachineId()

    const result = await resolveMachineIdentity({
      machines: [WINDOWS_MACHINE],
      createMachine: async () => {
        throw new Error('must not auto-create while choosing an existing machine')
      },
      suggestedLabel: 'Windows device',
    })

    expect(result).toEqual({
      kind: 'chooser',
      machines: [WINDOWS_MACHINE],
      suggestedLabel: 'Windows device',
    })
  })

  it('uses only broad browser platform labels, never a server hostname', () => {
    expect(getBrowserMachineLabel({ platform: 'Win32', userAgent: 'Mozilla/5.0' })).toBe('Windows device 1')
    expect(getBrowserMachineLabel({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15)' })).toBe('Android device 1')
    expect(getBrowserMachineLabel({ platform: 'MacIntel', userAgent: 'Mozilla/5.0' })).toBe('macOS device 1')
    expect(getBrowserMachineLabel({ platform: '', userAgent: '' })).toBe('Browser device 1')
  })

  it('uses the local Electron hostname through the narrow preload API', async () => {
    const getHostname = vi.fn().mockResolvedValue('DANDESKTOP')
    window.freshellDesktop = { getHostname }

    await expect(getSuggestedMachineLabel()).resolves.toBe('DANDESKTOP')
    expect(getHostname).toHaveBeenCalledTimes(1)
  })

  it('keeps server-instance selections separate until Switch machine clears every saved selection', () => {
    persistSelectedMachineId('machine-a', 'srv-a')
    persistSelectedMachineId('machine-b', 'srv-b')

    expect(getSelectedMachineId('srv-a')).toBe('machine-a')
    expect(getSelectedMachineId('srv-b')).toBe('machine-b')
    expect(getSelectedMachineId()).toBe('machine-b')

    clearSelectedMachineId()
    expect(getSelectedMachineId()).toBeUndefined()
    expect(getSelectedMachineId('srv-a')).toBeUndefined()
    expect(localStorage.getItem(MACHINE_SELECTIONS_STORAGE_KEY)).toBeNull()
  })
})
