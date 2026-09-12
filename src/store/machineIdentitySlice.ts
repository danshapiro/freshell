import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Machine } from '@/lib/machine-identity'

export type MachineIdentityMode = 'server-managed' | 'legacy'
export type MachineIdentityStatus = 'resolving' | 'choosing' | 'restoring' | 'ready' | 'error'

export interface MachineIdentityState {
  status: MachineIdentityStatus
  mode?: MachineIdentityMode
  selectedMachine?: Machine
  machines: Machine[]
  suggestedLabel?: string
  error?: string
}

const initialState: MachineIdentityState = {
  status: 'resolving',
  machines: [],
}

export const machineIdentitySlice = createSlice({
  name: 'machineIdentity',
  initialState,
  reducers: {
    setMachineChooser: (state, action: PayloadAction<{ machines: Machine[]; suggestedLabel: string }>) => {
      state.status = 'choosing'
      state.mode = 'server-managed'
      state.selectedMachine = undefined
      state.machines = action.payload.machines
      state.suggestedLabel = action.payload.suggestedLabel
      state.error = undefined
    },
    setMachineRestoring: (state, action: PayloadAction<Machine>) => {
      state.status = 'restoring'
      state.mode = 'server-managed'
      state.selectedMachine = action.payload
      state.error = undefined
    },
    setMachineReady: (state, action: PayloadAction<{ machine: Machine; mode: MachineIdentityMode }>) => {
      state.status = 'ready'
      state.mode = action.payload.mode
      state.selectedMachine = action.payload.machine
      state.error = undefined
    },
    setMachineResolutionError: (state, action: PayloadAction<string>) => {
      state.status = 'error'
      state.error = action.payload
    },
    updateSelectedMachine: (state, action: PayloadAction<Machine>) => {
      state.selectedMachine = action.payload
      state.machines = state.machines.map((machine) => (
        machine.id === action.payload.id ? action.payload : machine
      ))
    },
  },
})

export const {
  setMachineChooser,
  setMachineRestoring,
  setMachineReady,
  setMachineResolutionError,
  updateSelectedMachine,
} = machineIdentitySlice.actions

export default machineIdentitySlice.reducer
