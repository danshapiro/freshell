import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  recordPaneFocusBeforeUnmount,
  schedulePaneFocusRestore,
  shouldFocusPaneOnEligibleMount,
} from '@/lib/pane-focus-ownership'

type AdoptionState = 'pending' | 'allowed' | 'denied'

/**
 * Mount-time focus-adoption gate (agent focus neutrality).
 *
 * Pane content components auto-focus on eligible mounts and on false→true
 * eligibility flips (explicit select). Flips always focus. Eligible MOUNTS are
 * gated by recorded focus ownership: an agent-driven leaf→split REMOUNTS the
 * pane subtree, and Redux eligibility alone cannot distinguish "user split a
 * pane they were typing in" from "agent split while the user was in the
 * sidebar" — the pre-unmount ownership record can.
 *
 * The decision is consumed lazily via the returned `mayFocusNow`, so
 * components whose focus target materializes asynchronously (Monaco onMount,
 * a deferred extension iframe, terminal attach) evaluate it when the focus
 * would actually happen, not when the effect first ran.
 *
 * Two explicit-select signals ALWAYS resolve adoption to 'allowed', even when
 * a mount adoption already resolved 'denied' (an agent split while the user
 * was in app chrome must not strand the pane unfocused forever):
 *  - false→true eligibility flips (tab switch back, pane re-activation);
 *  - `focusEpoch` changes (the per-pane nudge bumped by same-target select
 *    verbs, which produce no eligibility transition). Because `mayFocusNow`'s
 *    identity changes with the epoch, consumers' focus effects simply re-run
 *    on an explicit same-target select.
 */
export function usePaneFocusAdoption(
  paneId: string | undefined,
  focusEligible: boolean,
  focusEpoch = 0,
): () => boolean {
  const adoptionRef = useRef<AdoptionState>('pending')
  const wasIneligibleRef = useRef(!focusEligible)
  const epochRef = useRef(focusEpoch)

  // Render-phase flip/epoch detection (same pattern as TerminalView's
  // render-synced refs): an explicit select resolves adoption to 'allowed'
  // immediately, so even a focus target that materializes later focuses
  // unconditionally.
  if (focusEpoch !== epochRef.current) {
    epochRef.current = focusEpoch
    adoptionRef.current = 'allowed'
  } else if (focusEligible && wasIneligibleRef.current) {
    adoptionRef.current = 'allowed'
  }
  wasIneligibleRef.current = !focusEligible

  const mayFocusNow = useCallback((): boolean => {
    // focusEpoch is a deliberate identity input ONLY: an epoch bump re-creates
    // this callback so consumers' focus effects re-run on same-target selects.
    void focusEpoch
    // Without a pane identity there is no ownership record — behave exactly
    // like a freshly created pane (which also defaults to "may focus").
    if (!paneId) return true
    if (adoptionRef.current === 'pending') {
      adoptionRef.current = shouldFocusPaneOnEligibleMount(paneId) ? 'allowed' : 'denied'
    }
    return adoptionRef.current === 'allowed'
  }, [paneId, focusEpoch])

  // Record ownership at teardown. MUST be a layout-effect cleanup: passive
  // cleanups run after the DOM subtree is detached and could not answer the
  // contains() question.
  useLayoutEffect(() => {
    if (!paneId) return
    return () => recordPaneFocusBeforeUnmount(paneId)
  }, [paneId])

  // Mount-window element restore: a pane that OWNED DOM focus before teardown
  // gets the exact recorded element back (URL field, search input, composer,
  // the pane shell itself) — preferring it over the content's default target.
  // This is RECORD-driven, not adoption-gated: Redux-ineligible panes restore
  // too (the pane shell is keyboard-focusable without becoming activePane, so
  // a split of such a pane must return its focus). Runs after components' own
  // mount focus (their passive/rAF focus runs first; this lands last).
  useLayoutEffect(() => {
    if (!paneId) return
    return schedulePaneFocusRestore(paneId)
  }, [paneId])

  return mayFocusNow
}
