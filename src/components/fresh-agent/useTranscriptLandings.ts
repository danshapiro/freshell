import { useEffect, useRef } from 'react'
import { createLogger } from '@/lib/client-logger'
import type { LandedTranscript } from '@/lib/fresh-agent-landed-transcript'
import { useAppDispatch, useAppStore } from '@/store/hooks'
import {
  liveTailCleared,
  liveTailViewerAdded,
  liveTailViewerRemoved,
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

function hasLiveContent(tail: FreshAgentLiveSession | undefined): boolean {
  return Boolean(tail && (tail.blocks.length > 0 || tail.retry || tail.expectedTurnIds.length > 0))
}

/**
 * Keeps a pane's live tail in step with the snapshots it commits. On every
 * committed snapshot (`landed`, derived once per snapshot): the blocks and
 * announced lines it holds are landed; an announced line still missing earns
 * a bounded re-poll; and once nothing is awaited and the turn is over, the
 * tail is cleared — after its lines are on screen, so the text never blinks
 * out between the result and the snapshot. A turn that ends with live content
 * left asks for one more snapshot, so the clear never waits on an unrelated
 * refresh. While the pane is visible it is one of the tail's viewers: a tail
 * no visible pane settles is dropped when its turn ends.
 */
export function useTranscriptLandings({
  sessionKey,
  visible,
  landed,
  busy,
  isBusyNow,
  requestRefresh,
}: {
  sessionKey: string | undefined
  /** Whether the pane shows (and so refreshes) its transcript now. */
  visible: boolean
  /** What the committed snapshot holds; null before the first one. */
  landed: LandedTranscript | null
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
    if (!sessionKey || !visible) return
    dispatch(liveTailViewerAdded({ sessionKey }))
    return () => {
      dispatch(liveTailViewerRemoved({ sessionKey }))
    }
  }, [dispatch, sessionKey, visible])

  useEffect(() => {
    if (!sessionKey || !landed) return
    dispatch(transcriptLanded({
      sessionKey,
      present: [...landed.lineIds],
      messageBlockKinds: landed.messageBlockKinds,
    }))
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
  }, [dispatch, landed, sessionKey, store])

  const wasBusyRef = useRef(busy)
  useEffect(() => {
    const ended = wasBusyRef.current && !busy
    wasBusyRef.current = busy
    if (!ended || !sessionKey) return
    if (hasLiveContent(store.getState().freshAgentLive?.bySession[sessionKey])) requestRefreshRef.current()
  }, [busy, sessionKey, store])
}
