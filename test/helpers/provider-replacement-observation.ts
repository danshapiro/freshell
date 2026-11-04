export interface ReplacementView {
  terminalId?: string
  soulId: string
  incarnationId: string
  intentRevision: number
  nativeSessionId?: string
  launchState: string
  recoveryState?: string
  recoveryReason?: string
  evidenceRevision?: number
  containerId?: string
}

export interface ReplacementFence {
  terminalId: string
  soulId: string
  incarnationId: string
  intentRevision: number
  nativeSessionId?: string
  controlEpoch: number
}

export interface RetryEvent {
  event: string
  data: {
    soulId?: string
    incarnationId?: string
    intentRevision?: number
    controlEpoch?: number
    attemptId?: string
    attemptCount?: number
    nextDueAtMs?: number | null
    reason?: string
  }
}

function preparationRetryIsActive(events: RetryEvent[], before: ReplacementFence): boolean {
  const retries = events.filter(event => event.event.startsWith('supervisor.recovery_retry.')
    && event.data.soulId === before.soulId && event.data.incarnationId === before.incarnationId
    && event.data.intentRevision === before.intentRevision && event.data.controlEpoch === before.controlEpoch)
  const latest = retries.at(-1)
  const scheduled = [...retries].reverse().find(event => event.event === 'supervisor.recovery_retry.scheduled'
    && event.data.reason === 'preparation_unavailable' && Boolean(event.data.attemptId)
    && [1, 2].includes(event.data.attemptCount ?? 0) && Number.isFinite(event.data.nextDueAtMs))
  if (!scheduled) return false
  return latest === scheduled || (latest?.event === 'supervisor.recovery_retry.reserved'
    && Boolean(latest.data.attemptId) && latest.data.attemptId !== scheduled.data.attemptId
    && latest.data.attemptCount === (scheduled.data.attemptCount ?? 0) + 1)
}

export function selectProviderReplacement<T extends ReplacementView>(
  rows: T[], before: ReplacementFence, events: RetryEvent[],
): T | undefined {
  const matching = rows.filter(row => row.terminalId === before.terminalId)
  if (matching.some(row => row.soulId !== before.soulId || row.intentRevision !== before.intentRevision
    || row.nativeSessionId !== before.nativeSessionId)) {
    throw new Error('provider replacement identity fence changed')
  }
  const blocked = matching.find(row => row.recoveryState === 'blocked')
  if (blocked) {
    if (blocked.recoveryReason !== 'CAPABILITY_PENDING' || !preparationRetryIsActive(events, before)) {
      throw new Error(`replacement is blocked: ${blocked.recoveryReason}; evidenceRevision=${blocked.evidenceRevision}`)
    }
    return undefined
  }
  return matching.find(row => row.launchState === 'running'
    && row.recoveryState === 'live' && row.containerId && row.incarnationId !== before.incarnationId)
}

export async function waitForProviderReplacement<T extends ReplacementView>(
  before: ReplacementFence,
  read: () => Promise<{ rows: T[]; events: RetryEvent[] }>,
  deadline: number,
): Promise<T> {
  while (Date.now() < deadline) {
    const { rows, events } = await read()
    if (Date.now() >= deadline) break
    const replacement = selectProviderReplacement(rows, before, events)
    if (replacement) return replacement
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('timed out waiting for provider replacement')
}
