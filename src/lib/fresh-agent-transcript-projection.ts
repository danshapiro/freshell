import { FreshAgentTranscriptPatchSchema, type FreshAgentSnapshot, type FreshAgentTranscriptItem, type FreshAgentTurn, type FreshAgentTranscriptPatch } from '@shared/fresh-agent-contract'

export type TranscriptProjection = {
  id: string
  historyGeneration: number
  eventRevision: number
  turns: FreshAgentTurn[]
  turnRows?: Record<string, string[]>
  closedItems?: Record<string, true>
  settledTurns?: Record<string, true>
  removedTurns?: Record<string, true>
  frozenTurns?: Record<string, FreshAgentTurn[]>
  turnRevisions?: Record<string, number>
  previewTurns?: Record<string, true>
  deferredOps?: FreshAgentTranscriptPatch['ops']
  deferredBytes?: number
  needsResnapshot?: boolean
  sessionId?: string
  turnOrder?: string[]
  nonAppendableItemIds?: Record<string, string[]>
}

const itemKey = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId])

/** Read-only recovery context may coexist with event-owned append baselines. */
export function applyFreshAgentTranscriptPatch(state: TranscriptProjection, input: unknown): TranscriptProjection {
  const parsed = FreshAgentTranscriptPatchSchema.safeParse(input)
  if (!parsed.success) return state
  const patch = parsed.data
  if (patch.projectionId !== state.id || patch.historyGeneration < state.historyGeneration) return state
  const next: TranscriptProjection = patch.historyGeneration > state.historyGeneration
    ? { id: state.id, historyGeneration: patch.historyGeneration, eventRevision: state.eventRevision, turns: [], turnRows: {}, closedItems: {}, settledTurns: {}, removedTurns: {}, turnRevisions: {}, deferredOps: [] }
    : { ...state, turns: [...state.turns], turnRows: { ...state.turnRows }, closedItems: { ...state.closedItems }, settledTurns: { ...state.settledTurns }, removedTurns: { ...state.removedTurns }, turnRevisions: { ...state.turnRevisions }, deferredOps: [...state.deferredOps ?? []], turnOrder: [...state.turnOrder ?? []], nonAppendableItemIds: { ...state.nonAppendableItemIds } }
  next.nonAppendableItemIds ??= {}
  next.sessionId = patch.sessionId
  for (const op of patch.ops) {
    if (op.revision <= next.eventRevision) continue
    next.eventRevision = op.revision
    const nativeId = op.nativeTurnId
    next.turnRevisions![nativeId] = op.revision
    if (op.op === 'settleTurn') {
      next.settledTurns![nativeId] = true
      if (op.status === 'interrupted') {
        const ids = new Set(next.turnRows![nativeId] ?? [])
        next.turns = next.turns.map((row) => ids.has(row.turnId) ? { ...row, outputState: { provenance: 'retained', diagnostic: 'interrupted', refreshPending: false } } : row)
      }
      next.deferredOps = next.deferredOps?.filter((op) => op.nativeTurnId !== nativeId)
      const prefix = JSON.stringify([nativeId]).slice(0, -1) + ','
      for (const key of Object.keys(next.closedItems!)) if (key.startsWith(prefix)) delete next.closedItems![key]
      trimSettledTurns(next)
      continue
    }
    if (next.removedTurns![nativeId]) continue
    if (op.op === 'resetTurn') {
      if (next.settledTurns![nativeId] && op.turns.length > 0) continue
      next.turnOrder ??= []
      if (!next.turnOrder.includes(nativeId)) next.turnOrder.push(nativeId)
      const previousIds = new Set(next.turnRows![nativeId] ?? [])
      const insertion = next.turns.findIndex((row) => previousIds.has(row.turnId))
      next.turns = next.turns.filter((row) => !previousIds.has(row.turnId))
      next.turns.splice(insertion < 0 ? next.turns.length : insertion, 0, ...op.turns)
      next.turnRows![nativeId] = op.turns.map((row) => row.turnId)
      next.nonAppendableItemIds[nativeId] = op.nonAppendableItemIds ?? []
      if (op.turns.length === 0) next.removedTurns![nativeId] = true
      for (const id of op.completedItemIds ?? []) next.closedItems![itemKey(nativeId, id)] = true
      continue
    }
    if (next.settledTurns![nativeId]) continue
    if (op.op === 'upsertItem') {
      if (!next.turnRows![nativeId]) {
        if (op.complete && next.previewTurns?.[nativeId]) next.turnRows![nativeId] = []
        else { deferOp(next, op); continue }
      }
      if (next.closedItems![itemKey(nativeId, op.item.id)]) continue
      let index = next.turns.findIndex((row) => row.turnId === op.row.turnId)
      if (index < 0) {
        next.turns.push(op.row)
        index = next.turns.length - 1
        next.turnRows![nativeId].push(op.row.turnId)
      }
      const row = next.turns[index]
      const items = [...row.items]
      const itemIndex = items.findIndex((item) => item.id === op.item.id)
      if (itemIndex < 0) items.push(op.item)
      else items[itemIndex] = op.item
      next.turns[index] = { ...op.row, items }
      next.nonAppendableItemIds[nativeId] = (next.nonAppendableItemIds[nativeId] ?? []).filter((id) => id !== op.item.id)
      if (op.complete) next.closedItems![itemKey(nativeId, op.item.id)] = true
      continue
    }
    if (next.closedItems![itemKey(nativeId, op.itemId)] || next.nonAppendableItemIds[nativeId]?.includes(op.itemId)) continue
    if (!next.turnRows![nativeId]?.includes(op.rowId)) { deferOp(next, op); continue }
    const rowIndex = next.turns.findIndex((row) => row.turnId === op.rowId)
    if (rowIndex < 0) continue
    const row = next.turns[rowIndex]
    const index = row.items.findIndex((item) => item.id === op.itemId)
    if (index < 0) continue
    const item = row.items[index]
    let updated: FreshAgentTranscriptItem | undefined
    if (op.field === 'text' && (item.kind === 'text' || item.kind === 'thinking')) updated = { ...item, text: item.text + op.text }
    else if (op.field === 'output' && (item.kind === 'command' || item.kind === 'file_change')) updated = { ...item, output: (item.output ?? '') + op.text }
    else if ((op.field === 'summary' || op.field === 'content') && item.kind === 'reasoning' && typeof op.index === 'number') {
      const parts = [...item[op.field]]
      while (parts.length <= op.index) parts.push('')
      parts[op.index] += op.text
      const summary = op.field === 'summary' ? parts : item.summary
      const content = op.field === 'content' ? parts : item.content
      updated = { ...item, [op.field]: parts, text: (summary.length > 0 ? summary : content).join('\n') }
    }
    if (updated) {
      const items = [...row.items]; items[index] = updated
      next.turns[rowIndex] = { ...row, items }
    }
  }
  return next
}

function trimSettledTurns(state: TranscriptProjection): void {
  const groups = Object.entries(state.turnRows ?? {}).filter(([id]) => state.settledTurns?.[id])
    .map(([id, ids]) => ({ id, ids: new Set(ids), revision: state.turnRevisions?.[id] ?? 0 }))
    .sort((a, b) => a.revision - b.revision)
  let bytes = groups.reduce((sum, group) => sum + JSON.stringify(state.turns.filter((row) => group.ids.has(row.turnId))).length, 0)
  let count = groups.length
  for (const group of groups) {
    if (count <= 32 && bytes <= 8 * 1024 * 1024) break
    bytes -= JSON.stringify(state.turns.filter((row) => group.ids.has(row.turnId))).length
    state.turns = state.turns.filter((row) => !group.ids.has(row.turnId))
    delete state.turnRows![group.id]
    count -= 1
  }
}

export function freezeTranscriptProjection(state: TranscriptProjection): TranscriptProjection {
  const interrupted = new Set<string>()
  for (const [id, rows] of Object.entries(state.turnRows ?? {})) {
    if (!state.settledTurns?.[id]) for (const row of rows) interrupted.add(row)
  }
  const next: TranscriptProjection = { ...state, closedItems: {}, deferredOps: [], deferredBytes: 0, settledTurns: { ...state.settledTurns },
    turns: state.turns.map((row) => ({ ...row, outputState: { provenance: 'retained', diagnostic: interrupted.has(row.turnId) ? 'interrupted' : row.outputState?.diagnostic ?? 'unsaved', refreshPending: false } })),
  }
  for (const id of Object.keys(state.turnRows ?? {})) next.settledTurns![id] = true
  trimSettledTurns(next)
  return next
}

// A reconnect can receive a delta during its first history RPC. Keep only
// these short-lived, unbased operations until an authoritative event prefix
// arrives. They never seed from a native preview or survive a terminal fence.
function deferOp(state: TranscriptProjection, op: FreshAgentTranscriptPatch['ops'][number]): void {
  const ops = state.deferredOps ??= []
  const bytes = JSON.stringify(op).length
  if (ops.length < 1024 && (state.deferredBytes ?? 0) + bytes <= 64 * 1024) {
    ops.push(op)
    state.deferredBytes = (state.deferredBytes ?? 0) + bytes
  } else state.needsResnapshot = true
}

export type ProjectionMetadata = {
  id: string
  eventRevision: number
  historyGeneration: number
  eventOwnedTurnIds: string[]
  nativePreviewTurnIds: string[]
  nativeFinalTurnIds: string[]
  turnRows: Record<string, string[]>
  completedItems?: Record<string, string[]>
  nonAppendableItemIds?: Record<string, string[]>
  settledTurnIds?: string[]
  turnOutputStates: Record<string, { provenance: 'saved' | 'retained' | 'saved-and-retained' | 'preview'; diagnostic?: 'interrupted' | 'unsaved' | 'provider-truncated'; refreshPending: boolean; retainedTurns?: FreshAgentTurn[]; savedTurns?: FreshAgentTurn[] }>
}

export function bindTranscriptProjection(previous: TranscriptProjection | undefined, id: string, historyGeneration: number): TranscriptProjection {
  if (previous?.id === id && previous.historyGeneration >= historyGeneration) return previous
  const frozenTurns = previous && previous.id !== id
    ? { ...previous.frozenTurns, ...Object.fromEntries(Object.entries(previous.turnRows ?? {}).map(([id, ids]) => [id, previous.turns.filter((row) => ids.includes(row.turnId))])) }
    : undefined
  if (frozenTurns) {
    const entries = Object.entries(frozenTurns)
    let bytes = entries.reduce((sum, [, rows]) => sum + JSON.stringify(rows).length, 0)
    while (entries.length > 32 || bytes > 8 * 1024 * 1024) {
      const oldest = entries.shift()
      if (!oldest) break
      bytes -= JSON.stringify(oldest[1]).length
      delete frozenTurns[oldest[0]]
    }
  }
  return { id, historyGeneration, eventRevision: 0, turns: [], turnRows: {}, sessionId: previous?.sessionId, ...(frozenTurns ? { frozenTurns } : {}) }
}

const metadataCache = new WeakMap<object, ProjectionMetadata>()

export function readTranscriptProjection(snapshot: FreshAgentSnapshot): ProjectionMetadata | undefined {
  const raw = snapshot.extensions?.codex?.projection
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const cached = metadataCache.get(raw)
  if (cached) return cached
  const value = raw as ProjectionMetadata
  if (typeof value.id !== 'string' || !Number.isSafeInteger(value.eventRevision) || !Number.isSafeInteger(value.historyGeneration)
    || ![value.eventOwnedTurnIds, value.nativePreviewTurnIds, value.nativeFinalTurnIds].every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))
    || !value.turnOutputStates || typeof value.turnOutputStates !== 'object' || Array.isArray(value.turnOutputStates)) return undefined
  const ids = [...value.eventOwnedTurnIds, ...value.nativePreviewTurnIds, ...value.nativeFinalTurnIds]
  const normalized = value.turnRows && typeof value.turnRows === 'object' && !Array.isArray(value.turnRows) ? value : {
    ...value,
    turnRows: Object.fromEntries(ids.map((id) => [id, snapshot.turns.filter((row) => rowBelongsToNativeTurn(row, id)).map((row) => row.turnId)])),
  }
  metadataCache.set(raw, normalized)
  return normalized
}

function rowBelongsToNativeTurn(row: FreshAgentTurn, id: string): boolean {
  return row.nativeTurnId === id || row.turnId === id || (row.turnId.startsWith(`${id}:row-`) && /^\d+$/.test(row.turnId.slice(`${id}:row-`.length)))
}

export function hydrateTranscriptProjection(state: TranscriptProjection, snapshot: FreshAgentSnapshot): TranscriptProjection {
  const metadata = readTranscriptProjection(snapshot)
  if (!metadata || metadata.id !== state.id || metadata.historyGeneration !== state.historyGeneration) return state
  let next: TranscriptProjection = { ...state, turns: [...state.turns], turnRows: { ...state.turnRows }, turnRevisions: { ...state.turnRevisions }, closedItems: { ...state.closedItems }, settledTurns: { ...state.settledTurns }, nonAppendableItemIds: { ...state.nonAppendableItemIds }, previewTurns: Object.fromEntries(metadata.nativePreviewTurnIds.map((id) => [id, true as const])) }
  for (const [id, items] of Object.entries(metadata.completedItems ?? {})) {
    for (const item of items) next.closedItems![itemKey(id, item)] = true
  }
  for (const id of metadata.settledTurnIds ?? []) next.settledTurns![id] = true
  for (const id of metadata.eventOwnedTurnIds) {
    if ((state.turnRevisions?.[id] ?? 0) > metadata.eventRevision && (state.turnRows?.[id]?.length ?? 0) > 0) {
      const readOnly = new Set(state.nonAppendableItemIds?.[id] ?? [])
      const rows = new Set(metadata.turnRows[id] ?? [])
      const saved = new Map(snapshot.turns.filter((row) => rows.has(row.turnId)).flatMap((row) => row.items.map((item) => [item.id, item] as const)))
      const currentRows = new Set(state.turnRows?.[id] ?? [])
      next.turns = next.turns.map((row) => currentRows.has(row.turnId) ? { ...row, items: row.items.map((item) => readOnly.has(item.id) ? saved.get(item.id) ?? item : item) } : row)
      continue
    }
    const oldIds = new Set(next.turnRows![id] ?? [])
    const ids = metadata.turnRows[id] ?? []
    const accepted = new Set(ids)
    const rows = snapshot.turns.filter((row) => accepted.has(row.turnId))
    const at = next.turns.findIndex((row) => oldIds.has(row.turnId))
    next.turns = next.turns.filter((row) => !oldIds.has(row.turnId))
    next.turns.splice(at < 0 ? next.turns.length : at, 0, ...rows)
    next.turnRows![id] = [...ids]
    next.nonAppendableItemIds![id] = metadata.nonAppendableItemIds?.[id] ?? []
    next.turnRevisions![id] = metadata.eventRevision
  }
  const deferred = (state.deferredOps ?? []).filter((op) => op.revision > metadata.eventRevision && !next.settledTurns?.[op.nativeTurnId])
  if (deferred.length) next = applyFreshAgentTranscriptPatch({ ...next, eventRevision: metadata.eventRevision, deferredOps: [] }, { sessionId: snapshot.threadId, projectionId: state.id, historyGeneration: state.historyGeneration, ops: deferred })
  else next.deferredOps = []
  next.eventRevision = Math.max(state.eventRevision, metadata.eventRevision, next.eventRevision)
  next.sessionId = snapshot.threadId
  const groupOf = new Map(Object.entries(metadata.turnRows).flatMap(([id, rows]) => rows.map((row) => [row, id] as const)))
  const order = [...new Set(snapshot.turns.map((row) => groupOf.get(row.turnId)).filter((id): id is string => Boolean(id)))]
  const observed = state.turnOrder ?? []
  for (const [index, id] of observed.entries()) {
    if (order.includes(id)) continue
    const next = observed.slice(index + 1).find((candidate) => order.includes(candidate))
    order.splice(next ? order.indexOf(next) : order.length, 0, id)
  }
  next.turnOrder = order
  if (metadata.eventRevision >= state.eventRevision) next.needsResnapshot = false
  next.deferredBytes = JSON.stringify(next.deferredOps ?? []).length
  return next
}

function withOutputState(rows: FreshAgentTurn[], state: ProjectionMetadata['turnOutputStates'][string] | undefined): FreshAgentTurn[] {
  if (!state || rows.length === 0 || (state.provenance === 'saved' && !state.diagnostic && !state.retainedTurns && !state.savedTurns)) return rows
  const { retainedTurns, savedTurns, ...outputState } = state
  return [{ ...rows[0], outputState: { ...outputState,
    ...(retainedTurns ? { retainedItems: retainedTurns.flatMap((row) => row.items) } : {}),
    ...(savedTurns ? { savedItems: savedTurns.flatMap((row) => row.items) } : {}),
  } }, ...rows.slice(1)]
}

/** Replace native-turn groups atomically. Read previews never consume event revisions. */
export function mergeFreshAgentTranscriptProjection(snapshot: FreshAgentSnapshot, live?: TranscriptProjection): FreshAgentTurn[] {
  const metadata = readTranscriptProjection(snapshot)
  if (!metadata) return mergeSavedOnlyRetainedOutput(snapshot, live)
  const currentLive = live?.id === metadata.id && live.historyGeneration === metadata.historyGeneration ? live : undefined
  const liveRows = currentLive?.turnRows ?? {}
  const nativeRows = metadata.turnRows ?? {}
  const groupOf = new Map(Object.entries(nativeRows).flatMap(([id, rows]) => rows.map((row) => [row, id] as const)))
  const savedGroups = new Map<string, FreshAgentTurn[]>()
  for (const row of snapshot.turns) {
    const id = groupOf.get(row.turnId)
    if (id) { const rows = savedGroups.get(id) ?? []; rows.push(row); savedGroups.set(id, rows) }
  }
  const result: FreshAgentTurn[] = []
  const seen = new Set<string>()
  const finals = new Set(metadata.nativeFinalTurnIds)
  const previews = new Set(metadata.nativePreviewTurnIds)
  const appendGroup = (id: string, saved: FreshAgentTurn[]) => {
    if (seen.has(id)) return
    seen.add(id)
    const eventIds = new Set(liveRows[id] ?? [])
    const eventRows = currentLive?.turns.filter((row) => eventIds.has(row.turnId)) ?? []
    const complete = eventRows.some((row) => row.items.some((item) => currentLive?.closedItems?.[itemKey(id, item.id)]))
    const frozenState = eventRows.find((row) => row.outputState?.provenance === 'retained' && !row.outputState.refreshPending)?.outputState
    const eventWins = eventRows.length > 0 && !finals.has(id)
      && (saved.length === 0 || frozenState || ((currentLive!.turnRevisions?.[id] ?? 0) > metadata.eventRevision && (!previews.has(id) || complete)))
    const rows = eventWins ? eventRows : saved
    let state: ProjectionMetadata['turnOutputStates'][string] | undefined = (eventWins && frozenState ? frozenState : undefined) ?? metadata.turnOutputStates?.[id]
      ?? (eventWins ? { provenance: 'retained' as const, refreshPending: Boolean(currentLive?.settledTurns?.[id]) } : undefined)
    // Legacy recovery message ids may be reconstructed. Keep its unmatched
    // context available without guessing which read item a live item replaces.
    if (eventWins && complete && previews.has(id) && saved.length && !state?.savedTurns) {
      state = { ...state!, savedTurns: saved }
    }
    const frozen = currentLive?.frozenTurns?.[id]
    if (frozen?.length && (previews.has(id) || state?.diagnostic === 'interrupted') && !state?.retainedTurns) {
      state = { provenance: 'saved-and-retained', diagnostic: 'interrupted', refreshPending: false, retainedTurns: frozen }
    }
    result.push(...withOutputState(rows, state))
  }
  for (const row of snapshot.turns) {
    const id = groupOf.get(row.turnId)
    if (!id) { result.push(row); continue }
    appendGroup(id, savedGroups.get(id) ?? [])
  }
  const observed = currentLive?.turnOrder ?? Object.keys(liveRows)
  for (const [index, id] of observed.entries()) {
    if (seen.has(id) || currentLive?.removedTurns?.[id] || finals.has(id)) continue
    const before = result.length
    appendGroup(id, [])
    const added = result.splice(before)
    const anchor = observed.slice(index + 1).find((candidate) => seen.has(candidate) && ((nativeRows[candidate]?.length ?? 0) > 0 || (liveRows[candidate]?.length ?? 0) > 0))
    const anchorRows = new Set(anchor ? nativeRows[anchor] ?? liveRows[anchor] ?? [] : [])
    const insertion = result.findIndex((row) => anchorRows.has(row.turnId))
    result.splice(insertion < 0 ? result.length : insertion, 0, ...added)
  }
  return result
}

function mergeSavedOnlyRetainedOutput(snapshot: FreshAgentSnapshot, live?: TranscriptProjection): FreshAgentTurn[] {
  if (snapshot.provider !== 'codex' || live?.sessionId !== snapshot.threadId || snapshot.extensions?.codex?.nativeHistoryAvailable !== true || snapshot.extensions.codex.ownerKind !== 'vacant') return snapshot.turns
  const rows = [...snapshot.turns]
  const groups = { ...live.frozenTurns, ...Object.fromEntries(Object.entries(live.turnRows ?? {}).map(([id, ids]) => [id, live.turns.filter((row) => ids.includes(row.turnId))])) }
  for (const [id, retained] of Object.entries(groups)) {
    const index = rows.findIndex((row) => rowBelongsToNativeTurn(row, id))
    if (index < 0 || !retained.length || (rows[index].outputState?.diagnostic !== 'interrupted' && !retained.some((row) => row.outputState?.diagnostic === 'interrupted'))) continue
    rows[index] = { ...rows[index], outputState: { provenance: 'saved-and-retained', diagnostic: 'interrupted', refreshPending: false, retainedItems: retained.flatMap((row) => row.items) } }
  }
  return rows
}
