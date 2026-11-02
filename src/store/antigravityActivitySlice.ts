import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AntigravityActivityRecord } from '@shared/ws-protocol'

// Antigravity plan Task 8: the amplifier activity slice's additive twin —
// same snapshot/upsert/removal seq discipline (a late list snapshot must
// never resurrect a record a newer live mutation removed, and a newer live
// mutation must never be clobbered by a stale snapshot).
//
// Whole-delta review round 5, Major 1: unlike the amplifier twin, the
// antigravity upsert gate orders by `mutationSeq`, never `updatedAt`. The
// antigravity wire's `updatedAt` is TWO-CLOCK by design — provisional
// busy carries the registry's submit stamp while settled idle carries
// the CLI record's own `at`, which the locator's backward tolerance
// (ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS) lets land BEFORE the
// submit stamp — so a later mutation can legitimately carry an EARLIER
// timestamp. `mutationSeq` is the ingestion counter (one shared
// strictly-increasing sequence with snapshot request seqs, minted at
// frame arrival in App.tsx) and is the only safe ordering key;
// `updatedAt` stays on the record for display/derived purposes only.
export type AntigravityActivityState = {
  byTerminalId: Record<string, AntigravityActivityRecord>
  lastSnapshotSeq: number
  liveMutationSeqByTerminalId: Record<string, number>
  removedMutationSeqByTerminalId: Record<string, number>
}

type AntigravityActivitySnapshotPayload = {
  terminals: AntigravityActivityRecord[]
  requestSeq?: number
}

type AntigravityActivityUpsertPayload = {
  terminals: AntigravityActivityRecord[]
  mutationSeq?: number
}

type AntigravityActivityRemovalPayload = {
  terminalIds: string[]
  mutationSeq?: number
}

function createInitialState(): AntigravityActivityState {
  return {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }
}

const initialState: AntigravityActivityState = createInitialState()

const antigravityActivitySlice = createSlice({
  name: 'antigravityActivity',
  initialState,
  reducers: {
    setAntigravityActivitySnapshot(state, action: PayloadAction<AntigravityActivitySnapshotPayload>) {
      const requestSeq = action.payload.requestSeq ?? 0
      if (requestSeq < state.lastSnapshotSeq) {
        return
      }
      const next: Record<string, AntigravityActivityRecord> = {}
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

    upsertAntigravityActivity(state, action: PayloadAction<AntigravityActivityUpsertPayload>) {
      const mutationSeq = action.payload.mutationSeq ?? 0
      for (const record of action.payload.terminals) {
        const removedMutationSeq = state.removedMutationSeqByTerminalId[record.terminalId] ?? 0
        if (removedMutationSeq > mutationSeq) continue

        const existing = state.byTerminalId[record.terminalId]
        // The current record's ingestion seq: the live mutation that last
        // ingested it, or — for a snapshot-sourced record — the seq of
        // the snapshot it came from (the same counter). mutationSeq is
        // authoritative: later seq always ingests, older seq is ignored
        // (see the slice header for why updatedAt can move backwards on
        // a newer mutation and must never gate ingestion).
        const existingSeq =
          state.liveMutationSeqByTerminalId[record.terminalId] ?? state.lastSnapshotSeq
        if (!existing || mutationSeq >= existingSeq) {
          state.byTerminalId[record.terminalId] = record
          state.liveMutationSeqByTerminalId[record.terminalId] = mutationSeq
          delete state.removedMutationSeqByTerminalId[record.terminalId]
        }
      }
    },

    removeAntigravityActivity(state, action: PayloadAction<AntigravityActivityRemovalPayload>) {
      const mutationSeq = action.payload.mutationSeq ?? 0
      for (const terminalId of action.payload.terminalIds) {
        delete state.byTerminalId[terminalId]
        delete state.liveMutationSeqByTerminalId[terminalId]
        if ((state.removedMutationSeqByTerminalId[terminalId] ?? 0) < mutationSeq) {
          state.removedMutationSeqByTerminalId[terminalId] = mutationSeq
        }
      }
    },

    resetAntigravityActivity() {
      return createInitialState()
    },
  },
})

export const {
  setAntigravityActivitySnapshot,
  upsertAntigravityActivity,
  removeAntigravityActivity,
  resetAntigravityActivity,
} = antigravityActivitySlice.actions

export default antigravityActivitySlice.reducer
