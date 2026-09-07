import { nanoid } from 'nanoid'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import {
  normalizeFreshAgentSessionType,
  resolveFreshAgentRuntimeProvider,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import type { RecoveryInventory, RecoveryPane, LedgerOnlyEntry } from './types'

function terminalContent(p: {
  mode: string | null
  shell: string | null
  cwd: string | null
  sessionRef: { provider: string; sessionId: string } | null
}): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: nanoid(), // re-minted by restoreLayout normalization; required by the type
    status: 'creating',
    ...(p.mode ? { mode: p.mode } : {}),
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.cwd ? { initialCwd: p.cwd } : {}),
    // Focused-episode-6 round 5 (Finding F1): the resume ref is NEVER
    // stripped for liveness. A live terminal pane restores by REATTACH —
    // when its snapshot payload carries the still-running terminal handle
    // (`liveTerminal.terminalId`), the plan arms a one-shot
    // createRequestId→terminalId target (see `buildRecoveryPlan`) that
    // TerminalView consults BEFORE any create; when it does not (defensive
    // shape: a live verdict for an identified pane whose snapshot lost the
    // handle), the resume create meets the server's D7 live-owner refusal
    // (RESTORE_UNAVAILABLE + liveTerminalId) and folds back onto the SAME
    // terminal (`applyReattachToLiveTerminal`). Either way: reattach, never
    // a second process.
    ...(p.sessionRef ? { sessionRef: p.sessionRef } : {}),
  } as PaneContent
}

/**
 * Delta-r6 (F1+F2), amended by focused-episode-6 round 5 (Finding F1) — THE
 * restorability predicate, shared by the plan, the advertised count, the
 * offer panel's listing, and the panel's live note so all four always agree
 * (the same regime delta-r4 Finding 2 established for `placeLedgerEntries`).
 * The server's correlation work stamps each snapshot pane with a verdict at
 * the TOP level (the snapshot payload is left untouched); ONE verdict makes
 * a pane NOT restorable:
 *
 * - `ledgerState === 'closed'`: the pane's session was CLOSED between the
 *   last registry push and the browser-state loss (the effective sessionRef
 *   is null). Restoring it would recreate a session the user deliberately
 *   closed (the pre-fix shape — "closed panes come back fresh" — offered
 *   exactly the never-open sessions this campaign exists to exclude).
 *
 * A `live` pane, by contrast, IS restorable (round-5 course correction over
 * the delta-r6-r3 exclusion): it is a genuinely-open session still running
 * server-side after the browser loss, so the restore puts it back IN ITS TAB
 * — terminal panes by reattach (the plan arms the snapshot's still-running
 * terminal handle; `liveTerminalReattach`), fresh-agent panes by ADOPTION
 * (the content keeps the top-level effective ref, and the manager's
 * live-session adopt answers the create without spawning). Live panes are
 * therefore counted, listed, and planned like any other restorable pane; the
 * offer's live note explains the reattach.
 *
 * Plain un-correlated panes (no snapshot claim, no correlation verdict —
 * `ledgerState === 'unknown'`, null ref) are untouched: they still rebuild
 * fresh with their cwd/mode and no resume ref.
 */
export function isRestorablePane(p: RecoveryPane): boolean {
  return p.ledgerState !== 'closed'
}

function paneContent(p: RecoveryPane): PaneContent {
  if (p.kind === 'terminal') return terminalContent(p)
  if (p.kind === 'editor') {
    // EditorPaneContent.content is required (paneTypes.ts:116-130) but snapshots never
    // capture buffer text - recreate with an empty buffer (data fact, D6)
    return { content: '', ...p.payload, kind: 'editor' } as PaneContent
  }
  if (p.kind === 'fresh-agent') {
    // normalize's existingRestoreError branch would drop sessionRef; strip restoreError
    // and let normalize re-validate the ref itself (A10)
    //
    // Delta-r6 F2 (server authority beats the stale payload copy): the server
    // deliberately leaves the snapshot payload untouched and puts the
    // D4-corrected verdict at the TOP level — the payload's own sessionRef is
    // a pre-verdict copy. The top-level sessionRef WINS: a superseded pane
    // resumes the corrected successor, never the payload's old ref (and a
    // null top-level ref never resurrects a payload ref — the only verdict
    // that produces one is `closed`, excluded by `isRestorablePane` before
    // this point, and this spread no longer carries the payload's copy
    // regardless, as defense in depth). A LIVE fresh-agent pane rides the
    // same branch: the top-level ref is the live session's identity, so the
    // restored pane's create adopts it server-side (never a respawn).
    const { restoreError: _restoreError, sessionRef: _snapshotSessionRef, ...payload } = p.payload
    return {
      ...payload,
      kind: 'fresh-agent',
      ...(p.sessionRef ? { sessionRef: p.sessionRef } : {}),
    } as PaneContent
  }
  return { ...p.payload, kind: p.kind } as PaneContent
}

function leaf(content: PaneContent): PaneNode {
  return { type: 'leaf', id: nanoid(), content }
}

// D6: no split geometry in snapshots - right-leaning binary chain of even splits
function chain(leaves: PaneNode[]): PaneNode {
  if (leaves.length === 1) return leaves[0]
  const [head, ...rest] = leaves
  return { type: 'split', id: nanoid(), direction: 'horizontal', children: [head, chain(rest)], sizes: [50, 50] }
}

export interface RecoveryTabPlan {
  tabId: string
  title: string
  /** The inventory tab's tabKey this plan restores (device plans only; internal to the plan/panel pair). */
  sourceTabKey?: string
  layout: PaneNode
  paneTitles: Record<string, string>
  /**
   * Focused-episode-6 round 5 (Finding F1): the plan's LIVE terminal panes
   * reattach to their still-running server terminals — one-shot
   * paneId→terminalId targets, armed into `terminal-restore` on accept
   * (RecoveryOfferPanel) and consumed by TerminalView's lifecycle BEFORE it
   * would dispatch a terminal.create. Keyed by the leaf's PANE ID (not
   * createRequestId): restoreLayout normalization re-mints terminal
   * createRequestIds but preserves pane node ids, so this key identity holds
   * from plan to mount. A pane with no entry creates exactly as before
   * (dead panes resume/fresh per the existing rules).
   */
  liveTerminalReattach?: Array<{ paneId: string; terminalId: string }>
}

/**
 * Focused-episode-6 round 5 (Finding F1): the reattach target of a LIVE
 * terminal pane, from its snapshot's still-running terminal handle
 * (`payload.liveTerminal.terminalId`). The inventory's `live` verdict is the
 * server's own assertion that this id is Running NOW (durable-ref liveness
 * primary; terminal-id membership the fallback for otherwise-unidentified
 * shells), and the client restores onto the SAME server it fetched the
 * inventory from — so a present handle means "reattach, never respawn". A
 * live pane whose snapshot lacks the handle gets NO target: its kept
 * sessionRef routes it to the resume/D7-refusal→reattach fallback instead.
 */
function liveReattachTarget(
  p: RecoveryPane,
  content: PaneContent,
  paneId: string,
): { paneId: string; terminalId: string } | undefined {
  if (p.kind !== 'terminal' || !p.live || content.kind !== 'terminal') return undefined
  const handle = p.payload.liveTerminal as { terminalId?: unknown } | undefined
  const terminalId =
    typeof handle?.terminalId === 'string' && handle.terminalId ? handle.terminalId : undefined
  return terminalId ? { paneId, terminalId } : undefined
}

// Delta-r4 Finding 2: the advertised count lives below `placeLedgerEntries`
// and consumes it — see its body's comment.

// Defense-in-depth for a fresh-agent row whose mode is not a valid session
// type (corrupt/pre-schema data): the provider's default flavor. Real rows
// always carry the session type in `mode` (every fresh-agent binding write
// stamps SESSION_TYPE), so this fallback never fires for genuine data — and
// the resumed conversation identity is unaffected either way (the resume is
// provider + sessionRef driven).
const FALLBACK_SESSION_TYPE_BY_PROVIDER: Partial<Record<string, FreshAgentSessionType>> = {
  claude: 'freshclaude',
  codex: 'freshcodex',
  opencode: 'freshopencode',
}

// Defense-in-depth for a ledger-forwarded sandbox (focused-ep1 Finding B):
// pane validation (paneTreeValidation's fresh-agent arm) accepts only this
// union, so an out-of-union value (corrupt/pre-schema row) is dropped rather
// than failing the whole restored leaf.
function ledgerSandbox(
  sandbox: string | undefined,
): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {
  return sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access'
    ? sandbox
    : undefined
}

/**
 * Package a kept FRESH-AGENT ledger row as a fresh-agent pane content for a
 * SESSION RESUME — the minimal equivalent of the snapshot-restore path's
 * fresh-agent branch (paneContent): the FreshAgentView create effect drives
 * `freshAgent.create{sessionRef}` straight from this content, exactly as for
 * a snapshot-restored fresh-agent pane. A fresh-agent leaf never enters
 * `armRecoveredTerminalRestores` (that walk is kind-gated to terminal leaves),
 * matching the snapshot path.
 */
function freshAgentEntryContent(e: LedgerOnlyEntry): PaneContent {
  const modeSessionType = normalizeFreshAgentSessionType(e.mode)
  // Focused-ep1-r5 Finding 3 (provider consistency): the row's `provider` is
  // authoritative for the RESUME identity, and the built content must stay
  // consistent with the fresh-agent mode mapping (pane validation's
  // invariant: provider === resolveFreshAgentRuntimeProvider(sessionType)).
  // A row whose stamped mode maps to a DIFFERENT provider lane (malformed/
  // pre-schema data) is NOT reconstructed as a resumable pane — with the
  // mismatch kept, the create effect would dispatch the sessionRef to the
  // wrong provider, which filters it and silently mints a fresh, non-resume
  // session. Like a closed/live row, the pane rebuilds carrying the row's
  // recorded flavor + settings WITHOUT the resume ref (the plan builder's
  // existing convention for unresumable content — no new error surface).
  const modeProvider = modeSessionType ? resolveFreshAgentRuntimeProvider(modeSessionType) : undefined
  const providerReconciles = modeProvider === undefined || modeProvider === e.provider
  const sessionType = modeSessionType ?? FALLBACK_SESSION_TYPE_BY_PROVIDER[e.provider]
  const sandbox = ledgerSandbox(e.sandbox)
  return {
    kind: 'fresh-agent',
    sessionType,
    // provider must satisfy pane validation's invariant (provider ===
    // resolveFreshAgentRuntimeProvider(sessionType)); for genuine rows both
    // derivations agree, the resolution just makes the invariant explicit.
    provider: resolveFreshAgentRuntimeProvider(sessionType) ?? (e.provider as FreshAgentRuntimeProvider),
    createRequestId: nanoid(), // re-minted by restoreLayout normalization; required by the type
    status: 'creating',
    ...(e.cwd ? { initialCwd: e.cwd } : {}),
    // Focused-ep1 Finding B: the row's recorded settings ride the resume so a
    // restored pane keeps its ORIGINAL configuration (the create effect sends
    // content.model/effort/sandbox/permissionMode alongside the sessionRef,
    // and explicit create params win server-side) instead of silently adopting
    // CURRENT defaults. Absent fields keep today's defaulting, unchanged.
    ...(e.model ? { model: e.model } : {}),
    ...(e.effort ? { effort: e.effort } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(e.permissionMode ? { permissionMode: e.permissionMode } : {}),
    ...(providerReconciles ? { sessionRef: { provider: e.provider, sessionId: e.sessionId } } : {}),
  } as PaneContent
}

function ledgerEntryContent(e: LedgerOnlyEntry): PaneContent {
  if (e.paneKind === 'fresh-agent') return freshAgentEntryContent(e)
  return terminalContent({ mode: e.mode, shell: null, cwd: e.cwd, sessionRef: { provider: e.provider, sessionId: e.sessionId } })
}

export interface LedgerPlacement {
  /** Rows joining a restored tab, keyed by the inventory tab's tabKey. */
  joinedByTabKey: Map<string, LedgerOnlyEntry[]>
  /**
   * Rows with no join target (unmatched or missing tabKey) — NOT placed
   * anywhere. The server's placement clause (delta-r2 Finding 3) excludes
   * such rows from the offer, so this bucket is defense-in-depth only: the
   * client must not resurrect a trailing recovered-sessions tab for
   * stragglers (that restored them into an unrelated tab).
   */
  unplaced: LedgerOnlyEntry[]
}

/**
 * D8 placement partition — THE placement predicate, shared by the offer
 * panel's listing, the plan builder, AND the prompt's advertised count
 * (`countRecoverablePanes` below) so count, list, and plans always agree
 * (delta-r4 Finding 2): a kept ledger row whose stamped tabKey names a tab
 * that yields a plan joins that tab; every other row (unmatched tabKey — the
 * tab vanished from the retained evidence; missing tabKey — pre-upgrade/
 * headless lineage or a straggler the server's placement clause would have
 * excluded) is NOT placed (delta-r2 Finding 3) and counts for NOTHING — an
 * older server (a supported client-only deploy, additive protocol) may still
 * offer such rows, and counting them would advertise N panes while the accept
 * path restores fewer. Joinability is computed from the tabs that PRODUCE
 * plans (panes.length > 0), not raw inventory tabs: an empty-pane tab gets no
 * plan, so rows stamped for it have no join target.
 */
export function placeLedgerEntries(inv: RecoveryInventory): LedgerPlacement {
  const joinableTabKeys = new Set(
    (inv.device?.tabs ?? []).filter((t) => t.panes.length > 0).map((t) => t.tabKey),
  )
  const joinedByTabKey = new Map<string, LedgerOnlyEntry[]>()
  const unplaced: LedgerOnlyEntry[] = []
  for (const entry of inv.ledgerOnly) {
    if (entry.tabKey !== undefined && joinableTabKeys.has(entry.tabKey)) {
      const list = joinedByTabKey.get(entry.tabKey) ?? []
      if (list.length === 0) joinedByTabKey.set(entry.tabKey, list)
      list.push(entry)
    } else {
      unplaced.push(entry)
    }
  }
  return { joinedByTabKey, unplaced }
}

/**
 * The panel heading's advertised pane count: snapshot panes plus the
 * PLACEABLE ledger rows only — computed through the same `placeLedgerEntries`
 * partition the listing and the plan consume (delta-r4 Finding 2), so an
 * unplaceable row (no join target) can never make the prompt advertise more
 * than the accept path restores. Focused-ep4-r2 Finding 4: the panel's
 * OFFERABILITY gate also consumes this — `0` means no device tab pane and no
 * placeable ledger row exist, i.e. not recoverable (no render, pending flag
 * cleared), so a vacuous "Restore 0 panes" prompt can never appear.
 */
export function countRecoverablePanes(inv: RecoveryInventory): number {
  const device =
    inv.device?.tabs.reduce((n, t) => n + t.panes.filter(isRestorablePane).length, 0) ?? 0
  let joined = 0
  for (const entries of placeLedgerEntries(inv).joinedByTabKey.values()) joined += entries.length
  return device + joined
}

export function buildRecoveryPlan(inv: RecoveryInventory): RecoveryTabPlan[] {
  // The layout join MUST happen at plan time: restoreLayout no-ops when the
  // tab's layout already exists (panesSlice.ts restoreLayout), so the accept
  // loop (one dispatch per plan) can never graft a row on afterwards. Joined
  // rows extend the existing chain as the rightmost leaf (D6 geometry).
  const placement = placeLedgerEntries(inv)
  // Every offered row now joins a restored tab — the server excludes
  // unplaceable rows (delta-r2 Finding 3), and `placement.unplaced` drops any
  // straggler rather than reviving the trailing-tab fallback.
  return (inv.device?.tabs ?? [])
    .filter((t) => t.panes.length > 0)
    // Delta-r6 F1/F2: closed-verdict panes are dropped HERE, at leaf-build
    // time — so a tab whose every snapshot pane is excluded (and that no
    // ledger row joins) produces NO plan rather than an empty pane chain, and
    // count/listing/plan exclude the same set. Live panes are NOT dropped
    // (round-5 Finding F1): they land in the original tab like every other
    // restorable pane, and each live TERMINAL leaf records its reattach
    // target for the accept-time arm.
    .map((t) => {
      const leaves: PaneNode[] = []
      const liveTerminalReattach: Array<{ paneId: string; terminalId: string }> = []
      for (const p of t.panes.filter(isRestorablePane)) {
        const content = paneContent(p)
        const node = leaf(content)
        const target = liveReattachTarget(p, content, node.id)
        if (target) liveTerminalReattach.push(target)
        leaves.push(node)
      }
      for (const e of placement.joinedByTabKey.get(t.tabKey) ?? []) {
        const node = leaf(ledgerEntryContent(e))
        // Delta-round-7 (Finding F1): a LIVE terminal ledger row restores by
        // REATTACH to its still-running terminal — the same one-shot
        // paneId→terminalId arm the snapshot-pane live path uses
        // (`liveReattachTarget`), consulted by TerminalView BEFORE any create
        // (never a respawn). A live row with no forwarded handle (defensive)
        // keeps its sessionRef and falls to the resume/D7-refusal→reattach
        // path; fresh-agent rows never join this arm (their ADOPT rides the
        // sessionRef create, exactly like a live fresh-agent snapshot pane).
        const reattachTerminalId =
          e.live === true && e.paneKind !== 'fresh-agent' && typeof e.liveTerminalId === 'string' && e.liveTerminalId
            ? e.liveTerminalId
            : undefined
        if (reattachTerminalId) {
          liveTerminalReattach.push({ paneId: node.id, terminalId: reattachTerminalId })
        }
        leaves.push(node)
      }
      return { tab: t, leaves, liveTerminalReattach }
    })
    .filter(({ leaves }) => leaves.length > 0)
    .map(({ tab: t, leaves, liveTerminalReattach }) => ({
      tabId: nanoid(),
      title: t.tabName || 'Recovered',
      sourceTabKey: t.tabKey,
      layout: chain(leaves),
      paneTitles: {},
      ...(liveTerminalReattach.length ? { liveTerminalReattach } : {}),
    }))
}
