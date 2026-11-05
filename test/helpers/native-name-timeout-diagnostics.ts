const MAX_NATIVE_SYNC_SAMPLES = 24
const MAX_SERVER_LOG_TAIL_CHARS = 64 * 1024
const MAX_SERVER_LOG_RECORDS = 32
const NATIVE_TITLE_DIAGNOSTIC_TIMEOUT_MS = 10_000

const nativeSyncStatuses = new Set(['pending', 'synced', 'unsynced', 'unsupported'])
const nativeNameOperations = new Set(['probe', 'read', 'write', 'confirm_read'])
const nativeWriteStatuses = new Set(['pending', 'synced', 'unsynced', 'unsupported'])
const nativeUnsyncedReasons = new Map<string, string>([
  ['native name synchronization stopped after repeated lifecycle lock contention', 'lifecycle_busy_exhausted'],
  ['the native target holds no title at the attempted location', 'native_title_missing'],
  ['divergent native title at the attempted location', 'native_title_diverged'],
  ['native route changed; the previous title confirmation is no longer current', 'route_changed'],
  ['native route reacquired; remaining cycles re-armed', 'route_reacquired'],
])

type NativeSyncDiagnosticStatus = 'pending' | 'synced' | 'unsynced' | 'unsupported' | 'unknown'

export type NativeSyncDiagnosticSample = {
  sample: number
  recordRevision?: number
  nativeSync: {
    present: boolean
    status?: NativeSyncDiagnosticStatus
    desiredRevision?: number
    locationRevision?: number
    observedCurrent?: boolean
  }
}

export type NativeNameWorkerEvent = {
  event: 'deferred' | 'exhausted' | 'stale'
  atMs?: number
  severity?: 'trace' | 'debug' | 'info' | 'warn' | 'warning' | 'error'
  revision?: number
  seriesEpoch?: number
  locationRevision?: number
  cycle?: number
  operation?: 'probe' | 'read' | 'write' | 'confirm_read'
  deferralCount?: number
  retryInMs?: number
  refundedCycle?: boolean
  refundedRead?: boolean
}

export type NativeLifecycleBusyRefusal = {
  atMs?: number
  operation?: 'probe' | 'read' | 'write' | 'confirm_read'
  reason: 'lifecycle_busy'
}

export type NativeNameDurableState = {
  available: boolean
  entryPresent: boolean
  desiredRevision?: number
  desiredRevisionMatches?: boolean
  seriesEpoch?: number
  status?: 'pending' | 'synced' | 'unsynced' | 'unsupported'
  cyclesConsumed?: number
  readsConsumed?: number
  lifecycleBusyDeferrals?: number
  settled?: boolean
  retryScheduled?: boolean
  confirmationPending?: boolean
  reasonCategory?: string
}

export type NativeTitleDiagnosticFacts = {
  outcome: 'readable' | 'timeout' | 'failed'
  idMatchesExpected: boolean
  titlePresent: boolean
  titleMatchesExpected: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boundedString(value: unknown, values: Set<string>): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined
}

export function appendNativeSyncSample(
  samples: NativeSyncDiagnosticSample[],
  updateValue: unknown,
  sample: number,
): void {
  const update = record(updateValue)
  const nameRecord = record(update?.record)
  const nativeSync = record(update?.nativeSync)
  const rawStatus = boundedString(nativeSync?.status, nativeSyncStatuses)
  const projectedSync: NativeSyncDiagnosticSample['nativeSync'] = {
    present: Boolean(nativeSync),
    ...(nativeSync ? {
      status: (rawStatus ?? 'unknown') as NativeSyncDiagnosticStatus,
      ...(nonNegativeInteger(nativeSync.desiredRevision) !== undefined
        ? { desiredRevision: nonNegativeInteger(nativeSync.desiredRevision) }
        : {}),
      ...(nonNegativeInteger(nativeSync.locationRevision) !== undefined
        ? { locationRevision: nonNegativeInteger(nativeSync.locationRevision) }
        : {}),
      ...(typeof nativeSync.observedCurrent === 'boolean' ? { observedCurrent: nativeSync.observedCurrent } : {}),
    } : {}),
  }
  const recordRevision = nonNegativeInteger(nameRecord?.revision)
  samples.push({
    sample: nonNegativeInteger(sample) ?? 0,
    ...(recordRevision !== undefined ? { recordRevision } : {}),
    nativeSync: projectedSync,
  })
  if (samples.length > MAX_NATIVE_SYNC_SAMPLES) samples.splice(0, samples.length - MAX_NATIVE_SYNC_SAMPLES)
}

export function summarizeNativeTitleObservation(
  value: unknown,
  expectedSessionId: string,
  expectedTitle: string,
): { idMatchesExpected: boolean; titlePresent: boolean; titleMatchesExpected: boolean } {
  const observation = record(value)
  const observedId = observation?.id
  const observedTitle = observation?.title
  return {
    idMatchesExpected: typeof observedId === 'string' && observedId === expectedSessionId,
    titlePresent: typeof observedTitle === 'string' && observedTitle.length > 0,
    titleMatchesExpected: typeof observedTitle === 'string' && observedTitle === expectedTitle,
  }
}

/**
 * Project the one native-write series selected by its exact ref and revision.
 * The persisted name document also contains names, locations, and provider
 * receipts; none of those values may enter a timeout incident.
 */
export function summarizeNativeNameDurableState(
  value: unknown,
  provider: string,
  sessionId: string,
  expectedRevision: number,
): NativeNameDurableState {
  let documentValue = value
  if (typeof value === 'string') {
    try { documentValue = JSON.parse(value) } catch { return { available: false, entryPresent: false } }
  }
  const document = record(documentValue)
  const nativeWrite = record(document?.nativeWrite)
  if (!nativeWrite) return { available: false, entryPresent: false }

  const refKey = JSON.stringify(['session', provider, sessionId])
  const state = record(nativeWrite[refKey])
  if (!state) return { available: true, entryPresent: false }
  const status = boundedString(state.status, nativeWriteStatuses) as NativeNameDurableState['status']
  const unsyncedReason = typeof state.unsyncedReason === 'string'
    ? nativeUnsyncedReasons.get(state.unsyncedReason)
    : undefined
  const desiredRevision = nonNegativeInteger(state.desiredRevision)
  return {
    available: true,
    entryPresent: true,
    ...(desiredRevision !== undefined ? { desiredRevision } : {}),
    desiredRevisionMatches: desiredRevision === expectedRevision,
    ...(nonNegativeInteger(state.seriesEpoch) !== undefined ? { seriesEpoch: nonNegativeInteger(state.seriesEpoch) } : {}),
    ...(status ? { status } : {}),
    ...(nonNegativeInteger(state.cyclesConsumed) !== undefined ? { cyclesConsumed: nonNegativeInteger(state.cyclesConsumed) } : {}),
    ...(nonNegativeInteger(state.readsConsumed) !== undefined ? { readsConsumed: nonNegativeInteger(state.readsConsumed) } : {}),
    ...(nonNegativeInteger(state.lifecycleBusyDeferrals) !== undefined
      ? { lifecycleBusyDeferrals: nonNegativeInteger(state.lifecycleBusyDeferrals) }
      : {}),
    ...(typeof state.settled === 'boolean' ? { settled: state.settled } : {}),
    retryScheduled: nonNegativeInteger(state.nextDue) !== undefined,
    confirmationPending: typeof state.confirmationPendingReceipt === 'string'
      && state.confirmationPendingReceipt.length > 0,
    ...(unsyncedReason ? { reasonCategory: unsyncedReason } : {}),
  }
}

export async function readNativeTitleDiagnosticFacts(
  read: () => Promise<unknown>,
  expectedSessionId: string,
  expectedTitle: string,
  timeoutMs = NATIVE_TITLE_DIAGNOSTIC_TIMEOUT_MS,
): Promise<NativeTitleDiagnosticFacts> {
  const unavailable = (outcome: 'timeout' | 'failed'): NativeTitleDiagnosticFacts => ({
    outcome,
    idMatchesExpected: false,
    titlePresent: false,
    titleMatchesExpected: false,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<NativeTitleDiagnosticFacts>(resolve => {
    timer = setTimeout(() => resolve(unavailable('timeout')), timeoutMs)
  })
  const observation = Promise.resolve().then(read).then(
    value => ({ outcome: 'readable' as const, ...summarizeNativeTitleObservation(value, expectedSessionId, expectedTitle) }),
    () => unavailable('failed'),
  )
  try {
    return await Promise.race([observation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function summarizeNativeNameWorkerLogs(output: string | readonly string[]): {
  lineCount: number
  records: NativeNameWorkerEvent[]
} {
  const chunks = typeof output === 'string' ? [output] : output
  let tail = ''
  for (const chunk of chunks) {
    if (chunk.length >= MAX_SERVER_LOG_TAIL_CHARS) {
      tail = chunk.slice(-MAX_SERVER_LOG_TAIL_CHARS)
    } else {
      const combined = `${tail}${tail ? '\n' : ''}${chunk}`
      tail = combined.length > MAX_SERVER_LOG_TAIL_CHARS
        ? combined.slice(-MAX_SERVER_LOG_TAIL_CHARS)
        : combined
    }
  }
  const eventNames = new Map<string, NativeNameWorkerEvent['event']>([
    ['session_names.native_cycle_deferred', 'deferred'],
    ['session_names.native_cycle_deferrals_exhausted', 'exhausted'],
    ['session_names.native_cycle_deferral_stale', 'stale'],
  ])
  const records = tail.split('\n').flatMap(line => {
    let row: Record<string, unknown> | undefined
    try { row = record(JSON.parse(line)) } catch { return [] }
    if (!row) return []
    const rawEvent = [row.event, row.msg, row.message]
      .find(value => typeof value === 'string' && eventNames.has(value))
    if (typeof rawEvent !== 'string') return []

    const rawSeverity = String(row.level ?? row.severity ?? '').toLowerCase()
    const severity = ['trace', 'debug', 'info', 'warn', 'warning', 'error'].includes(rawSeverity)
      ? rawSeverity as NonNullable<NativeNameWorkerEvent['severity']>
      : undefined
    const operation = boundedString(row.operation, nativeNameOperations) as NativeNameWorkerEvent['operation']
    const numericFields = [
      ['revision', 'revision'],
      ['series_epoch', 'seriesEpoch'],
      ['location_revision', 'locationRevision'],
      ['cycle', 'cycle'],
      ['deferral_count', 'deferralCount'],
      ['retry_in_ms', 'retryInMs'],
    ] as const
    const projected: Record<string, unknown> = {
      event: eventNames.get(rawEvent),
      ...(typeof row.ts === 'string' && Number.isFinite(Date.parse(row.ts))
        ? { atMs: Date.parse(row.ts) }
        : typeof row.at === 'number' && Number.isFinite(row.at) ? { atMs: row.at } : {}),
      ...(severity ? { severity } : {}),
      ...(operation ? { operation } : {}),
      ...(typeof row.refunded_cycle === 'boolean' ? { refundedCycle: row.refunded_cycle } : {}),
      ...(typeof row.refunded_read === 'boolean' ? { refundedRead: row.refunded_read } : {}),
    }
    for (const [source, destination] of numericFields) {
      const value = nonNegativeInteger(row[source])
      if (value !== undefined) projected[destination] = value
    }
    return [projected as NativeNameWorkerEvent]
  }).slice(-MAX_SERVER_LOG_RECORDS)

  return {
    lineCount: tail.split('\n').filter(line => line.length > 0).length,
    records,
  }
}

/** Keep only the time and operation for refusals belonging to this session. */
export function summarizeNativeLifecycleBusyRefusals(
  output: string,
  expectedNativeSessionId: string,
): { lineCount: number; records: NativeLifecycleBusyRefusal[] } {
  const lines = output.split('\n')
  const records = lines.flatMap(line => {
    let row: Record<string, unknown> | undefined
    try { row = record(JSON.parse(line)) } catch { return [] }
    if (!row || row.event !== 'freshagent.native_name_refused') return []
    const data = record(row.data)
    if (data?.nativeSessionId !== expectedNativeSessionId || data.reason !== 'lifecycle_busy') return []
    const operation = boundedString(data.operation, nativeNameOperations) as NativeLifecycleBusyRefusal['operation']
    return [{
      ...(typeof row.at === 'number' && Number.isFinite(row.at) ? { atMs: row.at } : {}),
      ...(operation ? { operation } : {}),
      reason: 'lifecycle_busy' as const,
    }]
  }).slice(-MAX_SERVER_LOG_RECORDS)
  return { lineCount: lines.filter(line => line.length > 0).length, records }
}
