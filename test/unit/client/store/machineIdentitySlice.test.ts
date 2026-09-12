import { describe, expect, it } from 'vitest'
import reducer, {
  setMachineChooser,
  setMachineReady,
  setMachineResolutionError,
  setMachineRestoring,
  updateSelectedMachine,
} from '@/store/machineIdentitySlice'

const MACHINE = {
  id: 'machine-desktop',
  label: 'DANDESKTOP',
  createdAt: 1_789_171_200_000,
  lastSeenAt: 1_789_171_200_000,
}

describe('machineIdentitySlice', () => {
  it('starts gated and moves from chooser through scoped restoration to ready', () => {
    let state = reducer(undefined, { type: '@@INIT' })
    expect(state.status).toBe('resolving')

    state = reducer(state, setMachineChooser({ machines: [MACHINE], suggestedLabel: 'Windows device' }))
    expect(state).toMatchObject({ status: 'choosing', mode: 'server-managed', machines: [MACHINE] })

    state = reducer(state, setMachineRestoring(MACHINE))
    expect(state).toMatchObject({ status: 'restoring', selectedMachine: MACHINE })

    state = reducer(state, setMachineReady({ machine: MACHINE, mode: 'server-managed' }))
    expect(state).toMatchObject({ status: 'ready', mode: 'server-managed', selectedMachine: MACHINE })
  })

  it('keeps the canonical server label after a rename response', () => {
    let state = reducer(undefined, setMachineReady({ machine: MACHINE, mode: 'server-managed' }))
    state = reducer(state, updateSelectedMachine({ ...MACHINE, label: 'Dan desktop' }))

    expect(state.selectedMachine?.label).toBe('Dan desktop')
  })

  it('holds the transport gate closed on a resolution error', () => {
    const state = reducer(undefined, setMachineResolutionError('Could not reach machines'))
    expect(state).toMatchObject({ status: 'error', error: 'Could not reach machines' })
  })
})
