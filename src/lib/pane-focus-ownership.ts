// Pane focus-ownership memory: an agent-driven leaf→split REMOUNTS the split
// pane's DOM subtree. Mount-time autofocus (terminal, browser root, editor,
// pickers, extension iframe) previously keyed only off Redux eligibility — so
// an agent split executed while the user was interacting with app chrome
// (sidebar, tab strip) yanked DOM focus back into the remounted pane.
//
// Pane-content components record, at unmount time, whether their pane OWNED
// document focus — and, when it did, a best-effort stable selector for the
// exact element that held it (URL field, search input, composer). Their
// eligible-MOUNT focus then gates on this record, and the recorded element is
// re-resolved and refocused after the component's own mount focus ran, so a
// legitimate re-adoption restores the user's ACTUAL focus target instead of
// the content's default. Explicit selects (false→true eligibility flips and
// same-target epoch bumps) bypass the gate entirely.
//
// Semantics: unknown pane ids (fresh creation, app reload w/ persisted layout)
// default to "may focus" — preserving the long-standing user-driven UX where
// creating a pane in the active tab focuses it.
//
// Transient in-pane UI (an open terminal search bar, an in-progress pane
// rename) does not survive a leaf→split remount at all — that is pre-existing
// remount parity, identical for user-driven splits; the descriptor restore
// covers only elements that re-render on remount.

export interface PaneFocusRecord {
  owned: boolean
  /** Best-effort stable selector (within the pane root) for the focused
   *  element, or null when none could be derived. ':scope' means the pane
   *  root itself held focus (the pane shell is tabbable). */
  selector: string | null
  /** Selection serial at record time; a restore skips if any explicit
   *  pane-selection activity landed since (newer selection wins). */
  serialAtRecord?: number

  /** Set while a mount-window restore for this pane is scheduled but has not
   *  fired. During that window a teardown must NOT overwrite the descriptor:
   *  the intermediate remount's own autofocus artifact (or blank focus) is
   *  in-flight, and the pre-split record is the only correct one. Cleared when
   *  the restore fires. */
  restorePending?: boolean
}

const recordByPaneId = new Map<string, PaneFocusRecord>()

/** Monotonic serial bumped on ANY explicit pane-selection activity (Redux
 *  activePane change — pointer clicks included — or a focus-epoch nudge from
 *  the select folds). A restore recorded before the activity must not fire
 *  after it: the newer selection, user or scripted, is the truth and wins. */
let paneSelectionSerial = 0

/** Escape a value for use inside a quoted attribute selector. */
function attrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Derive the most stable UNIQUELY-resolving selector for `el` within `root`.
 *  Candidate order: pane-root sentinel (`:scope`) → id → aria-label →
 *  data-testid → placeholder → role → sole-iframe → title → data-context.
 *  A candidate is only accepted when it matches exactly one element, so
 *  re-resolution after a remount can never land on a sibling. */
function describeInnerSelector(el: HTMLElement, root: Element): string | null {
  if (el === root) return ':scope'
  const tag = el.tagName.toLowerCase()
  const candidates: string[] = []
  if (el.id) candidates.push(`#${CSS.escape(el.id)}`)
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) candidates.push(`${tag}[aria-label="${attrValue(ariaLabel)}"]`)
  const testId = el.getAttribute('data-testid')
  if (testId) candidates.push(`[data-testid="${attrValue(testId)}"]`)
  const placeholder = el.getAttribute('placeholder')
  if (placeholder) candidates.push(`${tag}[placeholder="${attrValue(placeholder)}"]`)
  const role = el.getAttribute('role')
  if (role) candidates.push(`${tag}[role="${attrValue(role)}"]`)
  // Embedded pages: a focused browser/extension iframe carries no other usable
  // attribute, and these panes host exactly one.
  if (tag === 'iframe' && root.querySelectorAll('iframe').length === 1) candidates.push('iframe')
  const title = el.getAttribute('title')
  if (title) candidates.push(`${tag}[title="${attrValue(title)}"]`)
  const dataContext = el.getAttribute('data-context')
  if (dataContext) candidates.push(`${tag}[data-context="${attrValue(dataContext)}"]`)
  for (const sel of candidates) {
    // User-derived attribute text (e.g. an aria-label carrying a full chat
    // message) can contain newlines or other CSS string terminators that make
    // the quoted selector unparseable — skip that candidate, not the record.
    if (/[\n\r\f]/.test(sel)) continue
    try {
      if (root.querySelectorAll(sel).length === 1 && root.querySelector(sel) === el) return sel
    } catch {
      // unbuildable selector — try the next candidate
    }
  }
  return null
}

/** Record, at unmount time, whether the pane's subtree currently owns
 *  document focus (and which element holds it). Reads the pane root by its
 *  `data-pane-id` attribute (the Pane wrapper carries it for every content
 *  type). MUST be called from a useLayoutEffect cleanup — passive-effect
 *  cleanups run after DOM detach. When no root is found (bare unit-test
 *  renders), nothing is recorded; unknown ids default to "may focus". */
export function recordPaneFocusBeforeUnmount(paneId: string): void {
  const root = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
  if (!root) return
  // An in-flight remount's restore owns the descriptor: the intermediate
  // subtree's focus is either blank or the remount's own autofocus artifact —
  // never the user. Burst splits (rapid sequential agent commands) must not
  // overwrite the pre-split record with it.
  const existing = recordByPaneId.get(paneId)
  if (existing?.restorePending) return
  const active = document.activeElement
  const owned = Boolean(active && root.contains(active))
  // LRU: refreshing an existing pane must move it to newest — `Map.set` on an
  // existing key keeps its original position, which would let a long-lived,
  // freshly re-recorded pane be evicted at the cap ahead of true ancients.
  if (recordByPaneId.has(paneId)) recordByPaneId.delete(paneId)
  recordByPaneId.set(paneId, {
    owned,
    selector: owned && active instanceof HTMLElement ? describeInnerSelector(active, root) : null,
    serialAtRecord: paneSelectionSerial,
  })
  // Bound growth across long sessions (closed panes leave stale entries):
  // evict the OLDEST entries (Maps iterate in insertion order). Never wipe
  // the whole map — that would erase the record this very write just made.
  const CAP = 512
  if (recordByPaneId.size > CAP) {
    const evict = recordByPaneId.size - CAP
    let i = 0
    for (const key of recordByPaneId.keys()) {
      if (i++ >= evict) break
      recordByPaneId.delete(key)
    }
  }
}

/** Whether an eligible mount may pull DOM focus. Unknown pane ids (freshly
 *  created panes) focus as before; a remounted pane only re-focuses if it
 *  owned focus before its previous unmount. */
export function shouldFocusPaneOnEligibleMount(paneId: string): boolean {
  const record = recordByPaneId.get(paneId)
  if (!record) return true
  // A selection newer than the record voids it for adoption: the pane mounts
  // fresh under a new selection context (e.g. a close-promoted sibling that
  // is already Redux-active — no flip transition will ever run), so apply
  // unknown-pane semantics. In-flight pending windows keep their record.
  if (!record.restorePending && record.serialAtRecord !== paneSelectionSerial) return true
  if (record.owned === false && document.activeElement === document.body) {
    // Focus STRANDED on body: the element that held focus is gone (the old
    // subtree was destroyed) and typing has no destination. An eligible mount
    // must claim it — an eligible pane that never adopts focus strands
    // keyboard input permanently. The cost side (an agent remount stealing
    // focus a user deliberately parked on nothing-focusable) is far rarer and
    // far cheaper than stranded focus; the two cases are indistinguishable at
    // record time (round-14 review), so stranding always wins. restorePending
    // is irrelevant here: the hook schedules it synchronously at mount, BEFORE
    // components' passive focus effects call mayFocusNow, so needing this
    // exception always coincides with pending (round-16 review).
    return true
  }
  return record.owned !== false
}

/** Post-mount restore: re-resolve the recorded inner element inside the
 *  pane's NEW subtree. Returns null when the pane was not recorded as owning
 *  focus, when no stable selector exists, when the pane is in a hidden tab,
 *  or when the element did not come back (e.g. transient UI like an open
 *  search bar — the content's default focus target stands in that case). */
export function resolveRecordedFocusTarget(paneId: string): HTMLElement | null {
  const record = recordByPaneId.get(paneId)
  if (!record?.owned || !record.selector) return null
  const root = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
  if (!root || root.closest('.tab-hidden')) return null
  let el: Element | null
  if (record.selector === ':scope') {
    el = root
  } else {
    // Uniqueness was verified at record time, but the tree was rebuilt since:
    // re-verify in the CURRENT subtree — a non-unique hit (e.g. a second
    // identically-labelled control materialized after a split/resize) is
    // ambiguous, so resolving to the first match could steal focus for a
    // sibling. Ambiguity abandons the restore rather than guessing.
    const matches = root.querySelectorAll(record.selector)
    el = matches.length === 1 ? matches[0] : null
  }
  return el instanceof HTMLElement ? el : null
}

/** True when the pane's recorded descriptor still speaks for the CURRENT
 *  window: it resolves in the live subtree AND no explicit selection has
 *  landed since the record (selection serial unchanged). Components whose
 *  autofocus completes asynchronously (Monaco onMount) must defer to the
 *  scheduled descriptor restore ONLY in that case — once a newer selection
 *  lands, that selection's own focus path owns the outcome and the component
 *  may autofocus its normal target. */
export function shouldRecordSuppressAutofocus(paneId: string): boolean {
  const record = recordByPaneId.get(paneId)
  if (!record || record.serialAtRecord !== paneSelectionSerial) return false
  return resolveRecordedFocusTarget(paneId) !== null
}

/** Schedule the mount-window restore for a pane: marks the record
 *  restore-pending (suppressing mid-burst descriptor overwrites), then after
 *  components' own mount focus ran (their passive/rAF focus runs first; this
 *  lands last) re-focuses the recorded element. Restore is governed by the
 *  RECORD, not the adoption gate: a pane that genuinely held DOM focus before
 *  teardown gets it back even when Redux focus eligibility says otherwise
 *  (e.g. the user Tabbed onto a Redux-inactive pane shell — Pane's shell is
 *  keyboard-focusable without changing activePane). Returns a cancel fn. */
export function schedulePaneFocusRestore(paneId: string): () => void {
  const record = recordByPaneId.get(paneId)
  if (record) record.restorePending = true
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(() => {
      if (cancelled) return
      if (record) record.restorePending = false
      // A newer explicit selection (user click, scripted select) since the
      // record was taken WINS: do not drag focus back to this pane.
      if (record && record.serialAtRecord !== paneSelectionSerial) return
      const el = resolveRecordedFocusTarget(paneId)
      if (!el?.isConnected) return
      // DOM-level supersedence: focus that landed somewhere CONCRETE since
      // the teardown — another pane (e.g. an activating user split's new
      // pane autofocus, which the Redux serial cannot see because the record
      // was taken after the reassignment), a picker, app chrome the user
      // clicked — is not ours to yank back. Only body-level (truly lost)
      // focus, or focus still inside this pane's subtree, may be restored.
      const rootId = el.closest('[data-pane-id]')?.getAttribute('data-pane-id')
      const active = document.activeElement
      if (
        active instanceof HTMLElement
        && active !== document.body
        && active.closest('[data-pane-id]')?.getAttribute('data-pane-id') !== rootId
      ) {
        // NB: pane shells and inner content roots both carry the same
        // data-pane-id; compare IDS, not element identity — focus inside the
        // same pane's nested roots is not supersedence.
        return
      }
      el.focus()
    }, 0)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (timer !== null) clearTimeout(timer)
  }
}

type LayoutNodeLike = { type?: string; id?: string; children?: LayoutNodeLike[] }

function collectLivePaneIds(layouts: Record<string, LayoutNodeLike> | undefined): Set<string> {
  const live = new Set<string>()
  const walk = (node: LayoutNodeLike | undefined) => {
    if (!node) return
    if (node.type === 'split') {
      for (const child of node.children ?? []) walk(child)
    } else if (node.id) live.add(node.id)
  }
  for (const root of Object.values(layouts ?? {})) walk(root)
  return live
}

/** Middleware-side selection tracking: explicit selection folds
 *  (setActivePane / nudgePaneFocus / setActiveTab) bump the selection serial.
 *  State-subscription comparison cannot tell a pointer click from anything
 *  else, hence this is action-driven.
 *
 *  Other user gestures reach the selection WITHOUT those folds: default-
 *  activating addTab (new-tab shortcut / mobile strip / first tab),
 *  switchToNextTab/switchToPrevTab (keyboard navigation), default-activating
 *  splitPane (user split), addPane (local split), and the fallback selection
 *  when removeTab/closePane removes the ACTIVE item (Alt+W, close buttons).
 *  Those bump the serial only when the selection ACTUALLY moved —
 *  agent folds pass activate:false and close-path fallback for background
 *  items moves nothing, so both stay serial-invisible. */
const TAB_SELECTION_ACTIONS = new Set([
  'tabs/addTab',
  'tabs/switchToNextTab',
  'tabs/switchToPrevTab',
  // Closing the ACTIVE tab selects a survivor (removeTab fallback) — that
  // movement is selection activity; background closes move nothing.
  'tabs/removeTab',
])

const PANE_SELECTION_ACTIONS = new Set([
  'panes/splitPane',
  'panes/addPane',
  // Closing the ACTIVE pane promotes a sibling — selection activity.
  'panes/closePane',
])

export const paneSelectionMiddleware =
  (store: {
    getState: () => {
      tabs?: { activeTabId?: string | null }
      panes?: { activePane?: Record<string, string> }
    }
  }) =>
  (next: (action: unknown) => unknown) =>
  (action: unknown): unknown => {
    const a = action as { type?: string; payload?: { tabId?: string } } | null
    if (
      a?.type === 'panes/setActivePane'
      || a?.type === 'panes/nudgePaneFocus'
      || a?.type === 'tabs/setActiveTab'
    ) {
      paneSelectionSerial += 1
      return next(action)
    }
    if (a?.type && TAB_SELECTION_ACTIONS.has(a.type)) {
      const before = store.getState().tabs?.activeTabId
      const result = next(action)
      if (store.getState().tabs?.activeTabId !== before) {
        paneSelectionSerial += 1
      }
      return result
    }
    if (a?.type && PANE_SELECTION_ACTIONS.has(a.type)) {
      const tabId = a?.payload?.tabId
      if (!tabId) return next(action)
      const before = store.getState().panes?.activePane?.[tabId]
      const result = next(action)
      if (store.getState().panes?.activePane?.[tabId] !== before) {
        paneSelectionSerial += 1
      }
      return result
    }
    return next(action)
  }

/** Bump the selection serial directly (exported for tests wiring adoption
 *  records into stores that lack the paneSelectionMiddleware). */
export function notePaneSelectionActivity(): void {
  paneSelectionSerial += 1
}

/** Wire record invalidation to the live store (called once from store.ts;
 *  selection tracking lives in paneSelectionMiddleware).
 *
 *  Forget records for panes that (re)APPEAR in the layout set. Forgetting on
 *  arrival — rather than on removal — is immune to commit ordering: React's
 *  teardown record for a closing pane lands AFTER the store update, so
 *  removal-deletion would always be undone by the record. Closing tabs can
 *  leave a lingering owned:false record; if the tab is reopened
 *  (reopenClosedTab preserves leaf ids) arrival-forgetting clears it so the
 *  restored pane mounts as fresh "unknown" (normal mount focus), and pending
 *  flags of dead panes are GC'd the next time their pane id reappears. */
export function wirePaneFocusOwnershipInvalidation(storeLike: {
  subscribe: (listener: () => void) => () => void
  getState: () => {
    panes?: {
      layouts?: Record<string, LayoutNodeLike>
    }
  }
}): () => void {
  let prevLayouts = storeLike.getState().panes?.layouts
  let prevLive = collectLivePaneIds(prevLayouts)
  return storeLike.subscribe(() => {
    const panes = storeLike.getState().panes
    if (!panes) return
    if (panes.layouts !== prevLayouts) {
      prevLayouts = panes.layouts
      const nextLive = collectLivePaneIds(panes.layouts)
      for (const id of nextLive) {
        if (!prevLive.has(id)) recordByPaneId.delete(id)
      }
      prevLive = nextLive
    }
  })
}

/** Test-only: whether an in-flight restore window is still pending. */
export function isPaneFocusRestorePendingForTests(paneId: string): boolean {
  return recordByPaneId.get(paneId)?.restorePending === true
}

/** The monotonic selection serial — bumped by every explicit pane-selection
 *  activity (wired via paneSelectionMiddleware). Focus-ownership records
 *  captured before a later selection are voided for adoption/restore: the
 *  newer selection, user or scripted, is the truth and wins. */
export function getPaneSelectionSerial(): number {
  return paneSelectionSerial
}

/** Test-only helper: erase all remembered ownership. */
export function resetPaneFocusOwnershipForTests(): void {
  recordByPaneId.clear()
}
