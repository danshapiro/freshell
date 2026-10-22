/**
 * Unified agent names (Task 7) — the client side of the one-time
 * legacy-name consolidation.
 *
 * Three pinned functions (the plan's exact client contract):
 * - `captureLegacyNameEvidence(storage)` — a SIDE-EFFECT-ONLY synchronous
 *   capture of every supported raw legacy storage payload (per-window
 *   layout envelopes, the legacy bare/backup keys, the pre-migration raw
 *   sidecars, the v2 tabs/panes keys), each preserved as its own immutable
 *   recovery envelope under `freshell.session-names.migration.v1.<importId>`
 *   BEFORE the machine-workspace bootstrap (or a flush) can clear or
 *   rewrite it. Read-only w.r.t. the sources; running it twice is safe.
 *   This module must never import the Redux store — it runs from
 *   `main.tsx` BEFORE `@/store/storage-migration` and the store imports.
 * - `prepareLegacyNameImports(evidence)` — deterministic candidate
 *   extraction (at most 100 candidates per import) including the
 *   legacy-pending namingHandle derivation for unbound scoped panes.
 * - `importLegacyNames(imports)` — the HTTP submit against
 *   `POST /api/session-names/import`; acknowledged import ids are marked
 *   locally (evidence is retained after acknowledgment for recovery), an
 *   already-acknowledged import replays as a no-op without a request, and
 *   a failed submit keeps the import pending for retry. A chunked envelope
 *   (`<base>--<N>` derived ids) retires only when ALL its chunks
 *   acknowledged — a mid-sequence transient failure keeps the envelope
 *   pending so the next connection-ready edge resubmits exactly the
 *   unacknowledged chunks.
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
 * Plus the persistence flush gate (`ensureLegacyNameCapturesForFlush`): a
 * flush may rewrite a capture-source key only once the current raw bytes
 * are durably captured — while a capture write keeps failing, the flush
 * defers so uncaptured legacy labels survive for retry.
 */

import { nanoid } from 'nanoid'
import { api, ApiError } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { isScopedNameSourceContent } from '@/lib/tab-name-source'
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
import {
  FRESH_AGENT_BACKUP_KEY_SUFFIX,
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  LEGACY_LAYOUT_STORAGE_KEY,
  LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX,
  LAYOUT_STORAGE_KEY_PREFIX,
} from '@/store/window-layout-keys'
import { PANES_STORAGE_KEY, TABS_STORAGE_KEY } from '@/store/storage-keys'

const log = createLogger('SessionNameMigration')

/** The immutable recovery-envelope key prefix (one key per importId). */
export const SESSION_NAME_MIGRATION_KEY_PREFIX = 'freshell.session-names.migration.v1'
/** The acknowledged-importId marker prefix (create-once, no shared blob). */
const ACKNOWLEDGED_MARKER_SEGMENT = 'ack'
/** At most this many candidates ride one import. */
const IMPORT_CANDIDATE_LIMIT = 100

/**
 * Whether a capture-source envelope write has FAILED and uncaptured legacy
 * bytes may still sit in their source keys. The persistence flush gate
 * (`ensureLegacyNameCapturesForFlush`) consults this: a flush may rewrite a
 * capture-source key only once the current raw bytes are durably captured —
 * evicting uncaptured legacy labels is unrecoverable evidence loss.
 */
let captureWriteFailed = false

/** One captured immutable recovery envelope (the local storage shape). */
export type LegacyNameMigrationEnvelope = {
  version: 1
  importId: string
  storageKey: string
  raw: string
  capturedAt: number
}

/** A derived legacy-pending naming handle for one unbound scoped pane. */
export type LegacyPendingHandleAssignment = {
  storageKey: string
  windowId: string | null
  tabId: string
  paneId: string
  createRequestId: string
  namingHandle: string
}

// ---------------------------------------------------------------------------
// Capture-source key taxonomy (owned by window-layout-keys; re-derived here
// through its exported constants so this module adds no new taxonomy).
// ---------------------------------------------------------------------------

/** Is `key` a supported raw legacy-name capture source? */
export function isLegacyNameCaptureSourceKey(key: string): boolean {
  if (
    key === LEGACY_LAYOUT_STORAGE_KEY
    || key === LEGACY_LAYOUT_BACKUP_STORAGE_KEY
    || key === TABS_STORAGE_KEY
    || key === PANES_STORAGE_KEY
  ) {
    return true
  }
  if (key.startsWith(`${LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX}.`)) return true
  if (key.startsWith(`${LAYOUT_STORAGE_KEY_PREFIX}.`)) {
    const suffix = key.slice(LAYOUT_STORAGE_KEY_PREFIX.length + 1)
    if (suffix.length === 0) return false
    // Per-window envelopes (`<id>`), per-window backups (`<id>.bak`), the
    // legacy backup channel (`bak`), and the legacy fresh-agent
    // centralization backup. The commit/pending markers carry no layout
    // evidence and the per-window ids contain no dots.
    if (suffix.includes('.')) {
      // A per-window channel suffix (`<id>.bak`, `<id>.backup-before-…`):
      // everything after the window id must be the channel itself.
      const channel = suffix.slice(suffix.indexOf('.') + 1)
      return channel === 'bak' || channel.endsWith('.bak') || channel === FRESH_AGENT_BACKUP_KEY_SUFFIX
    }
    return true
  }
  return false
}

/** The per-window id a capture source key belongs to (null for the legacy
 * shared keys) — one segment of the legacy-pending handle tuple. */
export function legacyCaptureWindowId(key: string): string | null {
  if (!key.startsWith(`${LAYOUT_STORAGE_KEY_PREFIX}.`)) return null
  const suffix = key.slice(LAYOUT_STORAGE_KEY_PREFIX.length + 1)
  const windowId = suffix.split('.')[0]
  return windowId.length > 0 ? windowId : null
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function envelopeKey(importId: string): string {
  return `${SESSION_NAME_MIGRATION_KEY_PREFIX}.${importId}`
}

function acknowledgedKey(importId: string): string {
  return `${SESSION_NAME_MIGRATION_KEY_PREFIX}.${ACKNOWLEDGED_MARKER_SEGMENT}.${importId}`
}

function isAcknowledged(storage: Storage, importId: string): boolean {
  try {
    return storage.getItem(acknowledgedKey(importId)) !== null
  } catch {
    return false
  }
}

/** Mark one import id acknowledged (create-once; evidence is retained). */
function markAcknowledged(storage: Storage, importId: string): void {
  try {
    if (!isAcknowledged(storage, importId)) {
      storage.setItem(acknowledgedKey(importId), '1')
    }
  } catch (error) {
    log.error('failed to mark a legacy-name import acknowledged; it will resubmit idempotently', { importId, error })
  }
}

/** Parse one stored envelope; undefined for anything else (ack markers). */
function parseStoredEnvelope(raw: string | null): LegacyNameMigrationEnvelope | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyNameMigrationEnvelope>
    if (
      parsed?.version === 1
      && typeof parsed.importId === 'string' && parsed.importId.length > 0
      && typeof parsed.storageKey === 'string' && parsed.storageKey.length > 0
      && typeof parsed.raw === 'string'
    ) {
      return parsed as LegacyNameMigrationEnvelope
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Enumerate the captured envelopes by prefix. */
export function listCapturedMigrationEnvelopes(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'> = localStorage,
): LegacyNameMigrationEnvelope[] {
  const envelopes: LegacyNameMigrationEnvelope[] = []
  const seen = new Set<string>()
  try {
    const total = storage.length
    for (let index = 0; index < total; index += 1) {
      const key = storage.key(index)
      if (!key || !key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.`)) continue
      const envelope = parseStoredEnvelope(storage.getItem(key))
      if (!envelope || seen.has(envelope.importId)) continue
      seen.add(envelope.importId)
      envelopes.push(envelope)
    }
  } catch (error) {
    log.error('failed to enumerate captured legacy-name envelopes', { error })
  }
  return envelopes
}

/**
 * The synchronous side-effect capture: preserve every supported raw legacy
 * payload as its own immutable per-importId envelope BEFORE the
 * machine-workspace bootstrap or a persistence flush can clear or rewrite
 * it. Idempotent (an identical storageKey+raw pair is never re-captured);
 * retry-stable (the same storageKey keeps its first importId, and a
 * CHANGED payload under the same key gets a NEW envelope — the original
 * bytes are never overwritten); per-window isolated (two starting windows
 * each write their own envelope keys — there is no shared aggregate blob
 * either one could clobber). A failed envelope write reports the failure
 * and keeps the import pending; the source is never cleared here.
 */
export function captureLegacyNameEvidence(
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'> = localStorage,
): LegacyEvidenceEnvelope[] {
  const existing = listCapturedMigrationEnvelopes(storage)
  const existingBySource = new Map<string, LegacyNameMigrationEnvelope[]>()
  for (const envelope of existing) {
    const list = existingBySource.get(envelope.storageKey) ?? []
    list.push(envelope)
    existingBySource.set(envelope.storageKey, list)
  }
  const captured: LegacyNameMigrationEnvelope[] = [...existing]
  try {
    const total = storage.length
    for (let index = 0; index < total; index += 1) {
      const key = storage.key(index)
      if (!key || !isLegacyNameCaptureSourceKey(key)) continue
      const raw = storage.getItem(key)
      if (typeof raw !== 'string' || raw.length === 0) continue
      const prior = existingBySource.get(key) ?? []
      if (prior.some((envelope) => envelope.raw === raw)) continue
      const envelope: LegacyNameMigrationEnvelope = {
        version: 1,
        importId: nanoid(),
        storageKey: key,
        raw,
        capturedAt: Date.now(),
      }
      // Write-once per importId: a key collision (impossible for a fresh
      // nanoid) never rewrites an existing envelope.
      if (storage.getItem(envelopeKey(envelope.importId)) !== null) continue
      storage.setItem(envelopeKey(envelope.importId), JSON.stringify(envelope))
      captured.push(envelope)
      prior.push(envelope)
      existingBySource.set(key, prior)
    }
    // A completing pass touched every source: nothing is left uncaptured.
    captureWriteFailed = false
  } catch (error) {
    // Do not clear the source; keep a retryable capture pending.
    captureWriteFailed = true
    log.error('legacy-name evidence capture failed; sources retained for retry', { error })
  }
  return captured.map((envelope) => ({
    storageKey: envelope.storageKey,
    raw: envelope.raw,
  }))
}

/**
 * The connection-readiness gate for mid-session submits, registered by the
 * store wiring (which owns the connection state) so this module never
 * imports the store. Unregistered means "not ready": captured evidence
 * simply waits for the next ready edge.
 */
let submitGate: () => boolean = () => false

export function registerLegacyNameSubmitGate(gate: () => boolean): void {
  submitGate = gate
}

/**
 * Mid-session capture hook for OLD envelopes arriving later via crossTabSync:
 * the incoming raw is captured (and, when the server connection is ready,
 * the pending submit retriggered) BEFORE any sanitized hydrate runs, so a
 * pre-change window's flush can never evaporate its legacy labels. Not-ready
 * captures wait for the next ready edge — the evidence is durably captured.
 */
export function captureLegacyLayoutEnvelope(
  storageKey: string,
  raw: string,
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'> = localStorage,
): void {
  if (!isLegacyNameCaptureSourceKey(storageKey)) return
  const existing = listCapturedMigrationEnvelopes(storage)
  if (existing.some((envelope) => envelope.storageKey === storageKey && envelope.raw === raw)) {
    return
  }
  const envelope: LegacyNameMigrationEnvelope = {
    version: 1,
    importId: nanoid(),
    storageKey,
    raw,
    capturedAt: Date.now(),
  }
  try {
    if (storage.getItem(envelopeKey(envelope.importId)) === null) {
      storage.setItem(envelopeKey(envelope.importId), JSON.stringify(envelope))
      if (submitGate()) {
        void submitPendingLegacyNameImports().catch(() => {
          // The next ready edge retries; the evidence is durably captured.
        })
      }
    }
  } catch (error) {
    // An uncaptured raw is sitting in its source key: record it so the
    // persistence flush gate re-captures before any flush can evict it.
    captureWriteFailed = true
    log.error('failed to capture a cross-window legacy layout envelope', { storageKey, error })
  }
}

// ---------------------------------------------------------------------------
// The persistence flush gate (review M2)
// ---------------------------------------------------------------------------

/**
 * The persistence flush gate: a flush may rewrite a capture-source key ONLY
 * once the current raw bytes are durably captured in an envelope. When a
 * capture write has failed (e.g. quota), this re-attempts the capture
 * immediately before the caller serializes; when the re-capture still fails
 * the caller MUST defer its write — evicting uncaptured legacy labels is
 * unrecoverable evidence loss (there is no backup copy anywhere). With no
 * recorded failure this is a cheap O(1) yes.
 */
export function ensureLegacyNameCapturesForFlush(
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'> = localStorage,
): boolean {
  if (!captureWriteFailed) return true
  captureLegacyNameEvidence(storage)
  return !captureWriteFailed
}

/** Test-only: reset the recorded capture-failure state between tests. */
export function resetLegacyNameCaptureFailureForTests(): void {
  captureWriteFailed = false
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

    // One source-tab label maps only to its resolved naming-source session:
    // the tab's persisted nameSource pane when it names a scoped pane, else
    // the deterministic original candidate (the FIRST pane, when scoped).
    // A first-leaf non-agent tab keeps its legacy label — recovery-only.
    const nameSource = tab.nameSource as { kind?: unknown; paneId?: unknown } | undefined
    let source: { pane: { paneId: string; content: RawPaneContent }; identity: { target: LegacyNameTarget } } | undefined
    if (nameSource?.kind === 'session' && typeof nameSource.paneId === 'string') {
      source = scopedLeaves.find((entry) => entry.pane.paneId === nameSource.paneId)
    }
    source ??= scopedLeaves[0] && leaves[0] && scopedLeaves[0].pane.paneId === leaves[0].paneId
      ? scopedLeaves[0]
      : undefined
    const tabTitle = typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : undefined
    if (tabTitle && source) {
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
      if (!paneTitle) continue
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
  evidence: LegacyEvidenceEnvelope[] = listCapturedMigrationEnvelopes().map((envelope) => ({
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
 * its OWN import id is marked acknowledged locally (the evidence envelopes
 * are RETAINED for recovery — only the pending-submit skips them), and an
 * already-acknowledged import replays as a no-op WITHOUT a request — so a
 * resumed sequence never re-imports the chunks that landed (per-candidate
 * acknowledgment makes that safe/idempotent server-side anyway). A chunked
 * envelope's BASE id is deliberately NOT marked here: only
 * [`submitPendingLegacyNameImports`] retires an envelope, and only after
 * ALL its chunks acknowledged. A failure throws after logging; the caller
 * keeps the envelope pending for the next connection-ready edge.
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
        // the pending submit stops resubmitting it; the immutable envelope
        // retains the evidence.
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
 * Submit every still-pending captured import once the server connection is
 * ready (the store wiring calls this on each ready edge; the server's
 * per-candidate acknowledgments make repeated submits idempotent).
 * Envelopes that yield no candidates are marked acknowledged (nothing to
 * import). An envelope with chunked imports is retired ONLY after the
 * awaited submit acknowledged ALL its chunks — a mid-sequence transient
 * failure throws before the retirement, so the next ready edge re-prepares
 * the whole envelope and `importLegacyNames` resubmits exactly the
 * unacknowledged chunks (the landed ones replay as local no-ops).
 *
 * The envelope↔chunk pairing is by EVIDENCE (each chunk import carries the
 * source envelope it was prepared from), never by parsing import-id
 * strings — a captured nanoid may itself contain `--`, so a
 * `${base}--<n>`-string heuristic could mispair and retire an envelope
 * mid-sequence.
 */
export async function submitPendingLegacyNameImports(): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const envelopes = listCapturedMigrationEnvelopes()
  const pending = envelopes.filter((envelope) => !isAcknowledged(localStorage, envelope.importId))
  if (pending.length === 0) return
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
      // No candidates could be prepared from this envelope (sanitized or
      // corrupted bytes): nothing to acknowledge server-side.
      markAcknowledged(localStorage, envelope.importId)
    }
  }
  if (imports.length === 0) return
  await importLegacyNames(imports)
  // The whole sequence acknowledged (every chunk either succeeded or was
  // 400-terminal): NOW the envelopes retire. A throw above marks no
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
 * title TEXT stays as the last-known canonical projection (offline
 * display), and every nameSource-less/legacy tab is preserved verbatim.
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

// The side-effect capture itself: MUST run before `@/store/storage-migration`
// and the store imports (see main.tsx) — before the machine-workspace
// bootstrap or any flush can clear or rewrite a legacy source.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
  captureLegacyNameEvidence(localStorage)
}
