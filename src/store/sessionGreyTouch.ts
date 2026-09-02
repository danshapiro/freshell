import type { Store } from '@reduxjs/toolkit'
import type { RootState } from '@/store/store'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import { makeSelectSessionStatusTiers } from '@/store/selectors/sessionStatusTiers'

type MinimalStore = Pick<Store<RootState>, 'getState' | 'subscribe' | 'dispatch'>

/**
 * Grey-transition touch watcher (default sidebar sort, second half).
 *
 * When a session's status tier transitions from ANY non-grey state —
 * local-busy, local-open, remote-busy, remote-open — to grey (absent from
 * the tier map), the session is "touched" with updateSessionActivity, which
 * ratchets a monotonic per-session activity timestamp persisted in
 * localStorage. In the default (activity) sort the grey tier consumes that
 * ratchet with presence-priority, so a session that just went grey sorts to
 * the very top of the grey agents.
 *
 * The watcher reads the canonical tier map (makeSelectSessionStatusTiers) so
 * "grey" here can never disagree with what the Sidebar paints. The tier
 * selector is memoized on its inputs, so the subscribe callback is a cheap
 * reference compare unless activity/registry state actually changed.
 *
 * The transition fires per tier-map key; keys always carry a provider prefix
 * (e.g. 'claude:s1', 'opencode:terminal:t-1'), which updateSessionActivity
 * passes through unchanged.
 */
export function startSessionGreyTouchWatcher(store: MinimalStore): () => void {
  const selectTiers = makeSelectSessionStatusTiers()
  let previousTiers = selectTiers(store.getState())

  const unsubscribe = store.subscribe(() => {
    const nextTiers = selectTiers(store.getState())
    if (nextTiers === previousTiers) return
    const outgoing = previousTiers
    // Assign BEFORE dispatching: the touch dispatch re-enters this callback
    // synchronously, and with the fresh reference in place the re-entrant run
    // sees `nextTiers === previousTiers` and exits immediately.
    previousTiers = nextTiers

    const now = Date.now()
    for (const key of Object.keys(outgoing)) {
      if (nextTiers[key] === undefined) {
        store.dispatch(updateSessionActivity({ sessionId: key, lastInputAt: now }))
      }
    }
  })

  return unsubscribe
}
