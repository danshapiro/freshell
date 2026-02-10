import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { CodingCliProviderName } from './types'

export type TerminalTokenUsage = {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  contextTokens?: number
  modelContextWindow?: number
  compactThresholdTokens?: number
  compactPercent?: number
}

export type TerminalMetaRecord = {
  terminalId: string
  cwd?: string
  checkoutRoot?: string
  repoRoot?: string
  displaySubdir?: string
  branch?: string
  isDirty?: boolean
  provider?: CodingCliProviderName
  sessionId?: string
  tokenUsage?: TerminalTokenUsage
  updatedAt: number
}

export type TerminalMetaState = {
  byTerminalId: Record<string, TerminalMetaRecord>
}

type TerminalMetaSnapshotPayload = {
  terminals: TerminalMetaRecord[]
  requestedAt?: number
}

const initialState: TerminalMetaState = {
  byTerminalId: {},
}

const terminalMetaSlice = createSlice({
  name: 'terminalMeta',
  initialState,
  reducers: {
    setTerminalMetaSnapshot(state, action: PayloadAction<TerminalMetaSnapshotPayload>) {
      const requestedAt = action.payload.requestedAt ?? 0
      const next: Record<string, TerminalMetaRecord> = {}
      const incomingIds = new Set<string>()

      for (const record of action.payload.terminals) {
        next[record.terminalId] = record
        incomingIds.add(record.terminalId)
      }

      for (const [terminalId, existing] of Object.entries(state.byTerminalId)) {
        if (incomingIds.has(terminalId)) continue
        // Keep local updates that arrived after this snapshot request started.
        if (existing.updatedAt > requestedAt) {
          next[terminalId] = existing
        }
      }

      state.byTerminalId = next
    },
    upsertTerminalMeta(state, action: PayloadAction<TerminalMetaRecord[]>) {
      for (const record of action.payload) {
        state.byTerminalId[record.terminalId] = record
      }
    },
    removeTerminalMeta(state, action: PayloadAction<string>) {
      delete state.byTerminalId[action.payload]
    },
  },
})

export const {
  setTerminalMetaSnapshot,
  upsertTerminalMeta,
  removeTerminalMeta,
} = terminalMetaSlice.actions

export default terminalMetaSlice.reducer
