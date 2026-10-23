import { useEffect, useRef } from 'react'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import { createLogger } from '@/lib/client-logger'
import { useAppDispatch, useAppStore } from '@/store/hooks'
import {
  liveTailCleared,
  transcriptExpectationsDropped,
  transcriptLanded,
} from '@/store/freshAgentLiveSlice'
import type { FreshAgentLiveSession } from '@/store/freshAgentLiveTypes'

const log = createLogger('useTranscriptLandings')

/**
 * How many extra snapshot reads a pane spends on one announced transcript
 * line that is still missing. The CLI writes a line about 100 ms after it
 * announces it (real-CLI fact F7) and the refetch is debounced 250 ms, so a
 * miss is rare; past this bound the busy poll and the result's refetch still
 * bring the line in (transcript-live plan §4.4).
 */
export const LANDING_RECHECK_MAX = 4

/**
 * The transcript lines a snapshot proves were written: its turns' ids (each
 * claude turn is keyed by its line uuid) and the newest line uuids the server
 * lists separately, which include lines that produce no turn of their own.
 */
export function presentTranscriptLineIds(snapshot: FreshAgentSnapshot): string[] {
  const ids = new Set<string>()
  for (const turn of snapshot.turns) {
    ids.add(turn.turnId)
    ids.add(turn.id)
  }
  const claude = snapshot.extensions?.claude
  const lineUuids = claude && typeof claude === 'object' ? (claude as { transcriptLineUuids?: unknown }).transcriptLineUuids : undefined
  if (Array.isArray(lineUuids)) {
    for (const uuid of lineUuids) if (typeof uuid === 'string') ids.add(uuid)
  }
  return [...ids]
}

function hasLiveContent(tail: FreshAgentLiveSession | undefined): boolean {
  return Boolean(tail && (tail.blocks.length > 0 || tail.retry || tail.expectedTurnIds.length > 0))
}

/**
 * Keeps a pane's live tail in step with the snapshots it commits. On every
 * committed snapshot: the blocks and announced lines it holds are landed; an
 * announced line still missing earns a bounded re-poll; and once nothing is
 * awaited and the turn is over, the tail is cleared — after its lines are on
 * screen, so the text never blinks out between the result and the snapshot.
 * A turn that ends with live content left asks for one more snapshot, so the
 * clear never waits on an unrelated refresh.
 */
export function useTranscriptLandings({
  sessionKey,
  snapshot,
  busy,
  isBusyNow,
  requestRefresh,
}: {
  sessionKey: string | undefined
  snapshot: FreshAgentSnapshot | null
  busy: boolean
  /** The pane's busy state at the moment of the check (not of the last render). */
  isBusyNow: () => boolean
  requestRefresh: () => void
}): void {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const attemptsRef = useRef(new Map<string, number>())
  const isBusyNowRef = useRef(isBusyNow)
  isBusyNowRef.current = isBusyNow
  const requestRefreshRef = useRef(requestRefresh)
  requestRefreshRef.current = requestRefresh

  useEffect(() => {
    attemptsRef.current.clear()
  }, [sessionKey])

  useEffect(() => {
    if (!sessionKey || !snapshot) return
    dispatch(transcriptLanded({ sessionKey, present: presentTranscriptLineIds(snapshot) }))
    const expected = store.getState().freshAgentLive?.bySession[sessionKey]?.expectedTurnIds ?? []
    const attempts = attemptsRef.current
    for (const uuid of [...attempts.keys()]) {
      if (!expected.includes(uuid)) attempts.delete(uuid)
    }
    const exhausted: string[] = []
    let recheck = false
    for (const uuid of expected) {
      const attempt = (attempts.get(uuid) ?? 0) + 1
      if (attempt > LANDING_RECHECK_MAX) {
        exhausted.push(uuid)
        attempts.delete(uuid)
      } else {
        attempts.set(uuid, attempt)
        recheck = true
      }
    }
    if (exhausted.length > 0) {
      log.warn('announced transcript lines did not land; the live tail stops waiting for them', {
        event: 'fresh_agent.transcript_landing_abandoned',
        sessionKey,
        lines: exhausted.length,
        rechecks: LANDING_RECHECK_MAX,
      })
      dispatch(transcriptExpectationsDropped({ sessionKey, uuids: exhausted }))
    }
    if (recheck) {
      requestRefreshRef.current()
      return
    }
    if (!isBusyNowRef.current()) dispatch(liveTailCleared({ sessionKey }))
  }, [dispatch, sessionKey, snapshot, store])

  const wasBusyRef = useRef(busy)
  useEffect(() => {
    const ended = wasBusyRef.current && !busy
    wasBusyRef.current = busy
    if (!ended || !sessionKey) return
    if (hasLiveContent(store.getState().freshAgentLive?.bySession[sessionKey])) requestRefreshRef.current()
  }, [busy, sessionKey, store])
}
