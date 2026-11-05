import { describe, expect, it } from 'vitest'
import { applyFreshAgentTranscriptPatch, bindTranscriptProjection, hydrateTranscriptProjection, mergeFreshAgentTranscriptProjection, type TranscriptProjection } from '@/lib/fresh-agent-transcript-projection'
import { FreshAgentSnapshotSchema } from '@shared/fresh-agent-contract'

const row = { id: 't', turnId: 't', role: 'assistant' as const, summary: '', items: [{ id: 'a', kind: 'text' as const, text: '' }] }
const patch = (ops: unknown[], projectionId = 'p') => ({ sessionId: 'thread', projectionId, historyGeneration: 0, ops })
const opened = (): TranscriptProjection => applyFreshAgentTranscriptPatch({ id: 'p', eventRevision: 0, historyGeneration: 0, turns: [] }, patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [row], revision: 1 }]))
const read = (turns: unknown[], projection: Record<string, unknown> = {}) => FreshAgentSnapshotSchema.parse({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread', revision: 0, status: 'running', capabilities: { send: false, interrupt: true, approvals: false, questions: false, fork: false }, tokenUsage: {inputTokens: 0, outputTokens: 0, totalTokens: 0}, turns, extensions: { codex: { projection: { id: 'p', historyGeneration: 0, eventRevision: 0, eventOwnedTurnIds: [], nativeFinalTurnIds: [], nativePreviewTurnIds: [], turnOutputStates: {}, turnRows: { t: turns.map((t: any) => t.turnId) }, ...projection } } } })
const append = (text: string, revision: number) => ({ op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'a', field: 'text', text, revision })
const failedRows = [
  { ...row, id: 't:row-0', turnId: 't:row-0', items: [{ id: 'a', kind: 'text' as const, text: 'partial output' }] },
  { ...row, id: 't:row-1', turnId: 't:row-1', items: [], error: { name: 'CodexError', message: 'Provider is at capacity' } },
]

describe('independent native reads and event bodies', () => {
  it('shows deltas before completion and replaces the complete item exactly once', () => {
    let live = opened()
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'a', field: 'text', text: 'Hel', revision: 2 }]))
    expect(live.turns[0]?.items).toEqual([{ id: 'a', kind: 'text', text: 'Hel' }])
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'upsertItem', nativeTurnId: 't', row, item: { id: 'a', kind: 'text', text: 'Hello' }, complete: true, revision: 3 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'a', field: 'text', text: 'lo', revision: 4 }]))
    expect(live.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
  })

  it('does not adopt a projection incarnation from an arbitrary patch', () => {
    const live = opened()
    expect(applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'other', turns: [row], revision: 100 }], 'foreign'))).toEqual(live)
  })

  it('renders an event-owned turn missing from a behind snapshot', () => {
    const snapshot = FreshAgentSnapshotSchema.parse({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread', revision: 0, status: 'running', capabilities: { send: false, interrupt: true, approvals: false, questions: false, fork: false }, tokenUsage: {inputTokens: 0, outputTokens: 0, totalTokens: 0}, turns: [], extensions: { codex: { projection: { id: 'p', historyGeneration: 0, eventRevision: 0, eventOwnedTurnIds: [], nativeFinalTurnIds: [], nativePreviewTurnIds: [], turnOutputStates: {} } } } })
    expect(mergeFreshAgentTranscriptProjection(snapshot, opened())).toHaveLength(1)
  })

  it('keeps a read-ahead preview separate from the event append baseline', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([append('Hel', 2)]))
    const snapshot = read([{ ...row, items: [{ id: 'a', kind: 'text', text: 'Hello' }] }], { nativePreviewTurnIds: ['t'] })
    expect(mergeFreshAgentTranscriptProjection(snapshot, live)[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
    live = applyFreshAgentTranscriptPatch(live, patch([append('lo', 3)]))
    expect(live.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
    expect(mergeFreshAgentTranscriptProjection(snapshot, live)).toHaveLength(1)
  })

  it('does not lose a newer delta to an event-owned behind read', () => {
    const live = applyFreshAgentTranscriptPatch(opened(), patch([append('Hel', 2)]))
    const snapshot = read([row], { eventOwnedTurnIds: ['t'], eventRevision: 1 })
    expect(mergeFreshAgentTranscriptProjection(snapshot, live)[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hel' }])
  })

  it('replaces an entire split native group without comparing coincidental item ids or deduplicating repeated bodies', () => {
    const live = applyFreshAgentTranscriptPatch(opened(), patch([append('stale', 2)]))
    const rows = [{ ...row, id: 't:row-0', turnId: 't:row-0', role: 'user', nativeTurnId: 't', items: [{ id: 'item-1', kind: 'text', text: 'same' }] }, { ...row, id: 't:row-1', turnId: 't:row-1', items: [{ id: 'item-2', kind: 'text', text: 'same' }, { id: 'item-3', kind: 'text', text: 'same' }] }]
    const snapshot = read(rows, { nativeFinalTurnIds: ['t'] })
    expect(mergeFreshAgentTranscriptProjection(snapshot, live)).toEqual(snapshot.turns)
  })

  it('rejects late item appends after completion even after eight subsequent turns', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'settleTurn', nativeTurnId: 't', revision: 2 }]))
    for (let i = 0; i < 9; i++) live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: `new-${i}`, turns: [{ ...row, id: `new-${i}`, turnId: `new-${i}` }], revision: i + 3 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([append('late', 12)]))
    expect(live.turns[0].items).toEqual(row.items)
  })

  it('corrects only a settled turn and keeps later ordinary updates fenced', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'settleTurn', nativeTurnId: 't', status: 'interrupted', revision: 2 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'later', turns: [{ ...row, id: 'later', turnId: 'later' }], revision: 3 }]))
    const correction = { op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 4 }
    live = applyFreshAgentTranscriptPatch(live, patch([correction]))
    expect(live.turns.map(turn => turn.turnId)).toEqual(['t:row-0', 't:row-1', 'later'])
    expect(live.turns[1].error?.message).toBe('Provider is at capacity')
    expect(live.settledTurns?.t).toBe(true)

    live = applyFreshAgentTranscriptPatch(live, patch([correction])) // duplicate revision
    live = applyFreshAgentTranscriptPatch(live, patch([
      { op: 'appendItem', nativeTurnId: 't', rowId: 't:row-0', itemId: 'a', field: 'text', text: 'late', revision: 5 },
      { op: 'resetTurn', nativeTurnId: 't', turns: [row], revision: 6 },
    ]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ ...correction, revision: 7 }])) // repeated delivery is idempotent
    expect(live.turns.map(turn => turn.turnId)).toEqual(['t:row-0', 't:row-1', 'later'])
    expect(live.turns[0].items[0]).toMatchObject({ text: 'partial output' })
  })

  it('corrects an itemless turn, whether or not the client observed its settlement', () => {
    const itemless = { ...row, id: 'itemless', turnId: 'itemless', items: [], error: { name: 'CodexError', message: 'Provider failed' } }
    for (const observedSettlement of [false, true]) {
      let live: TranscriptProjection = { id: 'p', eventRevision: 0, historyGeneration: 0, turns: [] }
      if (observedSettlement) live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'settleTurn', nativeTurnId: 'itemless', status: 'interrupted', revision: 1 }]))
      live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'itemless', correctSettled: true, turns: [itemless], revision: 2 }]))
      expect(live.turns).toEqual([itemless])
      expect(live.settledTurns?.itemless).toBe(true)
      live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'itemless', turns: [row], revision: 3 }]))
      expect(live.turns).toEqual([itemless])
    }
  })

  it('places an itemless correction before a later turn when its original order is known', () => {
    let live: TranscriptProjection = { id: 'p', eventRevision: 0, historyGeneration: 0, turns: [] }
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'settleTurn', nativeTurnId: 'itemless', status: 'interrupted', revision: 1 }]))
    const later = { ...row, id: 'later', turnId: 'later' }
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'later', turns: [later], revision: 2 }]))
    const failure = { ...row, id: 'itemless', turnId: 'itemless', items: [], error: { name: 'CodexError', message: 'Provider failed' } }
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'itemless', correctSettled: true, turns: [failure], revision: 3 }]))
    expect(live.turns.map((turn) => turn.turnId)).toEqual(['itemless', 'later'])

    const older = read([later], { nativeFinalTurnIds: ['itemless'], eventRevision: 2, turnRows: { itemless: [], later: ['later'] } })
    expect(mergeFreshAgentTranscriptProjection(older, live).map((turn) => turn.turnId)).toEqual(['itemless', 'later'])
  })

  it('cannot correct a removed, trimmed, foreign, or older-generation turn', () => {
    const correction = { op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 100 }
    const active = opened()
    const settled = applyFreshAgentTranscriptPatch(active, patch([{ op: 'settleTurn', nativeTurnId: 't', revision: 2 }]))
    expect(applyFreshAgentTranscriptPatch(settled, patch([correction], 'foreign'))).toEqual(settled)
    const advanced = applyFreshAgentTranscriptPatch(settled, { ...patch([{ op: 'resetTurn', nativeTurnId: 'later', turns: [{ ...row, id: 'later', turnId: 'later' }], revision: 3 }]), historyGeneration: 1 })
    expect(applyFreshAgentTranscriptPatch(advanced, patch([correction]))).toEqual(advanced)
    const wrongRows = [{ ...row, id: 'another', turnId: 'another' }]
    expect(applyFreshAgentTranscriptPatch(settled, patch([{ ...correction, turns: wrongRows }])).turns).toEqual(settled.turns)
    expect(applyFreshAgentTranscriptPatch(settled, patch([{ ...correction, turns: [{ ...row, nativeTurnId: 'another' }] }])).turns).toEqual(settled.turns)

    let removed = applyFreshAgentTranscriptPatch(settled, patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [], revision: 3 }]))
    removed = applyFreshAgentTranscriptPatch(removed, patch([correction]))
    expect(removed.turns).toEqual([])

    let trimmed = settled
    let revision = 3
    for (let i = 0; i < 33; i++) {
      const id = `new-${i}`
      trimmed = applyFreshAgentTranscriptPatch(trimmed, patch([{ op: 'resetTurn', nativeTurnId: id, turns: [{ ...row, id, turnId: id }], revision: revision++ }, { op: 'settleTurn', nativeTurnId: id, revision: revision++ }]))
    }
    expect(trimmed.turns.some(turn => turn.turnId === 't')).toBe(false)
    trimmed = applyFreshAgentTranscriptPatch(trimmed, patch([correction]))
    expect(trimmed.turns.some(turn => turn.turnId.startsWith('t'))).toBe(false)
  })

  it.each([false, true])('keeps a newer-generation failure visible while history is unavailable (missed prefix: %s)', (missedPrefix) => {
    const before = opened()
    const resetRevision = missedPrefix ? 10 : 2
    const incoming = {
      ...patch([
        { op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: resetRevision },
        { op: 'settleTurn', nativeTurnId: 't', status: 'failed', revision: resetRevision + 1 },
      ]),
      historyGeneration: 1,
      afterRevision: resetRevision - 1,
    }
    const live = applyFreshAgentTranscriptPatch(before, incoming)
    expect(live.historyGeneration).toBe(1)
    expect(live.needsResnapshot).toBe(true)
    expect(live.eventRevision).toBe(resetRevision + 1)
    expect(mergeFreshAgentTranscriptProjection(read([row]), live).map((turn) => turn.error?.message).filter(Boolean)).toEqual(['Provider is at capacity'])

    // Neither an older generation nor a different projection can replace it.
    const stale = { ...patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [row], revision: resetRevision + 2 }]), historyGeneration: 0 }
    const foreign = { ...incoming, projectionId: 'foreign', historyGeneration: 2 }
    expect(applyFreshAgentTranscriptPatch(live, stale)).toEqual(live)
    expect(applyFreshAgentTranscriptPatch(live, foreign)).toEqual(live)
  })

  it('never revives an already removed turn when a newer generation reports a failure', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [], revision: 2 }]))
    live = applyFreshAgentTranscriptPatch(live, { ...patch([{ op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 3 }]), historyGeneration: 1, afterRevision: 2 })
    expect(live.historyGeneration).toBe(1)
    expect(live.turns).toEqual([])
    live = applyFreshAgentTranscriptPatch(live, { ...patch([{ op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 4 }]), historyGeneration: 1 })
    expect(live.turns).toEqual([])
  })

  it('preserves removal fences when an init binds the next generation', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [], revision: 2 }]))
    live = bindTranscriptProjection(live, 'p', 1)
    live = applyFreshAgentTranscriptPatch(live, { ...patch([{ op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 3 }]), historyGeneration: 1 })
    expect(live.turns).toEqual([])
  })

  it('accepts complete failures across a gap while continuing to fence ordinary updates and removals', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), {
      ...patch([
        { op: 'resetTurn', nativeTurnId: 'removed', turns: [], revision: 9 },
        { op: 'resetTurn', nativeTurnId: 'removed', turns: [{ ...row, id: 'removed', turnId: 'removed', error: { name: 'CodexError', message: 'stale' } }], correctSettled: true, revision: 10 },
        { op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 11 },
        { op: 'settleTurn', nativeTurnId: 't', status: 'failed', revision: 12 },
      ]), historyGeneration: 1, afterRevision: 8,
    })
    live = applyFreshAgentTranscriptPatch(live, { ...patch([{ op: 'appendItem', nativeTurnId: 't', rowId: 't:row-0', itemId: 'a', field: 'text', text: 'late', revision: 13 }]), historyGeneration: 1, afterRevision: 12 })
    const nextFailure = { ...row, id: 'next', turnId: 'next', items: [], error: { name: 'CodexError', message: 'Second failure' } }
    live = applyFreshAgentTranscriptPatch(live, { ...patch([{ op: 'resetTurn', nativeTurnId: 'next', turns: [nextFailure], correctSettled: true, revision: 14 }]), historyGeneration: 1, afterRevision: 13 })
    expect(live.needsResnapshot).toBe(true)
    expect(live.turns.map((turn) => turn.turnId)).toEqual(['t:row-0', 't:row-1', 'next'])
    expect(live.turns[0].items[0]).toMatchObject({ text: 'partial output' })
  })

  it('does not revive an itemless turn evicted from the retained window', () => {
    let live: TranscriptProjection = { id: 'p', eventRevision: 0, historyGeneration: 0, turns: [] }
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'settleTurn', nativeTurnId: 'itemless', revision: 1 }]))
    let revision = 2
    for (let i = 0; i < 32; i++) {
      const id = `new-${i}`
      live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: id, turns: [{ ...row, id, turnId: id }], revision: revision++ }, { op: 'settleTurn', nativeTurnId: id, revision: revision++ }]))
    }
    const failure = { ...row, id: 'itemless', turnId: 'itemless', items: [], error: { name: 'CodexError', message: 'Provider failed' } }
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'itemless', correctSettled: true, turns: [failure], revision }]))
    expect(live.turns.some((turn) => turn.turnId === 'itemless')).toBe(false)
  })

  it('shows a newer correction over an older final history snapshot', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'settleTurn', nativeTurnId: 't', status: 'interrupted', revision: 2 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 't', turns: failedRows, correctSettled: true, revision: 3 }]))
    const older = read([{ ...row, items: [] }], { nativeFinalTurnIds: ['t'], eventRevision: 2, turnOutputStates: { t: { provenance: 'retained', diagnostic: 'interrupted', refreshPending: false } } })
    const merged = mergeFreshAgentTranscriptProjection(older, live)
    expect(merged.map(turn => turn.error?.message).filter(Boolean)).toEqual(['Provider is at capacity'])
    expect(merged[0].outputState?.diagnostic).not.toBe('interrupted')
    const newer = read([{ ...row, items: [], error: { name: 'CodexError', message: 'Provider is at capacity' } }], { nativeFinalTurnIds: ['t'], eventRevision: 3 })
    expect(mergeFreshAgentTranscriptProjection(newer, live)).toEqual(newer.turns)
  })

  it('an accepted history mutation removes a group permanently for that generation', () => {
    let live = opened()
    live = applyFreshAgentTranscriptPatch(live, { sessionId: 'thread', projectionId: 'p', historyGeneration: 1, ops: [{ op: 'resetTurn', nativeTurnId: 't', turns: [], revision: 2 }] })
    live = applyFreshAgentTranscriptPatch(live, patch([append('old', 3)]))
    expect(live.turns).toEqual([])
    expect(mergeFreshAgentTranscriptProjection(read([], { historyGeneration: 1 }), live)).toEqual([])
  })

  it('ignores reordered or duplicate revision deliveries and old-incarnation frozen extras', () => {
    const live = applyFreshAgentTranscriptPatch(opened(), patch([append('Hello', 3), append('duplicate', 3), append('older', 2)]))
    expect(live.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
    expect(mergeFreshAgentTranscriptProjection(read([], { id: 'replacement' }), live)).toEqual([])
  })

  it('appends indexed reasoning independently, preserving Unicode', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'upsertItem', nativeTurnId: 't', row, item: { id: 'r', kind: 'reasoning', summary: [], content: [] }, revision: 2 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([
      { op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'r', field: 'summary', index: 1, text: '思', revision: 3 },
      { op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'r', field: 'summary', index: 0, text: '🙂', revision: 4 },
      { op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'r', field: 'summary', index: 1, text: '考', revision: 5 },
    ]))
    expect(live.turns[0].items[1]).toMatchObject({ kind: 'reasoning', summary: ['🙂', '思考'] })
  })

  it('keeps frozen output only as a finite disclosure for accepted interrupted history after rebind', () => {
    const old = applyFreshAgentTranscriptPatch(opened(), patch([append('unfinished', 2)]))
    const live = bindTranscriptProjection(old, 'replacement', 0)
    const saved = read([{ ...row, items: [] }], { id: 'replacement', nativeFinalTurnIds: ['t'], turnOutputStates: { t: { provenance: 'saved', diagnostic: 'interrupted', refreshPending: false } } })
    const turns = mergeFreshAgentTranscriptProjection(saved, live)
    expect(turns[0].outputState).toMatchObject({ provenance: 'saved-and-retained', diagnostic: 'interrupted', refreshPending: false, retainedItems: [{ id: 'a', kind: 'text', text: 'unfinished' }] })
    expect(mergeFreshAgentTranscriptProjection(read([], { id: 'replacement' }), live)).toEqual([])
    const complete = read([{ ...row, items: [{ id: 'a', kind: 'text', text: 'new native final' }] }], { id: 'replacement', nativeFinalTurnIds: ['t'], turnOutputStates: { t: { provenance: 'saved', refreshPending: false } } })
    expect(mergeFreshAgentTranscriptProjection(complete, live)[0].outputState?.retainedItems).toBeUndefined()
  })

  it('freeze after host loss does not keep waiting for an item native cannot save', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([append('unfinished', 2)]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'settleTurn', nativeTurnId: 't', status: 'interrupted', revision: 3 }]))
    const snapshot = read([row], { eventOwnedTurnIds: ['t'], eventRevision: 1 })
    expect(mergeFreshAgentTranscriptProjection(snapshot, live)[0]).toMatchObject({ items: [{ id: 'a', kind: 'text', text: 'unfinished' }], outputState: { diagnostic: 'interrupted', refreshPending: false } })
  })

  it('hydrates a captured event-owned prefix on reconnect, while a native preview stays nonappendable', () => {
    const prefix = read([{ ...row, items: [{ id: 'a', kind: 'text', text: 'Hel' }] }], { eventOwnedTurnIds: ['t'], eventRevision: 2 })
    let live = hydrateTranscriptProjection({ id: 'p', eventRevision: 0, historyGeneration: 0, turns: [] }, prefix)
    live = applyFreshAgentTranscriptPatch(live, patch([append('lo', 3)]))
    expect(mergeFreshAgentTranscriptProjection(prefix, live)[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
    const preview = read([{ ...row, items: [{ id: 'a', kind: 'text', text: 'Hello' }] }], { nativePreviewTurnIds: ['t'], eventRevision: 2 })
    let cold = hydrateTranscriptProjection({ id: 'p', eventRevision: 0, historyGeneration: 0, turns: [] }, preview)
    cold = applyFreshAgentTranscriptPatch(cold, patch([append('lo', 3)]))
    expect(cold.turns).toEqual([])
    expect(mergeFreshAgentTranscriptProjection(preview, cold)[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
  })

  it('a higher revision from another turn cannot replace a newer captured body in this turn', () => {
    let live = opened()
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 'later', turns: [{ ...row, id: 'later', turnId: 'later' }], revision: 10 }]))
    const snapshot = read([{ ...row, items: [{ id: 'a', kind: 'text', text: 'server complete' }] }], { eventOwnedTurnIds: ['t'], eventRevision: 5 })
    expect(mergeFreshAgentTranscriptProjection(snapshot, live)[0].items).toEqual([{ id: 'a', kind: 'text', text: 'server complete' }])
  })

  it('retains bounded ended payloads while permanently fencing the discarded operations', () => {
    let live = opened()
    let revision = 2
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'settleTurn', nativeTurnId: 't', revision: revision++ }]))
    for (let i = 0; i < 40; i++) {
      const id = `n-${i}`
      live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: id, turns: [{ ...row, id, turnId: id }], revision: revision++ }, { op: 'settleTurn', nativeTurnId: id, revision: revision++ }]))
    }
    expect(live.turns).toHaveLength(32)
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [row], revision: revision++ }, append('late', revision++)]))
    expect(live.turns.some((row) => row.turnId === 't')).toBe(false)
  })

  it('preserves a warm interrupted disclosure across a read-only saved-history source without reviving removed membership', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([append('unfinished', 2)]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'settleTurn', nativeTurnId: 't', status: 'interrupted', revision: 3 }]))
    const saved = read([{ ...row, items: [], outputState: { provenance: 'saved', diagnostic: 'interrupted', refreshPending: false } }])
    saved.extensions.codex = { nativeHistoryAvailable: true, ownerKind: 'vacant' }
    expect(mergeFreshAgentTranscriptProjection(saved, live)[0].outputState?.retainedItems).toEqual([{ id: 'a', kind: 'text', text: 'unfinished' }])
    expect(mergeFreshAgentTranscriptProjection({ ...saved, turns: [] }, live)).toEqual([])
    expect(mergeFreshAgentTranscriptProjection({ ...saved, threadId: 'different' }, live)[0].outputState?.retainedItems).toBeUndefined()
  })

  it('groups canonical projection metadata without depending on the additive row lookup hint', () => {
    const snapshot = read([row], { eventOwnedTurnIds: ['t'], eventRevision: 1 })
    delete (snapshot.extensions.codex!.projection as any).turnRows
    expect(mergeFreshAgentTranscriptProjection(snapshot, opened())).toHaveLength(1)
  })

  it('keeps an older unsaved group before a later saved turn even after its live payload lands', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([append('older unsaved', 2), { op: 'settleTurn', nativeTurnId: 't', revision: 3 }, { op: 'resetTurn', nativeTurnId: 'later', turns: [{ ...row, id: 'later', turnId: 'later' }], revision: 4 }]))
    const snapshot = read([{ ...row, id: 'later', turnId: 'later', items: [{ id: 'answer-later', kind: 'text', text: 'later saved' }] }], { nativeFinalTurnIds: ['later'], turnRows: { later: ['later'] } })
    expect(mergeFreshAgentTranscriptProjection(snapshot, live).map((turn) => turn.turnId)).toEqual(['t', 'later'])
  })

  it('shows file-change output progress on its existing item', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'upsertItem', nativeTurnId: 't', row, item: { id: 'files', kind: 'file_change', status: 'running', changes: [] }, revision: 2 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'files', field: 'output', text: 'Applying patch', revision: 3 }]))
    expect(live.turns[0].items[1]).toMatchObject({ output: 'Applying patch' })
  })

  it('never appends to read-only recovery preview items, but admits an actual complete replacement', () => {
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [{ ...row, items: [{ id: 'a', kind: 'text', text: 'read preview' }] }], nonAppendableItemIds: ['a'], revision: 2 }]))
    live = applyFreshAgentTranscriptPatch(live, patch([append('leak', 3)]))
    expect(live.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'read preview' }])
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'upsertItem', nativeTurnId: 't', row, item: { id: 'a', kind: 'text', text: 'actual complete' }, complete: true, revision: 4 }]))
    expect(live.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'actual complete' }])
  })

  it('refreshes only read-only prefix fields across an event-owned snapshot fence', () => {
    const prior = { id: 'prior', kind: 'text' as const, text: 'older preview' }
    let live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'resetTurn', nativeTurnId: 't', turns: [{ ...row, items: [prior, ...row.items] }], nonAppendableItemIds: ['prior'], revision: 2 }, append('Hel', 3)]))
    const snapshot = read([{ ...row, items: [{ ...prior, text: 'newer preview' }, ...row.items] }], { eventOwnedTurnIds: ['t'], eventRevision: 2, nonAppendableItemIds: { t: ['prior'] } })
    live = hydrateTranscriptProjection(live, snapshot)
    expect(live.turns[0].items).toEqual([{ ...prior, text: 'newer preview' }, { id: 'a', kind: 'text', text: 'Hel' }])
    live = applyFreshAgentTranscriptPatch(live, patch([{ op: 'upsertItem', nativeTurnId: 't', row, item: { ...prior, text: 'actual complete' }, complete: true, revision: 4 }]))
    live = hydrateTranscriptProjection(live, snapshot)
    expect(live.turns[0].items).toEqual([{ ...prior, text: 'actual complete' }, { id: 'a', kind: 'text', text: 'Hel' }])
  })

  it('keeps unmatched recovery context available as a saved alternative after an actual item replacement', () => {
    const live = applyFreshAgentTranscriptPatch(opened(), patch([{ op: 'upsertItem', nativeTurnId: 't', row, item: { id: 'a', kind: 'text', text: 'actual complete' }, complete: true, revision: 2 }]))
    const saved = read([{ ...row, items: [{ id: 'item-1', kind: 'text', text: 'earlier saved commentary' }, { id: 'item-2', kind: 'text', text: 'native read preview' }] }], { nativePreviewTurnIds: ['t'] })
    const rows = mergeFreshAgentTranscriptProjection(saved, live)
    expect(rows).toHaveLength(1)
    expect(rows[0].items).toEqual([{ id: 'a', kind: 'text', text: 'actual complete' }])
    expect(rows[0].outputState?.savedItems).toEqual(saved.turns[0].items)
  })
})
