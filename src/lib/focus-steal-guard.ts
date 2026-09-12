// Focus-steal rebuff for non-eligible iframe panes (browser / extension).
//
// Web platform reality (verified empirically in Chromium, Aug 2026):
// `inert` on an iframe blocks sequential-focus entry, pointer hit testing
// AND outer-side programmatic focus — but a SCRIPT INSIDE the nested
// document can still hoist the iframe into the outer document's
// activeElement. No attribute combination (inert, tabindex=-1, sandbox
// w/ or w/o allow-same-origin, inert ancestor) stops that. The hoist is
// event-silent on the winning side (no focus/focusin on the iframe), but
// the displaced element DOES fire focusout (when it was an element) and the
// window fires blur (covers the displaced-is-body case). Also verified:
// calling blur() on the hoisted iframe restores control.
//
// So: panes whose `focusEligible` is false render their iframe with both
// `inert` (blocks pointer/sequential/outer-programmatic entry) AND
// `data-focus-locked` (this guard's marker). When focus lands on a locked
// iframe we blur it and restore focus to the element it displaced.

const LOCKED_ATTR = 'data-focus-locked'

function isLockedIframe(el: Element | null): el is HTMLIFrameElement {
  return !!el && el.tagName === 'IFRAME' && el.hasAttribute(LOCKED_ATTR)
}

/**
 * Install the rebuff listener pair. Returns a disposer. Idempotent with
 * respect to callers (one instance per app via useFocusStealGuard).
 *
 * focusout: element displaced by a hoist. window blur: body was active.
 * The activeElement reassignment is mid-flight during dispatch, so the
 * check runs after a task — deterministic in Chromium and jsdom alike.
 */
export function installFocusStealGuard(): () => void {
  // A disposed guard must never act: every pending rebuff timer is tracked and
  // cancelled by the disposer (otherwise an unmounted App could still blur a
  // later iframe or re-focus an obsolete displaced element). A hoist fires a
  // focusout AND — when body was displaced — a window blur, so MULTIPLE queued
  // rebuffs are legitimate; new events must NOT cancel pending ones (the first
  // may be the only one carrying the displaced element to restore).
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  // Within a burst, only the NEWEST timer restores focus, using the last
  // displaced element the burst saw — otherwise an ordinary A→B transition's
  // queued timer would restore the stale A after a hoist displaced B, and a
  // trailing window-blur (null displaced) would undo a correct restore by
  // targeting body.
  let burstDisplaced: HTMLElement | null = null
  let hoistObservedInBurst = false
  const rebuff = (displaced: HTMLElement | null) => {
    // Blurring the hoisted iframe fires ITS focusout — never capture the locked
    // iframe itself as the burst's displaced element, or the newest timer would
    // "restore" focus right back onto it.
    if (displaced && !isLockedIframe(displaced)) burstDisplaced = displaced
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      const isNewestInBurst = pendingTimers.size === 0
      const active = document.activeElement
      if (isLockedIframe(active)) {
        active.blur()
        hoistObservedInBurst = true
      }
      if (!isNewestInBurst) {
        // Older timer: blur done above; the restore belongs to the newest
        // timer (correct displaced attribution).
        return
      }
      // The burst closes here: restore only if a hoist actually happened.
      const target = burstDisplaced
      burstDisplaced = null
      const wasHoist = hoistObservedInBurst
      hoistObservedInBurst = false
      if (!wasHoist) return
      if (target && document.contains(target)) {
        target.focus()
      } else {
        document.body.focus?.()
      }
    }, 0)
    pendingTimers.add(timer)
  }

  const onFocusOut = (e: FocusEvent) => {
    rebuff(e.target instanceof HTMLElement ? e.target : null)
  }
  const onWindowBlur = () => {
    rebuff(null)
  }

  document.addEventListener('focusout', onFocusOut)
  window.addEventListener('blur', onWindowBlur)
  return () => {
    document.removeEventListener('focusout', onFocusOut)
    window.removeEventListener('blur', onWindowBlur)
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.clear()
  }
}
