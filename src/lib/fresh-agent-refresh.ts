export const FRESH_AGENT_REFRESH_TIMEOUT_MS = 15_000

export type RefreshAttemptState = 'pending' | 'succeeded' | 'failed' | 'timed-out' | 'superseded' | 'disposed'

export interface RefreshAttempt {
  identity: string
  requestId: string
  requiredWatermark?: number
  startedAt: number
  deadlineAt: number
  state: RefreshAttemptState
}

export interface BeginRefreshOptions {
  identity: string
  requestId: string
  now: number
  requiredWatermark?: number
  previous?: RefreshAttempt
  preserveDeadline?: boolean
}

export function beginRefresh({
  identity,
  requestId,
  now,
  requiredWatermark,
  previous,
  preserveDeadline = false,
}: BeginRefreshOptions): RefreshAttempt {
  const carriesDeadline = preserveDeadline
    && previous?.identity === identity
    && previous.state === 'pending'
  const attempt: RefreshAttempt = {
    identity,
    requestId,
    startedAt: carriesDeadline ? previous.startedAt : now,
    deadlineAt: carriesDeadline ? previous.deadlineAt : now + FRESH_AGENT_REFRESH_TIMEOUT_MS,
    state: 'pending',
  }
  const nextWatermark = requiredWatermark ?? (carriesDeadline ? previous.requiredWatermark : undefined)
  if (nextWatermark !== undefined) attempt.requiredWatermark = nextWatermark
  return attempt
}

export function settleRefresh(
  current: RefreshAttempt | null | undefined,
  identity: string,
  requestId: string,
  state: Exclude<RefreshAttemptState, 'pending'>,
): RefreshAttempt | null {
  if (!current || current.state !== 'pending'
    || current.identity !== identity || current.requestId !== requestId) return null
  return { ...current, state }
}

export type RefreshDeadlineDisposer = () => void

export function armRefreshDeadline(
  attempt: RefreshAttempt,
  onDeadline: () => void,
  now: () => number = Date.now,
): RefreshDeadlineDisposer {
  if (attempt.state !== 'pending') return () => {}
  let armed = true
  const timer = setTimeout(() => {
    if (!armed) return
    armed = false
    onDeadline()
  }, Math.max(0, attempt.deadlineAt - now()))
  return () => {
    if (!armed) return
    armed = false
    clearTimeout(timer)
  }
}
