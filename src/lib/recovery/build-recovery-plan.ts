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
  live: boolean
}): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: nanoid(), // re-minted by restoreLayout normalization; required by the type
    status: 'creating',
    ...(p.mode ? { mode: p.mode } : {}),
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.cwd ? { initialCwd: p.cwd } : {}),
    // D7: live sessions are left untouched - recreate the pane WITHOUT resume
    ...(p.sessionRef && !p.live ? { sessionRef: p.sessionRef } : {}),
  } as PaneContent
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
    const { restoreError: _restoreError, ...payload } = p.payload
    return { ...payload, kind: 'fresh-agent' } as PaneContent
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
}

export function countRecoverablePanes(inv: RecoveryInventory): number {
  const device = inv.device?.tabs.reduce((n, t) => n + t.panes.length, 0) ?? 0
  return device + inv.ledgerOnly.length
}

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
  const sessionType =
    normalizeFreshAgentSessionType(e.mode) ?? FALLBACK_SESSION_TYPE_BY_PROVIDER[e.provider]
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
    sessionRef: { provider: e.provider, sessionId: e.sessionId },
  } as PaneContent
}

function ledgerEntryContent(e: LedgerOnlyEntry): PaneContent {
  if (e.paneKind === 'fresh-agent') return freshAgentEntryContent(e)
  return terminalContent({ mode: e.mode, shell: null, cwd: e.cwd, sessionRef: { provider: e.provider, sessionId: e.sessionId }, live: false })
}

export interface LedgerPlacement {
  /** Rows joining a restored tab, keyed by the inventory tab's tabKey. */
  joinedByTabKey: Map<string, LedgerOnlyEntry[]>
  /** Rows falling back to the trailing tab (unmatched or missing tabKey). */
  trailing: LedgerOnlyEntry[]
}

/**
 * D8 placement partition, shared by the plan builder and the offer panel so
 * the listing always matches the physical destination: a kept ledger row
 * whose stamped tabKey names a tab that yields a plan joins that tab; every
 * other row (unmatched tabKey — the tab vanished from the retained evidence;
 * missing tabKey — pre-upgrade or headless lineage) falls back to the
 * trailing tab. Joinability is computed from the tabs that PRODUCE plans
 * (panes.length > 0), not raw inventory tabs: an empty-pane tab gets no plan,
 * so rows stamped for it must fall through.
 */
export function placeLedgerEntries(inv: RecoveryInventory): LedgerPlacement {
  const joinableTabKeys = new Set(
    (inv.device?.tabs ?? []).filter((t) => t.panes.length > 0).map((t) => t.tabKey),
  )
  const joinedByTabKey = new Map<string, LedgerOnlyEntry[]>()
  const trailing: LedgerOnlyEntry[] = []
  for (const entry of inv.ledgerOnly) {
    if (entry.tabKey !== undefined && joinableTabKeys.has(entry.tabKey)) {
      const list = joinedByTabKey.get(entry.tabKey) ?? []
      if (list.length === 0) joinedByTabKey.set(entry.tabKey, list)
      list.push(entry)
    } else {
      trailing.push(entry)
    }
  }
  return { joinedByTabKey, trailing }
}

export function buildRecoveryPlan(inv: RecoveryInventory): RecoveryTabPlan[] {
  // The layout join MUST happen at plan time: restoreLayout no-ops when the
  // tab's layout already exists (panesSlice.ts restoreLayout), so the accept
  // loop (one dispatch per plan) can never graft a row on afterwards. Joined
  // rows extend the existing chain as the rightmost leaf (D6 geometry).
  const placement = placeLedgerEntries(inv)
  const plans: RecoveryTabPlan[] = (inv.device?.tabs ?? [])
    .filter((t) => t.panes.length > 0)
    .map((t) => ({
      tabId: nanoid(),
      title: t.tabName || 'Recovered',
      sourceTabKey: t.tabKey,
      layout: chain([
        ...t.panes.map((p) => leaf(paneContent(p))),
        ...(placement.joinedByTabKey.get(t.tabKey) ?? []).map((e) => leaf(ledgerEntryContent(e))),
      ]),
      paneTitles: {},
    }))
  if (placement.trailing.length > 0) {
    plans.push({
      tabId: nanoid(),
      title: 'Recovered sessions',
      layout: chain(placement.trailing.map((e) => leaf(ledgerEntryContent(e)))),
      paneTitles: {},
    })
  }
  return plans
}
