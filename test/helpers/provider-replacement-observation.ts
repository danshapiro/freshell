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
  at?: number
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

const RETRY_EVENT_VISIBILITY_GRACE_MS = 1_500

function preparationRetryIsActive(events: RetryEvent[], before: ReplacementFence): boolean {
  const retries = events.filter(event => event.event.startsWith('supervisor.recovery_retry.')
    && event.data.soulId === before.soulId && event.data.incarnationId === before.incarnationId
    && event.data.intentRevision === before.intentRevision && event.data.controlEpoch === before.controlEpoch)
  const latest = retries.at(-1)
  const scheduled = [...retries].reverse().find(event => event.event === 'supervisor.recovery_retry.scheduled'
    && event.data.reason === 'preparation_unavailable' && Boolean(event.data.attemptId)
    && [1, 2].includes(event.data.attemptCount ?? 0) && Number.isFinite(event.data.nextDueAtMs))
  if (!scheduled) {
    return latest?.event === 'supervisor.recovery_retry.reserved'
      && latest.data.reason === 'reserved'
      && Boolean(latest.data.attemptId)
      && latest.data.attemptCount === 1
  }
  return latest === scheduled || (latest?.event === 'supervisor.recovery_retry.reserved'
    && Boolean(latest.data.attemptId) && latest.data.attemptId !== scheduled.data.attemptId
    && latest.data.attemptCount === (scheduled.data.attemptCount ?? 0) + 1)
}

function retryEventMayBeUnobserved(
  events: RetryEvent[], before: ReplacementFence, pendingSinceMs: number,
): boolean {
  const retries = events.filter(event => event.event.startsWith('supervisor.recovery_retry.')
    && event.data.soulId === before.soulId)
  const latest = retries.at(-1)
  if (!latest) return true

  const sameFence = latest.data.incarnationId === before.incarnationId
    && latest.data.intentRevision === before.intentRevision
    && latest.data.controlEpoch === before.controlEpoch
  return !sameFence && typeof latest.at === 'number' && latest.at < pendingSinceMs - 2_000
}

export function selectProviderReplacement<T extends ReplacementView>(
  rows: T[], before: ReplacementFence, events: RetryEvent[],
): T | undefined {
  const matching = rows.filter(row => row.terminalId === before.terminalId)
  if (matching.some(row => row.soulId !== before.soulId || row.intentRevision !== before.intentRevision
    || row.nativeSessionId !== before.nativeSessionId)) {
    throw new Error('provider replacement identity fence changed')
  }
  const replacement = matching.find(row => row.launchState === 'running'
    && row.recoveryState === 'live' && row.containerId && row.incarnationId !== before.incarnationId)
  if (replacement) return replacement

  const blocked = matching.find(row => row.recoveryState === 'blocked')
  if (blocked) {
    const retryActive = preparationRetryIsActive(events, before)
    if (blocked.recoveryReason !== 'CAPABILITY_PENDING' || !retryActive) {
      const retryState = retryActive ? 'active' : 'absent_or_invalid'
      const retryEvents = events.filter(event => event.event.startsWith('supervisor.recovery_retry.')
        && event.data.soulId === before.soulId).map(event => ({
          event: event.event,
          soulId: event.data.soulId,
          incarnationId: event.data.incarnationId,
          intentRevision: event.data.intentRevision,
          controlEpoch: event.data.controlEpoch,
          attemptId: event.data.attemptId,
          attemptCount: event.data.attemptCount,
          nextDueAtMs: event.data.nextDueAtMs,
          reason: event.data.reason,
        }))
      const expectedFence = {
        soulId: before.soulId,
        incarnationId: before.incarnationId,
        intentRevision: before.intentRevision,
        controlEpoch: before.controlEpoch,
      }
      throw new Error(`replacement is blocked: ${blocked.recoveryReason}; evidenceRevision=${blocked.evidenceRevision}; retryAuthorization=${retryState}; expectedFence=${JSON.stringify(expectedFence)}; observedRetryEvents=${JSON.stringify(retryEvents)}`)
    }
    return undefined
  }
  return undefined
}

export async function waitForProviderReplacement<T extends ReplacementView>(
  before: ReplacementFence,
  read: () => Promise<{ rows: T[]; events: RetryEvent[] }>,
  deadline: number,
  previouslyAuthorizedRetries: RetryEvent[] = [],
): Promise<T> {
  let pendingSinceMs: number | undefined
  while (Date.now() < deadline) {
    const { rows, events } = await read()
    const retryEvents = [...previouslyAuthorizedRetries, ...events]
    if (Date.now() >= deadline) break

    const blocked = rows.find(row => row.terminalId === before.terminalId
      && row.recoveryState === 'blocked' && row.recoveryReason === 'CAPABILITY_PENDING')
    if (blocked) {
      pendingSinceMs ??= Date.now()
      if (!preparationRetryIsActive(retryEvents, before)
        && retryEventMayBeUnobserved(retryEvents, before, pendingSinceMs)) {
        const graceRemaining = RETRY_EVENT_VISIBILITY_GRACE_MS - (Date.now() - pendingSinceMs)
        if (graceRemaining > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(100, graceRemaining, deadline - Date.now())))
          continue
        }
      }
    }

    const replacement = selectProviderReplacement(rows, before, retryEvents)
    if (replacement) return replacement
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('timed out waiting for provider replacement')
}
