import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AmplifierActivityRecord } from '@shared/ws-protocol'

export type AmplifierActivityState = {
  byTerminalId: Record<string, AmplifierActivityRecord>
  lastSnapshotSeq: number
  liveMutationSeqByTerminalId: Record<string, number>
  removedMutationSeqByTerminalId: Record<string, number>
}

type AmplifierActivitySnapshotPayload = {
  terminals: AmplifierActivityRecord[]
  requestSeq?: number
}

type AmplifierActivityUpsertPayload = {
  terminals: AmplifierActivityRecord[]
  mutationSeq?: number
}

type AmplifierActivityRemovalPayload = {
  terminalIds: string[]
  mutationSeq?: number
}

function createInitialState(): AmplifierActivityState {
  return {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }
}

const initialState: AmplifierActivityState = createInitialState()

const amplifierActivitySlice = createSlice({
  name: 'amplifierActivity',
  initialState,
  reducers: {
    setAmplifierActivitySnapshot(state, action: PayloadAction<AmplifierActivitySnapshotPayload>) {
      const requestSeq = action.payload.requestSeq ?? 0
      if (requestSeq < state.lastSnapshotSeq) {
        return
      }
      const next: Record<string, AmplifierActivityRecord> = {}
      const nextLiveMutationSeqByTerminalId: Record<string, number> = {}
      const incomingIds = new Set<string>()

      for (const record of action.payload.terminals) {
        const removedMutationSeq = state.removedMutationSeqByTerminalId[record.terminalId] ?? 0
        if (removedMutationSeq > requestSeq) continue
        const liveMutationSeq = state.liveMutationSeqByTerminalId[record.terminalId] ?? 0
        const existing = state.byTerminalId[record.terminalId]
        if (liveMutationSeq > requestSeq && existing) {
          next[record.terminalId] = existing
          nextLiveMutationSeqByTerminalId[record.terminalId] = liveMutationSeq
          incomingIds.add(record.terminalId)
          continue
        }
        next[record.terminalId] = record
        incomingIds.add(record.terminalId)
      }

      for (const [terminalId, existing] of Object.entries(state.byTerminalId)) {
        if (incomingIds.has(terminalId)) continue
        const liveMutationSeq = state.liveMutationSeqByTerminalId[terminalId] ?? 0
        if (liveMutationSeq > requestSeq) {
          next[terminalId] = existing
          nextLiveMutationSeqByTerminalId[terminalId] = liveMutationSeq
        }
      }

      const nextRemovedMutationSeqByTerminalId: Record<string, number> = {}
      for (const [terminalId, removedMutationSeq] of Object.entries(state.removedMutationSeqByTerminalId)) {
        if (removedMutationSeq > requestSeq && !next[terminalId]) {
          nextRemovedMutationSeqByTerminalId[terminalId] = removedMutationSeq
        }
      }

      state.byTerminalId = next
      state.lastSnapshotSeq = requestSeq
      state.liveMutationSeqByTerminalId = nextLiveMutationSeqByTerminalId
      state.removedMutationSeqByTerminalId = nextRemovedMutationSeqByTerminalId
    },

    upsertAmplifierActivity(state, action: PayloadAction<AmplifierActivityUpsertPayload>) {
      const mutationSeq = action.payload.mutationSeq ?? 0
      for (const record of action.payload.terminals) {
        const removedMutationSeq = state.removedMutationSeqByTerminalId[record.terminalId] ?? 0
        if (removedMutationSeq > mutationSeq) continue

        const existing = state.byTerminalId[record.terminalId]
        if (!existing || record.updatedAt >= existing.updatedAt) {
          state.byTerminalId[record.terminalId] = record
          state.liveMutationSeqByTerminalId[record.terminalId] = mutationSeq
          delete state.removedMutationSeqByTerminalId[record.terminalId]
        }
      }
    },

    removeAmplifierActivity(state, action: PayloadAction<AmplifierActivityRemovalPayload>) {
      const mutationSeq = action.payload.mutationSeq ?? 0
      for (const terminalId of action.payload.terminalIds) {
        delete state.byTerminalId[terminalId]
        delete state.liveMutationSeqByTerminalId[terminalId]
        if ((state.removedMutationSeqByTerminalId[terminalId] ?? 0) < mutationSeq) {
          state.removedMutationSeqByTerminalId[terminalId] = mutationSeq
        }
      }
    },

    resetAmplifierActivity() {
      return createInitialState()
    },
  },
})

export const {
  setAmplifierActivitySnapshot,
  upsertAmplifierActivity,
  removeAmplifierActivity,
  resetAmplifierActivity,
} = amplifierActivitySlice.actions

export default amplifierActivitySlice.reducer
