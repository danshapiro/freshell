import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type IdleWarning = {
  terminalId: string
  receivedAt: number
  killMinutes: number
  warnMinutes: number
  lastActivityAt?: number
}

type State = {
  warnings: Record<string, IdleWarning>
}

const initialState: State = {
  warnings: {},
}

export const idleWarningsSlice = createSlice({
  name: 'idleWarnings',
  initialState,
  reducers: {
    recordIdleWarning: (state, action: PayloadAction<Omit<IdleWarning, 'receivedAt'>>) => {
      state.warnings[action.payload.terminalId] = {
        ...action.payload,
        receivedAt: Date.now(),
      }
    },
    clearIdleWarning: (state, action: PayloadAction<string>) => {
      delete state.warnings[action.payload]
    },
    clearAllIdleWarnings: (state) => {
      state.warnings = {}
    },
  },
})

export const { recordIdleWarning, clearIdleWarning, clearAllIdleWarnings } = idleWarningsSlice.actions

export default idleWarningsSlice.reducer

