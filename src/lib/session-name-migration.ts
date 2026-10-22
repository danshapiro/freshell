/**
 * Unified agent names (Task 7) — the client side of the one-time
 * legacy-name consolidation.
 *
 * WHEN evidence is captured, WHAT counts as evidence and when the captured
 * envelopes are deleted is owned by `@/lib/legacy-name-capture-policy`
 * (name reliability, Task 2): a device captures at most once, only from the
 * genuine pre-migration keys, and never from its own live per-window
 * layouts. This module owns the rest of the client contract:
 * - `prepareLegacyNameImports(evidence)` — deterministic candidate
 *   extraction (at most 100 candidates per import) including the
 *   legacy-pending namingHandle derivation for unbound scoped panes. A
 *   default or derived label ("Tab 7", the folder name, a provider label)
 *   is not a name and never becomes a candidate, and a session-owned tab's
 *   stored title is a display copy of the saved name, never evidence.
 * - `importLegacyNames(imports)` — the HTTP submit against
 *   `POST /api/session-names/import`; an already-acknowledged import replays
 *   as a no-op without a request, and a failed submit keeps the import
 *   pending for retry.
 * - `submitPendingLegacyNameImports()` — the connection-ready submit of the
 *   genuine pending envelopes. A chunked envelope (`<base>--<N>` derived ids)
 *   retires only when ALL its chunks acknowledged; a retired envelope is
 *   deleted, and the device is marked done once none is left.
 *
 * Plus the ONE client sanitizer: `stripScopedPaneTitleMetadata` /
 * `stripSessionOwnedTabFreezeFlags` — the single gate every scoped
 * hydrated/flush metadata passes through. It strips ACTIVE local aliases
 * and user-set flags for the six scoped agent modes (a scoped pane's name
 * is owned by the canonical server record) while preserving pane identity
 * (sessionRef/nameRef/namingHandle), the tab's naming-source pointer and
 * the last-known canonical title projections. Every legacy out-of-scope
 * path (shells, browsers, editors, excluded providers, nameSource-less
 * tabs) is preserved verbatim.
 *
 * This module must never import the Redux store — it runs from `main.tsx`
 * BEFORE `@/store/storage-migration` and the store imports.
 */

import { nanoid } from 'nanoid'
import { api, ApiError } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import {
  isAcknowledged,
  isCaptureDone,
  isGenuinePreMigrationSource,
  listCapturedMigrationEnvelopes,
  markAcknowledged,
  markCaptureDone,
  purgeObsoleteEnvelopes,
  runOneTimeLegacyCapture,
  type LegacyNameMigrationEnvelope,
} from '@/lib/legacy-name-capture-policy'
import { isScopedNameSourceContent } from '@/lib/tab-name-source'
import { isDefaultOrDerivedName } from '@shared/name-evidence'
import {
  legacyNameCandidateId,
  type LegacyNameCandidate,
  type LegacyCandidateScope,
  type LegacyEvidenceEnvelope,
  type LegacyImportResult,
  type LegacyNameImport,
  type LegacyNameTarget,
  type LegacyProtectionEvidence,
  type NameSource,
} from '@shared/session-names'
import { LAYOUT_STORAGE_KEY_PREFIX } from '@/store/window-layout-keys'

const log = createLogger('SessionNameMigration')

/** At most this many candidates ride one import. */
const IMPORT_CANDIDATE_LIMIT = 100

/** A derived legacy-pending naming handle for one unbound scoped pane. */
export type LegacyPendingHandleAssignment = {
  storageKey: string
  windowId: string | null
  tabId: string
  paneId: string
  createRequestId: string
  namingHandle: string
}

/** The per-window id a capture source key belongs to (null for the legacy
 * shared keys) — one segment of the legacy-pending handle tuple. */
function legacyCaptureWindowId(key: string): string | null {
  if (!key.startsWith(`${LAYOUT_STORAGE_KEY_PREFIX}.`)) return null
  const suffix = key.slice(LAYOUT_STORAGE_KEY_PREFIX.length + 1)
  const windowId = suffix.split('.')[0]
  return windowId.length > 0 ? windowId : null
}

// ---------------------------------------------------------------------------
// Candidate preparation
// ---------------------------------------------------------------------------

type RawPaneContent = {
  kind?: unknown
  mode?: unknown
  sessionType?: unknown
  provider?: unknown
  sessionRef?: unknown
  nameRef?: unknown
  namingHandle?: unknown
  createRequestId?: unknown
  initialCwd?: unknown
}

type RawPaneNode = {
  type?: unknown
  id?: unknown
  content?: RawPaneContent
  children?: unknown
}

type RawLayoutEnvelope = {
  tabs?: { tabs?: Array<Record<string, unknown>> }
  panes?: {
    layouts?: Record<string, unknown>
    paneTitles?: Record<string, Record<string, unknown>>
    paneTitleSetByUser?: Record<string, Record<string, unknown>>
  }
}

/** Depth-first leaf list of a raw layout node (defensive walk). */
function collectRawLeaves(node: unknown): Array<{ paneId: string; content: RawPaneContent }> {
  const leaves: Array<{ paneId: string; content: RawPaneContent }> = []
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    const record = candidate as RawPaneNode
    if (record.type === 'leaf') {
      if (typeof record.id === 'string' && record.content && typeof record.content === 'object') {
        leaves.push({ paneId: record.id, content: record.content })
      }
      return
    }
    if (record.type === 'split' && Array.isArray(record.children)) {
      for (const child of record.children) visit(child)
    }
  }
  visit(node)
  return leaves
}

/** A raw pane content scoped through the shared predicate. */
function isRawScopedContent(content: RawPaneContent): boolean {
  return isScopedNameSourceContent(content as never)
}

/**
 * Is `label` real name evidence for this pane, rather than a default or
 * derived label ("Tab 7", the pane's folder name, "Claude CLI", an OpenCode
 * placeholder, tool wrapper text)? Classified by the shared rules with the
 * pane's own folder and provider.
 */
function isNameEvidence(label: string, content: RawPaneContent): boolean {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  const sessionRef = content.sessionRef as { provider?: unknown } | undefined
  return !isDefaultOrDerivedName(label, {
    cwd: text(content.initialCwd),
    provider: text(sessionRef?.provider) ?? text(content.provider),
    mode: text(content.mode),
  })
}

/** Resolve one raw scoped pane's naming identity. */
function resolvePaneIdentity(
  content: RawPaneContent,
  assignment: LegacyPendingHandleAssignment | undefined,
): LegacyNameTarget | undefined {
  // sessionRef: the durable structured provider/session identity.
  const sessionRef = content.sessionRef as { provider?: unknown; sessionId?: unknown } | undefined
  if (
    sessionRef
    && typeof sessionRef === 'object'
    && typeof sessionRef.provider === 'string' && sessionRef.provider.length > 0
    && typeof sessionRef.sessionId === 'string' && sessionRef.sessionId.length > 0
    && (sessionRef.provider === 'claude' || sessionRef.provider === 'codex' || sessionRef.provider === 'opencode')
  ) {
    return {
      kind: 'session',
      provider: sessionRef.provider,
      sessionId: sessionRef.sessionId,
    }
  }
  // nameRef: the persisted canonical ref.
  const nameRef = content.nameRef as { kind?: unknown; id?: unknown; provider?: unknown; sessionId?: unknown } | undefined
  if (nameRef && typeof nameRef === 'object') {
    if (nameRef.kind === 'pending' && typeof nameRef.id === 'string' && nameRef.id.length > 0) {
      return { kind: 'pending', id: nameRef.id }
    }
    if (
      nameRef.kind === 'session'
      && (nameRef.provider === 'claude' || nameRef.provider === 'codex' || nameRef.provider === 'opencode')
      && typeof nameRef.sessionId === 'string' && nameRef.sessionId.length > 0
    ) {
      return { kind: 'session', provider: nameRef.provider, sessionId: nameRef.sessionId }
    }
  }
  // namingHandle (including a freshly derived legacy-pending handle).
  const handle = assignment?.namingHandle
    ?? (typeof content.namingHandle === 'string' && content.namingHandle.length > 0
      ? content.namingHandle
      : undefined)
  if (handle) {
    return { kind: 'pending', id: handle }
  }
  return undefined
}

/** Derive the legacy-pending namingHandle for one unbound scoped pane. */
export function legacyPendingNamingHandle(input: {
  storageKey: string
  windowId: string | null
  paneId: string
  createRequestId: string
}): string {
  return JSON.stringify([
    'legacy-pending',
    input.storageKey,
    input.windowId,
    input.paneId,
    input.createRequestId,
  ])
}

type ExtractResult = {
  candidates: LegacyNameCandidate[]
  assignments: LegacyPendingHandleAssignment[]
}

/** Extract one captured envelope's candidates (deterministic). */
function extractEnvelopeCandidates(
  envelope: LegacyEvidenceEnvelope,
  deviceId: string | undefined,
): ExtractResult {
  const candidates: LegacyNameCandidate[] = []
  const assignments: LegacyPendingHandleAssignment[] = []
  let parsed: RawLayoutEnvelope
  try {
    parsed = JSON.parse(envelope.raw) as RawLayoutEnvelope
  } catch {
    // A corrupted optional envelope: retained by its immutable envelope
    // (the recovery copy), never a candidate.
    return { candidates, assignments }
  }
  const layouts = parsed.panes?.layouts ?? {}
  const paneTitles = parsed.panes?.paneTitles ?? {}
  const paneTitleSetByUser = parsed.panes?.paneTitleSetByUser ?? {}
  const tabs = parsed.tabs?.tabs ?? []
  const windowId = legacyCaptureWindowId(envelope.storageKey)

  const identityFor = (
    tabId: string,
    pane: { paneId: string; content: RawPaneContent },
  ): { target: LegacyNameTarget; assignment?: LegacyPendingHandleAssignment } | undefined => {
    if (!isRawScopedContent(pane.content)) return undefined
    let assignment: LegacyPendingHandleAssignment | undefined
    if (
      typeof pane.content.createRequestId === 'string'
      && pane.content.createRequestId.length > 0
      && pane.content.sessionRef === undefined
      && pane.content.nameRef === undefined
      && !(typeof pane.content.namingHandle === 'string' && pane.content.namingHandle.length > 0)
    ) {
      // A legacy scoped pane with no durable identity: derive its migration
      // namingHandle BEFORE creating its candidate, so the same pane keeps
      // the same handle on every retry.
      assignment = {
        storageKey: envelope.storageKey,
        windowId,
        tabId,
        paneId: pane.paneId,
        createRequestId: pane.content.createRequestId,
        namingHandle: legacyPendingNamingHandle({
          storageKey: envelope.storageKey,
          windowId,
          paneId: pane.paneId,
          createRequestId: pane.content.createRequestId,
        }),
      }
      assignments.push(assignment)
    }
    const target = resolvePaneIdentity(pane.content, assignment)
    return target ? { target, assignment } : undefined
  }

  const identityRefOf = (target: LegacyNameTarget): { provider?: string; sessionId?: string } => {
    if (target.kind === 'session') {
      return { provider: target.provider, sessionId: target.sessionId }
    }
    return {}
  }

  for (const tab of tabs) {
    const tabId = typeof tab.id === 'string' ? tab.id : ''
    if (!tabId) continue
    const layout = layouts[tabId]
    const leaves = collectRawLeaves(layout)
    const scopedLeaves = leaves
      .map((pane) => ({ pane, identity: identityFor(tabId, pane) }))
      .filter((entry): entry is { pane: { paneId: string; content: RawPaneContent }; identity: { target: LegacyNameTarget; assignment?: LegacyPendingHandleAssignment } } => entry.identity !== undefined)
    if (scopedLeaves.length === 0) continue

    // A session-owned tab (`nameSource: {kind:'session'}`) stores only a
    // display copy of its pane's saved name, never evidence: its title is
    // skipped. Any other tab label maps only to the deterministic original
    // candidate (the FIRST pane, when scoped); a first-leaf non-agent tab
    // keeps its legacy label — recovery-only.
    const nameSource = tab.nameSource as { kind?: unknown } | undefined
    const source = nameSource?.kind !== 'session'
      && scopedLeaves[0] && leaves[0] && scopedLeaves[0].pane.paneId === leaves[0].paneId
      ? scopedLeaves[0]
      : undefined
    const tabTitle = typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : undefined
    if (tabTitle && source && isNameEvidence(tabTitle, source.pane.content)) {
      const flagged = tab.titleSetByUser === true
      const scope: LegacyCandidateScope = 'source_tab'
      const protection: LegacyProtectionEvidence = flagged ? 'legacy_flag' : 'none'
      const source2: NameSource = flagged ? 'legacy_protected' : 'provider_ai'
      const ref = identityRefOf(source.identity.target)
      candidates.push({
        id: legacyNameCandidateId({
          storageKey: envelope.storageKey,
          deviceId,
          tabId,
          paneId: source.pane.paneId,
          scope,
          provider: ref.provider,
          sessionId: ref.sessionId,
          name: tabTitle,
          source: source2,
          protectionEvidence: protection,
        }),
        target: source.identity.target,
        name: tabTitle,
        source: source2,
        scope,
        evidenceKey: `${envelope.storageKey}#${tabId}#source-tab`,
        protectionEvidence: protection,
      })
    }

    // Per-pane labels.
    for (const entry of scopedLeaves) {
      const title = paneTitles[tabId]?.[entry.pane.paneId]
      const paneTitle = typeof title === 'string' && title.length > 0 ? title : undefined
      if (!paneTitle || !isNameEvidence(paneTitle, entry.pane.content)) continue
      const flagged = paneTitleSetByUser[tabId]?.[entry.pane.paneId] === true
      const scope: LegacyCandidateScope = 'pane'
      const protection: LegacyProtectionEvidence = flagged ? 'legacy_flag' : 'none'
      const source2: NameSource = flagged ? 'legacy_protected' : 'provider_ai'
      const ref = identityRefOf(entry.identity.target)
      candidates.push({
        id: legacyNameCandidateId({
          storageKey: envelope.storageKey,
          deviceId,
          tabId,
          paneId: entry.pane.paneId,
          scope,
          provider: ref.provider,
          sessionId: ref.sessionId,
          name: paneTitle,
          source: source2,
          protectionEvidence: protection,
        }),
        target: entry.identity.target,
        name: paneTitle,
        source: source2,
        scope,
        evidenceKey: `${envelope.storageKey}#${tabId}#${entry.pane.paneId}`,
        protectionEvidence: protection,
      })
    }
  }
  return { candidates, assignments }
}

/**
 * Deterministically prepare imports from captured evidence. Corrupted
 * envelopes yield no candidates (recovery-only); each import batches at most
 * [`IMPORT_CANDIDATE_LIMIT`] candidates (an oversized envelope chunks into
 * `importId--N` derived import ids, all retry-stable).
 */
export function prepareLegacyNameImports(
  evidence: LegacyEvidenceEnvelope[],
): LegacyNameImport[] {
  const imports: LegacyNameImport[] = []
  const captured = new Map(
    listCapturedMigrationEnvelopes().map((envelope) => [
      `${envelope.storageKey}\u0000${envelope.raw}`,
      envelope,
    ]),
  )
  for (const envelope of evidence) {
    const record = captured.get(`${envelope.storageKey}\u0000${envelope.raw}`)
    const baseImportId = record?.importId ?? nanoid()
    const { candidates } = extractEnvelopeCandidates(envelope, undefined)
    if (candidates.length === 0) continue
    for (let index = 0; index < candidates.length; index += IMPORT_CANDIDATE_LIMIT) {
      const chunk = candidates.slice(index, index + IMPORT_CANDIDATE_LIMIT)
      imports.push({
        version: 1,
        importId: candidates.length <= IMPORT_CANDIDATE_LIMIT
          ? baseImportId
          : `${baseImportId}--${index / IMPORT_CANDIDATE_LIMIT}`,
        evidence: [envelope],
        candidates: chunk,
      })
    }
  }
  return imports
}

/** The derived legacy-pending handle assignments across all captured
 * evidence — the pane-stamping input (the store wiring consumes this; this
 * module never touches the store). */
export function collectLegacyPendingHandleAssignments(
  evidence: LegacyEvidenceEnvelope[] = listCapturedMigrationEnvelopes()
    .filter((envelope) => isGenuinePreMigrationSource(envelope.storageKey, envelope.raw))
    .map((envelope) => ({
      storageKey: envelope.storageKey,
      raw: envelope.raw,
    })),
): LegacyPendingHandleAssignment[] {
  const assignments: LegacyPendingHandleAssignment[] = []
  const seen = new Set<string>()
  for (const envelope of evidence) {
    for (const assignment of extractEnvelopeCandidates(envelope, undefined).assignments) {
      if (seen.has(assignment.namingHandle)) continue
      seen.add(assignment.namingHandle)
      assignments.push(assignment)
    }
  }
  return assignments
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

/**
 * Submit prepared imports to `POST /api/session-names/import`. Each import
 * is acknowledged individually by the server (per candidate); on success
 * its OWN import id is marked acknowledged locally (an unchunked import
 * shares its envelope's id, so that envelope is deleted — the server keeps
 * its own immutable copy), and an already-acknowledged import replays as a
 * no-op WITHOUT a request — so a resumed sequence never re-imports the
 * chunks that landed (per-candidate acknowledgment makes that
 * safe/idempotent server-side anyway). A chunked envelope's BASE id is
 * deliberately NOT marked here: only [`submitPendingLegacyNameImports`]
 * retires an envelope, and only after ALL its chunks acknowledged. A
 * failure throws after logging; the caller keeps the envelope pending for
 * the next connection-ready edge.
 */
export async function importLegacyNames(imports: LegacyNameImport[]): Promise<void> {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  for (const one of imports) {
    if (storage && isAcknowledged(storage, one.importId)) {
      // Already acknowledged (this sequence resumed after a mid-sequence
      // failure, or a prior 400-terminal chunk): a pure local no-op.
      continue
    }
    try {
      const body = await api.post<unknown>('/api/session-names/import', one)
      const parsed = parseLegacyImportResult(body)
      if (!parsed) {
        throw new Error('the server returned an invalid legacy-import result')
      }
      if (storage) {
        markAcknowledged(storage, one.importId)
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        // A deterministic 400 (reserved id, oversized envelope, malformed
        // candidates) will never succeed on retry — acknowledge locally so
        // the pending submit stops resubmitting it.
        log.error('legacy-name import rejected by the server; marking it done locally', {
          importId: one.importId,
          error,
        })
        if (storage) markAcknowledged(storage, one.importId)
        continue
      }
      log.error('legacy-name import submit failed; keeping it pending for retry', {
        importId: one.importId,
        error,
      })
      throw error
    }
  }
}

function parseLegacyImportResult(body: unknown): LegacyImportResult | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as { acknowledged?: unknown; names?: unknown }
  if (!Array.isArray(record.acknowledged)) return undefined
  if (!Array.isArray(record.names)) return undefined
  return {
    acknowledged: record.acknowledged.filter((id): id is string => typeof id === 'string'),
    names: [],
  }
}

/**
 * Submit every genuine pending envelope once the server connection is ready
 * (the store wiring calls this on each ready edge until the device is done;
 * the server's per-candidate acknowledgments make repeated submits
 * idempotent). A done device sends nothing. Envelopes that are not genuine
 * evidence (an older client's copies of live layouts) are deleted, never
 * sent. Envelopes that yield no candidates retire without a request. An
 * envelope with chunked imports is retired ONLY after the awaited submit
 * acknowledged ALL its chunks — a mid-sequence transient failure throws
 * before the retirement, so the next ready edge re-prepares the whole
 * envelope and `importLegacyNames` resubmits exactly the unacknowledged
 * chunks (the landed ones replay as local no-ops). A retired envelope is
 * deleted; when none is left the device is marked done.
 *
 * The envelope↔chunk pairing is by EVIDENCE (each chunk import carries the
 * source envelope it was prepared from), never by parsing import-id
 * strings — a captured nanoid may itself contain `--`, so a
 * `${base}--<n>`-string heuristic could mispair and retire an envelope
 * mid-sequence.
 */
export async function submitPendingLegacyNameImports(): Promise<void> {
  if (typeof localStorage === 'undefined') return
  if (isCaptureDone(localStorage)) return
  const pending = purgeObsoleteEnvelopes(localStorage)
  if (pending.length > 0) {
    await submitEnvelopes(pending)
  }
  if (purgeObsoleteEnvelopes(localStorage).length === 0) {
    markCaptureDone(localStorage)
  }
}

/** Submit and retire the given pending envelopes (see
 * [`submitPendingLegacyNameImports`]). */
async function submitEnvelopes(pending: LegacyNameMigrationEnvelope[]): Promise<void> {
  const evidence = pending.map((envelope) => ({
    storageKey: envelope.storageKey,
    raw: envelope.raw,
  }))
  const pendingBySource = new Map(
    pending.map((envelope) => [`${envelope.storageKey}\u0000${envelope.raw}`, envelope]),
  )
  const imports = prepareLegacyNameImports(evidence)
  // Which pending envelopes the prepared imports were derived from.
  const importedEnvelopes = new Set<LegacyNameMigrationEnvelope>()
  for (const one of imports) {
    const source = one.evidence[0]
    const envelope = source
      ? pendingBySource.get(`${source.storageKey}\u0000${source.raw}`)
      : undefined
    if (envelope) importedEnvelopes.add(envelope)
  }
  for (const envelope of pending) {
    if (!importedEnvelopes.has(envelope)) {
      // No candidates could be prepared from this envelope (only default
      // labels, or no agent pane at all): nothing to send.
      markAcknowledged(localStorage, envelope.importId)
    }
  }
  if (imports.length === 0) return
  await importLegacyNames(imports)
  // The whole sequence acknowledged (every chunk either succeeded or was
  // 400-terminal): NOW the envelopes retire. A throw above retires no
  // envelope, so the evidence stays pending for the next ready edge.
  for (const envelope of importedEnvelopes) {
    markAcknowledged(localStorage, envelope.importId)
  }
}

// ---------------------------------------------------------------------------
// The one client sanitizer
// ---------------------------------------------------------------------------

/**
 * The ONE sanitizer for scoped hydrated/flush pane-title metadata: strip
 * the ACTIVE local aliases and user-set flags of the six scoped agent
 * modes (their names are owned by the canonical server record — an
 * unacknowledged old label must never become another active override)
 * while leaving every out-of-scope pane verbatim. The pane's identity
 * (sessionRef/nameRef/namingHandle on the content) and the canonical
 * projections are untouched — this touches ONLY the title/flag maps.
 */
export function stripScopedPaneTitleMetadata(
  layouts: Record<string, unknown>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,
): {
  paneTitles: Record<string, Record<string, string>>
  paneTitleSetByUser: Record<string, Record<string, boolean>>
} {
  const scopedPaneIdsByTab = new Map<string, Set<string>>()
  for (const [tabId, layout] of Object.entries(layouts)) {
    const scoped = new Set<string>()
    for (const leaf of collectRawLeaves(layout)) {
      if (isRawScopedContent(leaf.content)) scoped.add(leaf.paneId)
    }
    if (scoped.size > 0) scopedPaneIdsByTab.set(tabId, scoped)
  }
  const nextTitles: Record<string, Record<string, string>> = {}
  const nextFlags: Record<string, Record<string, boolean>> = {}
  for (const [tabId, titles] of Object.entries(paneTitles)) {
    const scoped = scopedPaneIdsByTab.get(tabId)
    if (!scoped) {
      nextTitles[tabId] = { ...titles }
      continue
    }
    const filtered: Record<string, string> = {}
    for (const [paneId, title] of Object.entries(titles)) {
      if (scoped.has(paneId)) continue
      filtered[paneId] = title
    }
    if (Object.keys(filtered).length > 0) nextTitles[tabId] = filtered
  }
  for (const [tabId, flags] of Object.entries(paneTitleSetByUser)) {
    const scoped = scopedPaneIdsByTab.get(tabId)
    if (!scoped) {
      nextFlags[tabId] = { ...flags }
      continue
    }
    const filtered: Record<string, boolean> = {}
    for (const [paneId, flag] of Object.entries(flags)) {
      if (scoped.has(paneId)) continue
      filtered[paneId] = flag
    }
    if (Object.keys(filtered).length > 0) nextFlags[tabId] = filtered
  }
  return { paneTitles: nextTitles, paneTitleSetByUser: nextFlags }
}

/**
 * The tabs half of the sanitizer: a session-owned tab's stored freeze flag
 * (`titleSetByUser`) is an old alias — its name follows the canonical
 * record through the naming-source pointer. The flag drops; the stored
 * title TEXT stays: the saved-name tab title mirror
 * (`src/store/savedNameTabTitleMirror.ts`) keeps it equal to the session's
 * last-known saved name, so it is the right offline display. Every
 * nameSource-less/legacy tab is preserved verbatim.
 */
export function stripSessionOwnedTabFreezeFlags<
  T extends { id: string; titleSetByUser?: boolean; nameSource?: unknown },
>(tabs: T[]): T[] {
  return tabs.map((tab) => {
    const nameSource = tab.nameSource as { kind?: unknown } | undefined
    if (nameSource?.kind !== 'session' || tab.titleSetByUser !== true) return tab
    const { titleSetByUser: _dropped, ...rest } = tab
    return rest as T
  })
}

// The one-time capture pass (`@/lib/legacy-name-capture-policy`): runs at
// module load, before `@/store/storage-migration` and the store imports (see
// main.tsx), so a genuine legacy source is read before anything rewrites it.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  runOneTimeLegacyCapture(localStorage)
}
