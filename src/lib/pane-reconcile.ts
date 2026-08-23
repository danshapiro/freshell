/**
 * pane.reconcile client adoption: request builder + verdict folding.
 *
 * FOLD-OWNERSHIP RULE (pinned; applies to every consumer):
 * The correlation mechanism is the EXISTING `ws.onMessage` broadcast
 * subscription (ws-client) — there is NO separate correlator module.
 * Each requester (App boot reconcile, TerminalView exhaustion
 * auto-resolve, warming-banner Retry) folds ONLY results whose
 * `reconcileId` it minted, silently skipping foreign ones. This is what
 * prevents double-folds when several requesters are live at once.
 *
 * This module provides pure builders and the fold function; consumers
 * send the request over the socket themselves and enforce ownership.
 */
import { nanoid } from 'nanoid'
import type {
  PaneReconcileRequest,
  PaneReconcileResultMessage,
  ReconcilePane,
} from '@shared/ws-protocol'
import type { FreshAgentRuntimeProvider } from '@shared/fresh-agent'
import { buildRestoreError } from '@shared/session-contract'
import type { AppDispatch, RootState } from '@/store/store'
import type {
  DeadSessionEntry,
  FreshAgentPaneContent,
  PaneNode,
  TerminalPaneContent,
} from '@/store/paneTypes'
import {
  applyFreshAgentReconcileAttach,
  applyReconcileAttach,
  resetFreshAgentPaneForReconcileCreate,
  resetPaneForReconcileCreate,
  setDeadSessionAdjudication,
  setPaneReconcileNotice,
  setPaneRestoreError,
  setReconcileWarming,
} from '@/store/panesSlice'
import { clearSessionLost } from '@/store/freshAgentSlice'
import { derivePaneTitle } from '@/lib/derivePaneTitle'

/** Protocol cap on request size (mirrors PaneReconcileRequestSchema). */
const MAX_RECONCILE_PANES = 200

/** Bounded wait for a boot `pane.reconcile.result`: > the server's single 2s warming deferral + round-trip margin. */
export const RECONCILE_RESULT_WAIT_MS = 10_000

export function paneKeyFor(tabId: string, paneId: string): string {
  return `${tabId}:${paneId}`
}

/** ONE shared tree walk visiting every reconcilable leaf (terminal or fresh-agent). */
function forEachReconcilablePane(
  layouts: Record<string, PaneNode>,
  visit: (tabId: string, paneId: string, content: TerminalPaneContent | FreshAgentPaneContent) => void,
): void {
  for (const [tabId, layout] of Object.entries(layouts)) {
    ;(function walk(node: PaneNode | undefined) {
      if (!node) return
      if (node.type === 'leaf') {
        if (node.content?.kind === 'terminal' || node.content?.kind === 'fresh-agent') {
          visit(tabId, node.id, node.content)
        }
        return
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) walk(child)
      }
    })(layout)
  }
}

function forEachTerminalPane(
  layouts: Record<string, PaneNode>,
  visit: (tabId: string, paneId: string, content: TerminalPaneContent) => void,
): void {
  forEachReconcilablePane(layouts, (tabId, paneId, content) => {
    if (content.kind === 'terminal') visit(tabId, paneId, content)
  })
}

function forEachFreshAgentPane(
  layouts: Record<string, PaneNode>,
  visit: (tabId: string, paneId: string, content: FreshAgentPaneContent) => void,
): void {
  forEachReconcilablePane(layouts, (tabId, paneId, content) => {
    if (content.kind === 'fresh-agent') visit(tabId, paneId, content)
  })
}

// Capability latch for the fresh-agent widening (mirrors
// setPaneReconcileActive in src/lib/terminal-restore.ts). App sets it on
// every ready from `capabilities.paneReconcileFreshAgentV1`, and resets it
// to false on a capability-less ready.
let freshAgentReconcileActive = false
export function setFreshAgentReconcileActive(active: boolean): void {
  freshAgentReconcileActive = active
}
export function isFreshAgentReconcileActive(): boolean {
  return freshAgentReconcileActive
}

/**
 * Pane-tree walk shared with App's terminal-invalidation handling:
 * find the {tabId, paneId} of every terminal pane whose terminalId is
 * in the given set. (Moved here from App.tsx so the reconcile request
 * builder and App share ONE walk.)
 */
export function collectTerminalPaneTargets(
  layouts: Record<string, PaneNode>,
  terminalIds: string[],
): Array<{ tabId: string; paneId: string }> {
  const terminalIdSet = new Set(terminalIds)
  const targets: Array<{ tabId: string; paneId: string }> = []
  forEachTerminalPane(layouts, (tabId, paneId, content) => {
    if (content.terminalId && terminalIdSet.has(content.terminalId)) {
      targets.push({ tabId, paneId })
    }
  })
  return targets
}

/// The ONE durable-identity claim a reconcile pane carries: the canonical
/// sessionRef, with a legacy-only pane's `resumeSessionId` promoted into it
/// ({provider, sessionId} — the same promotion rule the server's
/// `promoted_legacy_claim` in `reconcile.rs` applies). The legacy wire field
/// is NOT sent; the server-side reconcile door is the permanent compat
/// exception (kata ejh6 section 2).
function effectiveReconcileSessionRef(
  sessionRef: { provider: string; sessionId: string } | undefined,
  resumeSessionId: string | undefined,
  mode: string,
): { provider: string; sessionId: string } | undefined {
  if (sessionRef) return sessionRef
  // Mirror the server's promoted_legacy_claim exclusion
  // (crates/freshell-ws/src/reconcile.rs:~165-177): shell/empty modes NEVER
  // promote — a stateless shell has no durable identity (review round 3,
  // finding 6 — the client must match or a stale shell pane becomes a
  // structured sessionRef{provider:'shell'} and bypasses the server's
  // fresh-verdict rule).
  if (resumeSessionId && mode !== 'shell' && mode !== '') return { provider: mode, sessionId: resumeSessionId }
  return undefined
}

function toReconcilePane(tabId: string, paneId: string, content: TerminalPaneContent): ReconcilePane | null {
  // Panes without a createRequestId cannot be reconciled — skip.
  if (!content.createRequestId) return null
  const sessionRef = effectiveReconcileSessionRef(content.sessionRef, content.resumeSessionId, content.mode)
  return {
    paneKey: paneKeyFor(tabId, paneId),
    kind: 'terminal',
    mode: content.mode,
    createRequestId: content.createRequestId,
    ...(content.terminalId ? { terminalId: content.terminalId } : {}),
    ...(content.serverInstanceId ? { serverInstanceId: content.serverInstanceId } : {}),
    ...(sessionRef ? { sessionRef } : {}),
    ...(content.status ? { status: content.status } : {}),
  }
}

/**
 * Fresh-agent request entry. `mode` carries the runtime provider
 * (claude/codex/opencode) — informational to the server (verdicts key on
 * sessionRef), required non-empty by the wire schema.
 */
function toFreshAgentReconcilePane(
  tabId: string,
  paneId: string,
  content: FreshAgentPaneContent,
): ReconcilePane | null {
  // Panes without a createRequestId cannot be reconciled — skip.
  if (!content.createRequestId) return null
  const sessionRef = effectiveReconcileSessionRef(content.sessionRef, content.resumeSessionId, content.provider)
  return {
    paneKey: paneKeyFor(tabId, paneId),
    kind: 'fresh-agent',
    mode: content.provider,
    createRequestId: content.createRequestId,
    ...(sessionRef ? { sessionRef } : {}),
    ...(content.status ? { status: content.status } : {}),
  }
}

function buildRequestFromPanes(panes: ReconcilePane[]): PaneReconcileRequest | null {
  if (panes.length === 0) return null
  let capped = panes
  if (panes.length > MAX_RECONCILE_PANES) {
    console.error(
      `pane-reconcile: ${panes.length} panes exceed the protocol cap of ${MAX_RECONCILE_PANES}; sending the first ${MAX_RECONCILE_PANES} only`,
    )
    capped = panes.slice(0, MAX_RECONCILE_PANES)
  }
  return {
    type: 'pane.reconcile.request',
    reconcileId: nanoid(),
    panes: capped,
  }
}

/**
 * Build a reconcile request covering every terminal pane in the store —
 * plus every fresh-agent pane when `includeFreshAgent` is set (capability
 * gated by the caller) — or null if there are none.
 */
export function buildReconcileRequest(
  state: RootState,
  opts?: { includeFreshAgent?: boolean },
): PaneReconcileRequest | null {
  const panes: ReconcilePane[] = []
  forEachTerminalPane(state.panes.layouts, (tabId, paneId, content) => {
    const pane = toReconcilePane(tabId, paneId, content)
    if (pane) panes.push(pane)
  })
  if (opts?.includeFreshAgent) {
    forEachFreshAgentPane(state.panes.layouts, (tabId, paneId, content) => {
      const pane = toFreshAgentReconcilePane(tabId, paneId, content)
      if (pane) panes.push(pane)
    })
  }
  return buildRequestFromPanes(panes)
}

/**
 * Build a reconcile request for specific panes only (e.g. a single exhausted
 * pane), or null if none resolve. Kind-agnostic: each target folds by its
 * own content kind (terminal or fresh-agent).
 */
export function buildReconcileRequestForPanes(
  state: RootState,
  targets: { tabId: string; paneId: string }[],
): PaneReconcileRequest | null {
  const wanted = new Set(targets.map((t) => paneKeyFor(t.tabId, t.paneId)))
  const panes: ReconcilePane[] = []
  forEachReconcilablePane(state.panes.layouts, (tabId, paneId, content) => {
    if (!wanted.has(paneKeyFor(tabId, paneId))) return
    const pane = content.kind === 'terminal'
      ? toReconcilePane(tabId, paneId, content)
      : toFreshAgentReconcilePane(tabId, paneId, content)
    if (pane) panes.push(pane)
  })
  return buildRequestFromPanes(panes)
}

export interface FoldOutcome {
  attached: number
  respawned: number
  fresh: number
  dead: number
  warming: number
  invalid: number
  cardinalityViolation: boolean
}

/**
 * Parse a pane ref back out of OUR OWN paneKey. Safe because the key was
 * minted by paneKeyFor from nanoid tab/pane ids (which never contain ':'),
 * and foldVerdicts only reaches here after verifying the server echoed the
 * request's keys verbatim — we never string-split server input.
 */
function paneRefFromOwnKey(paneKey: string): { tabId: string; paneId: string } {
  const sep = paneKey.indexOf(':')
  return { tabId: paneKey.slice(0, sep), paneId: paneKey.slice(sep + 1) }
}

function deadSessionTitle(pane: ReconcilePane): string {
  if (pane.kind === 'fresh-agent') {
    // The true sessionType is not derivable from the provider (kilroy and
    // freshclaude both run provider 'claude'), so use a stable human label
    // built from the provider instead of derivePaneTitle.
    return `${pane.mode.charAt(0).toUpperCase()}${pane.mode.slice(1)} session`
  }
  return derivePaneTitle({
    kind: 'terminal',
    mode: pane.mode as TerminalPaneContent['mode'],
    createRequestId: pane.createRequestId,
    status: 'running',
  })
}

/**
 * Fold one fresh-agent verdict. Routing mirrors the terminal arms:
 * attach → applyFreshAgentReconcileAttach (skipped without a sessionRef —
 * malformed, the reducer would no-op); respawn/fresh →
 * resetFreshAgentPaneForReconcileCreate; dead_session → batched entry +
 * loud per-pane restoreError; invalid → restoreError + notice; error →
 * warming batch or restoreError. Returns true iff the verdict was folded.
 */
function foldFreshAgentVerdict(
  dispatch: AppDispatch,
  pane: ReconcilePane,
  verdict: PaneReconcileResultMessage['verdicts'][number],
  result: PaneReconcileResultMessage,
  deadEntries: DeadSessionEntry[],
  warmingRefs: Array<{ tabId: string; paneId: string }>,
  outcome: FoldOutcome,
): boolean {
  const { tabId, paneId } = paneRefFromOwnKey(pane.paneKey)

  switch (verdict.verdict) {
    case 'attach': {
      // Contract: a fresh-agent attach carries the durable sessionRef
      // (there is no terminalId). Missing one is malformed — skip entirely.
      if (!verdict.sessionRef) return false
      dispatch(applyFreshAgentReconcileAttach({
        tabId,
        paneId,
        sessionRef: verdict.sessionRef,
        serverInstanceId: result.serverInstanceId,
        corrected: verdict.corrected,
        duplicate: verdict.duplicate ? true : undefined,
      }))
      // Server said Live: the verdict itself is positive existence evidence —
      // revoke a stale `lost` flag left by a transient dead-window race, or the
      // snapshot fetch stays suppressed and the .lost driver re-fires forever.
      dispatch(clearSessionLost({
        sessionId: verdict.sessionRef.sessionId,
        provider: verdict.sessionRef.provider as FreshAgentRuntimeProvider,
      }))
      outcome.attached++
      return true
    }
    case 'respawn': {
      dispatch(resetFreshAgentPaneForReconcileCreate({
        tabId,
        paneId,
        intent: 'respawn',
        sessionRef: verdict.sessionRef,
        corrected: verdict.corrected,
      }))
      outcome.respawned++
      return true
    }
    case 'fresh': {
      dispatch(resetFreshAgentPaneForReconcileCreate({
        tabId,
        paneId,
        intent: 'fresh',
        reason: verdict.reason,
      }))
      outcome.fresh++
      return true
    }
    case 'dead_session': {
      deadEntries.push({
        tabId,
        paneId,
        title: deadSessionTitle(pane),
        mode: pane.mode,
        kind: 'fresh-agent',
        sessionRef: verdict.sessionRef,
        reason: verdict.reason,
      })
      dispatch(setPaneRestoreError({
        tabId,
        paneId,
        restoreError: buildRestoreError('durable_artifact_missing'),
      }))
      outcome.dead++
      return true
    }
    case 'invalid': {
      dispatch(setPaneRestoreError({
        tabId,
        paneId,
        restoreError: buildRestoreError('missing_canonical_identity'),
      }))
      if (verdict.reason) {
        dispatch(setPaneReconcileNotice({
          tabId,
          paneId,
          notice: `Reconcile rejected this pane (${verdict.reason}).`,
        }))
      }
      outcome.invalid++
      return true
    }
    case 'error': {
      // Fresh-agent verdicts never emit 'error' today, but the fold must
      // not crash if one arrives — identical handling to the terminal arm.
      if (verdict.reason === 'index_warming') {
        warmingRefs.push({ tabId, paneId })
        outcome.warming++
      } else {
        dispatch(setPaneRestoreError({
          tabId,
          paneId,
          restoreError: buildRestoreError('provider_runtime_failed'),
        }))
      }
      return true
    }
  }
}

/**
 * Fold a pane.reconcile.result into the store, one dispatch per pane
 * verdict — EXCEPT dead_session adjudication and index_warming, which
 * are each batched into a single dispatch.
 *
 * Cardinality invariant comes FIRST: verdicts must match the request's
 * panes 1:1 in order. On violation NOTHING is dispatched — the caller
 * sees `cardinalityViolation: true` and falls back to the legacy census.
 *
 * Each verdict routes by `request.panes[i].kind` (terminal vs fresh-agent).
 * The optional `onVerdictFolded` hook fires once per successfully-folded
 * pane (all kinds) with that pane's createRequestId, so callers can retract
 * a held/queued create at the sender. Skipped verdicts (malformed attach)
 * and cardinality violations never fire it.
 */
export function foldVerdicts(
  dispatch: AppDispatch,
  request: PaneReconcileRequest,
  result: PaneReconcileResultMessage,
  opts?: { onVerdictFolded?: (createRequestId: string) => void },
): FoldOutcome {
  const outcome: FoldOutcome = {
    attached: 0,
    respawned: 0,
    fresh: 0,
    dead: 0,
    warming: 0,
    invalid: 0,
    cardinalityViolation: false,
  }

  if (result.verdicts.length !== request.panes.length) {
    outcome.cardinalityViolation = true
    return outcome
  }
  for (let i = 0; i < request.panes.length; i++) {
    if (result.verdicts[i].paneKey !== request.panes[i].paneKey) {
      outcome.cardinalityViolation = true
      return outcome
    }
  }

  const deadEntries: DeadSessionEntry[] = []
  const warmingRefs: Array<{ tabId: string; paneId: string }> = []

  for (let i = 0; i < request.panes.length; i++) {
    const pane = request.panes[i]
    const verdict = result.verdicts[i]

    if (pane.kind === 'fresh-agent') {
      const folded = foldFreshAgentVerdict(dispatch, pane, verdict, result, deadEntries, warmingRefs, outcome)
      if (folded) opts?.onVerdictFolded?.(pane.createRequestId)
      continue
    }

    const { tabId, paneId } = paneRefFromOwnKey(pane.paneKey)
    let folded = true

    switch (verdict.verdict) {
      case 'attach': {
        // Contract: attach carries the live terminalId. A missing one is a
        // malformed verdict — the reducer would no-op, so skip it entirely.
        if (!verdict.terminalId) {
          folded = false
          break
        }
        dispatch(applyReconcileAttach({
          tabId,
          paneId,
          terminalId: verdict.terminalId,
          serverInstanceId: result.serverInstanceId,
          sessionRef: verdict.sessionRef,
          corrected: verdict.corrected,
          duplicate: verdict.duplicate ? true : undefined,
        }))
        outcome.attached++
        break
      }
      case 'respawn': {
        dispatch(resetPaneForReconcileCreate({
          tabId,
          paneId,
          intent: 'respawn',
          sessionRef: verdict.sessionRef,
          corrected: verdict.corrected,
        }))
        outcome.respawned++
        break
      }
      case 'fresh': {
        dispatch(resetPaneForReconcileCreate({
          tabId,
          paneId,
          intent: 'fresh',
          reason: verdict.reason,
        }))
        outcome.fresh++
        break
      }
      case 'dead_session': {
        deadEntries.push({
          tabId,
          paneId,
          title: deadSessionTitle(pane),
          mode: pane.mode,
          sessionRef: verdict.sessionRef,
          reason: verdict.reason,
        })
        // Loud, non-destructive per-pane breadcrumb: the saved session
        // artifact is gone. RestoreError reasons are a closed enum, so the
        // verdict's machine reason travels on the DeadSessionEntry instead.
        dispatch(setPaneRestoreError({
          tabId,
          paneId,
          restoreError: buildRestoreError('durable_artifact_missing'),
        }))
        outcome.dead++
        break
      }
      case 'invalid': {
        dispatch(setPaneRestoreError({
          tabId,
          paneId,
          restoreError: buildRestoreError('missing_canonical_identity'),
        }))
        if (verdict.reason) {
          // RestoreError's reason enum can't carry the server's machine
          // code — surface it via the one-shot reconcile notice.
          dispatch(setPaneReconcileNotice({
            tabId,
            paneId,
            notice: `Reconcile rejected this pane (${verdict.reason}).`,
          }))
        }
        outcome.invalid++
        break
      }
      case 'error': {
        if (verdict.reason === 'index_warming') {
          warmingRefs.push({ tabId, paneId })
          outcome.warming++
        } else {
          // provider_unavailable and any other terminal error reason:
          // per-pane restoreError via the provider-failure rendering path.
          dispatch(setPaneRestoreError({
            tabId,
            paneId,
            restoreError: buildRestoreError('provider_runtime_failed'),
          }))
        }
        break
      }
    }

    if (folded) opts?.onVerdictFolded?.(pane.createRequestId)
  }

  // Council rule 1: ONE batched adjudication list — never N dispatches.
  if (deadEntries.length > 0) {
    dispatch(setDeadSessionAdjudication(deadEntries))
  }
  // Council rule 5: warming verdicts aggregate into ONE dispatch.
  if (warmingRefs.length > 0) {
    dispatch(setReconcileWarming({ count: warmingRefs.length, paneRefs: warmingRefs }))
  }

  return outcome
}
