import { useLayoutEffect, useState } from 'react'

/**
 * Lock (inert + data-focus-locked) state for panes hosting a nested document
 * (BrowserPane, ExtensionPane).
 *
 * LOCKED ⇔ the pane is not allowed to hold DOM focus: ineligible (hidden tab,
 * non-active pane) OR ownership-denied at mount (agent-driven remount while
 * the user is in app chrome — the nested page's autofocus must not hijack the
 * outer document).
 *
 * Commit-order safety: the adoption read MUST NOT happen during render —
 * React renders the replacement subtree BEFORE the outgoing subtree's layout
 * cleanups write the ownership record, so a render-time read would latch
 * "unknown → allowed" permanently. The read happens in this layout effect:
 * deletions commit (with their records) before this effect runs, and the state
 * update lands before paint.
 *
 * Pointer unlock: there is NO eligibility transition or epoch bump when the
 * user clicks an already-active pane — so without this hook's listener, a
 * denied remount would keep the iframe inert forever. A pointerdown inside the
 * pane shell is the user's intent to use the pane; the lock lifts (the click
 * itself is absorbed by the inert subtree; the NEXT click into the iframe
 * works — standard "click to wake" recovery).
 *
 * Keyboard unlock: Enter/Space on the focused pane shell is Pane.tsx's
 * keyboard activation contract — it dispatches a SAME-target setActivePane,
 * which produces no eligibility transition or epoch bump, so the lock effect
 * would never rerun and the iframe would be keyboard-inaccessible until a
 * switch-away-and-back. Keyboard users get the same wake: Enter/Space targeted
 * at the shell lifts the lock.
 */
export function useIframeFocusLock(
  paneRoot: HTMLElement | null,
  focusEligible: boolean,
  mayFocusNow: () => boolean,
): boolean {
  const [locked, setLocked] = useState(() => !focusEligible)

  // paneRoot comes from a callback-ref STATE (not a ref object): the effect
  // re-runs the moment a deferred element (e.g. a server extension iframe
  // waiting on serverRunning) finally mounts, so the unlock listener always
  // ends up attached to a real DOM node.
  useLayoutEffect(() => {
    setLocked(!focusEligible || !mayFocusNow())
    // Prefer the pane SHELL ([data-pane-shell]; wraps the whole pane including
    // header chrome): with inert applied, pointer hit tests inside the locked
    // subtree retarget to the closest NON-inert ancestor, and the shell is
    // ALSO Pane.tsx's keyboard-activation surface (Enter/Space on the focused
    // shell). The pane component's own root never sees a shell-targeted
    // keydown (capture descends no further than the event target). Fall back
    // to the inner [data-pane-id] carrier, then the element itself, for bare
    // unit renders without a shell.
    const listenTarget =
      (paneRoot?.closest('[data-pane-shell="true"]') as HTMLElement | null)
      ?? (paneRoot?.closest('[data-pane-id]') as HTMLElement | null)
      ?? paneRoot
    if (!listenTarget || !focusEligible) return
    const unlock = () => setLocked(false)
    const unlockOnShellActivation = (event: KeyboardEvent) => {
      // Mirror Pane.tsx's shell keydown contract: only an activation key
      // targeted at the shell itself (e.target === e.currentTarget there)
      // counts, not keys bubbling out of inner focusable content.
      if (event.target === listenTarget && (event.key === 'Enter' || event.key === ' ')) {
        setLocked(false)
      }
    }
    listenTarget.addEventListener('pointerdown', unlock, true)
    listenTarget.addEventListener('keydown', unlockOnShellActivation, true)
    return () => {
      listenTarget.removeEventListener('pointerdown', unlock, true)
      listenTarget.removeEventListener('keydown', unlockOnShellActivation, true)
    }
  }, [paneRoot, focusEligible, mayFocusNow])

  return locked
}
