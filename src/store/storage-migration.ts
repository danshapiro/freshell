// ============================================================
// localStorage Migration
// ============================================================
// This module MUST be imported before any slices that load from localStorage.
// When the persisted state schema changes in breaking ways, we increment
// STORAGE_VERSION to trigger a full clear on the next load.
//
// Increment STORAGE_VERSION when:
// - Tab/Pane structure changes
// - Coding CLI event schema changes (session.init → session.start, etc.)
// - Composite key format changes (provider:sessionId)
// - Any persisted state shape changes incompatibly
// ============================================================

import { createLogger } from '@/lib/client-logger'
import { clearAuthCookie } from '@/lib/auth'
import {
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_MIGRATION_ID,
  LAYOUT_SCHEMA_VERSION,
  PANES_SCHEMA_VERSION,
  hashPersistedLayoutRaw,
  migrateV2ToV3,
  parseLayoutFreshAgentCommitMarker,
  readRecoverablePersistedLayoutRaw,
} from './persistedState'
import {
  BROWSER_PREFERENCES_STORAGE_KEY,
  STORAGE_VERSION,
  STORAGE_VERSION_KEY,
} from './storage-keys'
import { LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY } from './storage-keys'
import { STALE_LAYOUT_MS } from '@/lib/recovery/stale-layout-threshold'
import {
  LEGACY_LAYOUT_STORAGE_KEY,
  LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
  LAYOUT_STORAGE_KEY_PREFIX,
  LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX,
  derivedLayoutPreMigrationRawKey,
  getLayoutWindowId,
  getWindowFreshAgentBackupKey,
  getWindowFreshAgentCommitMarkerKey,
  getWindowFreshAgentPendingMarkerKey,
  getWindowLayoutKey,
  getWindowLayoutPreMigrationRawKey,
  isDerivedLayoutKey,
  FRESH_AGENT_BACKUP_KEY_SUFFIX,
  FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX,
  FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX,
} from './window-layout-keys'
import {
  buildRestoreError,
  migrateLegacyTerminalDurableState,
  type RestoreError,
  sanitizeSessionRef,
} from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { migrateLegacyFreshAgentContent, migrateLegacyFreshAgentDurableState } from '@shared/fresh-agent'
import { isDurableProviderSessionId } from '@shared/session-flavor'
import { normalizeFreshAgentPaneModelSelection } from './paneTypes'

const log = createLogger('StorageMigration')

const AUTH_STORAGE_KEY = 'freshell.auth-token'
const LEGACY_BROWSER_PREFERENCE_KEYS = [
  'freshell.terminal.fontFamily.v1',
] as const

type PersistedLayoutMigrationResult = 'none' | 'migrated' | 'failed'

function warnStructured(event: string, details: Record<string, unknown>): void {
  log.warn(JSON.stringify({
    severity: 'warn',
    component: 'storage-migration',
    event,
    ...details,
  }))
}

function readStorageVersion(): number {
  const stored = localStorage.getItem(STORAGE_VERSION_KEY)
  if (!stored) return 0
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function clearFreshellKeysExcept(keep: string[], keepPrefixes: string[] = []): void {
  // Delta round 3, finding 1: the layout family and the pre-migration
  // evidence sidecars are keyed per window, so the version-bump wipe keeps
  // whole PREFIXES — every window's derived envelope, its .bak and
  // fresh-agent channels, and its sidecar — plus the legacy keys (the
  // layout prefix covers the bare legacy key, the legacy .bak, and the
  // legacy centralization channels; they are never deleted either).
  const keepSet = new Set(keep)
  for (const key of Object.keys(localStorage)) {
    if (!(key.startsWith('freshell.') || key === STORAGE_VERSION_KEY)) continue
    if (keepSet.has(key)) continue
    if (keepPrefixes.some((prefix) => key.startsWith(prefix))) continue
    localStorage.removeItem(key)
  }
}

function normalizeLayoutTab(tab: Record<string, unknown>): Record<string, unknown> {
  const mode = typeof tab.mode === 'string' ? tab.mode : undefined
  const codingCliProvider = typeof tab.codingCliProvider === 'string' ? tab.codingCliProvider : undefined
  const provider = codingCliProvider || (mode && mode !== 'shell' ? mode : undefined)
  const durableState = migrateLegacyTerminalDurableState({
    provider,
    sessionRef: tab.sessionRef,
    resumeSessionId: typeof tab.resumeSessionId === 'string' ? tab.resumeSessionId : undefined,
  })
  const codexDurability = sanitizeCodexDurabilityRef(tab.codexDurability)
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, ...rest } = tab
  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
  }
}

function isCodexSessionRef(sessionRef: unknown): sessionRef is { provider: 'codex'; sessionId: string } {
  return !!sessionRef
    && typeof sessionRef === 'object'
    && (sessionRef as { provider?: unknown }).provider === 'codex'
    && typeof (sessionRef as { sessionId?: unknown }).sessionId === 'string'
    && (sessionRef as { sessionId: string }).sessionId.length > 0
}

function normalizeLegacyRecoveryFailedTerminal(
  content: Record<string, unknown>,
  durableState: { sessionRef?: unknown },
): Record<string, unknown> {
  if (content.kind !== 'terminal' || content.mode !== 'codex' || content.status !== 'recovery_failed') {
    return content
  }

  const {
    terminalId: _terminalId,
    status: _status,
    restoreError: _restoreError,
    ...rest
  } = content
  if (isCodexSessionRef(durableState.sessionRef)) {
    return {
      ...rest,
      status: 'creating',
    }
  }

  return {
    ...rest,
    status: 'error',
    restoreError: buildRestoreError('invalid_legacy_restore_target'),
  }
}

function readRestoreError(value: unknown): RestoreError | undefined {
  return (
    value
    && typeof value === 'object'
    && (value as any).code === 'RESTORE_UNAVAILABLE'
    && typeof (value as any).reason === 'string'
  )
    ? value as RestoreError
    : undefined
}

function hasFreshAgentLayoutMigrationMarkerForCurrentRaw(): boolean {
  const raw = localStorage.getItem(getWindowLayoutKey())
  if (!raw) return false
  const marker = parseLayoutFreshAgentCommitMarker(localStorage.getItem(getWindowFreshAgentCommitMarkerKey()))
  return marker?.migratedHash === hashPersistedLayoutRaw(raw)
}

function normalizeLayoutNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const candidate = node as Record<string, unknown>

  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = migrateLegacyFreshAgentContent(candidate.content as Record<string, unknown>) as Record<string, unknown>
    if (content.kind === 'terminal') {
      const durableState = migrateLegacyTerminalDurableState({
        provider: typeof content.mode === 'string' && content.mode !== 'shell' ? content.mode : undefined,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
      })
      const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
      const codexDurability = sanitizeCodexDurabilityRef(content.codexDurability)
      const normalizedRuntime = normalizeLegacyRecoveryFailedTerminal(rest, durableState)
      const isLegacyRecoveryFailed = (
        rest.kind === 'terminal'
        && rest.mode === 'codex'
        && rest.status === 'recovery_failed'
      )
      const normalizedSessionRef = isLegacyRecoveryFailed && !isCodexSessionRef(durableState.sessionRef)
        ? undefined
        : durableState.sessionRef
      return {
        ...candidate,
        content: {
          ...normalizedRuntime,
          ...(normalizedSessionRef ? { sessionRef: normalizedSessionRef } : {}),
          ...(codexDurability ? { codexDurability } : {}),
          ...(!isLegacyRecoveryFailed && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    if (content.kind === 'fresh-agent') {
      const existingRestoreError = readRestoreError(content.restoreError)
      if (existingRestoreError) {
        const provider = content.provider === 'claude' || content.provider === 'codex' || content.provider === 'opencode'
          ? content.provider
          : undefined
        const candidateSessionRef = sanitizeSessionRef(content.sessionRef)
        const retainedSessionRef = existingRestoreError.reason !== 'invalid_legacy_restore_target'
          && candidateSessionRef !== undefined
          && candidateSessionRef.provider === provider
          && isDurableProviderSessionId(provider, candidateSessionRef.sessionId)
          ? candidateSessionRef
          : undefined
        const {
          sessionRef: _legacySessionRef,
          restoreError: _legacyRestoreError,
          // Vestigial per-pane display overrides (no writer since 2026-04):
          // dropped during migration, never constructed into pane content.
          showThinking: _legacyShowThinking,
          showTools: _legacyShowTools,
          ...restWithPossibleResume
        } = content

        const rest = existingRestoreError.reason === 'invalid_legacy_restore_target'
          ? (() => {
              const {
                resumeSessionId: _legacyResumeSessionId,
                timelineSessionId: _legacyTimelineSessionId,
                cliSessionId: _legacyCliSessionId,
                ...withoutLegacyIdentity
              } = restWithPossibleResume
              return withoutLegacyIdentity
            })()
          : restWithPossibleResume

        return {
          ...candidate,
          content: {
            ...rest,
            ...(retainedSessionRef ? { sessionRef: retainedSessionRef } : {}),
            ...(retainedSessionRef?.provider === 'claude' ? { sessionId: retainedSessionRef.sessionId } : {}),
            restoreError: existingRestoreError,
          },
        }
      }

      const provider = content.provider === 'claude' || content.provider === 'codex' || content.provider === 'opencode'
        ? content.provider
        : undefined
      const durableState = migrateLegacyFreshAgentDurableState({
        provider,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string'
          ? content.resumeSessionId
          : (typeof content.timelineSessionId === 'string'
              ? content.timelineSessionId
              : (typeof content.cliSessionId === 'string' ? content.cliSessionId : undefined)),
        rejectNonCanonicalClaudeSessionRef: true,
      })
      const {
        sessionRef: _legacySessionRef,
        restoreError: _legacyRestoreError,
        // Vestigial per-pane display overrides (no writer since 2026-04):
        // dropped during migration, never constructed into pane content.
        showThinking: _legacyShowThinking,
        showTools: _legacyShowTools,
        ...rest
      } = content
      const restWithNormalizedModel = content.sessionType === 'freshopencode' && content.provider === 'opencode'
        ? (() => {
            const {
              model: legacyModel,
              modelSelection: legacyModelSelection,
              ...withoutModel
            } = rest
            return {
              ...withoutModel,
              modelSelection: normalizeFreshAgentPaneModelSelection({
                sessionType: content.sessionType,
                provider: content.provider,
                modelSelection: legacyModelSelection,
                legacyModel,
              }),
            }
          })()
        : rest
      return {
        ...candidate,
        content: {
          ...restWithNormalizedModel,
          ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
          ...('restoreError' in durableState && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    const sanitizedSessionRef = sanitizeSessionRef(content.sessionRef)
    if (!sanitizedSessionRef) return node

    const { sessionRef: _legacySessionRef, ...rest } = content
    return {
      ...candidate,
      content: {
        ...rest,
        sessionRef: sanitizedSessionRef,
      },
    }
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length === 2) {
    return {
      ...candidate,
      children: [
        normalizeLayoutNode(candidate.children[0]),
        normalizeLayoutNode(candidate.children[1]),
      ],
    }
  }

  return node
}

// The raw `freshell.layout.v3` envelope as it stood just BEFORE this
// boot's rewrite landed (e2r1 review finding 1). The every-boot
// normalizeLayoutNode pass strips content keys the recovery health
// classifier must still see (e.g. a terminal sessionRef that fails
// sanitizeSessionRef) from the STORED raw before classification runs,
// so the classifier reads the pre-rewrite envelope through
// getPreMigrationLayoutRaw() instead. Null when no rewrite occurred
// this boot (marker-guard held) — then the stored raw is its own
// pre-migration truth. One browser window is one JS realm, so one
// capture per boot is the correct scope; the rewrite ALSO mirrors this
// raw into the DURABLE per-window pre-migration evidence sidecar
// (freshell.layout.pre-migration-raw.v1.<layoutWindowId>) because this
// capture is empty
// again after a reload — see writeMigratedLayoutWithRecovery (e2r4
// review finding 1).
let preMigrationLayoutRaw: string | null = null

export function getPreMigrationLayoutRaw(): string | null {
  return preMigrationLayoutRaw
}

function writeMigratedLayoutWithRecovery(originalRaw: string, migratedRaw: string, expectedCurrentRaw: string): boolean {
  const layoutKey = getWindowLayoutKey()
  const backupKey = getWindowFreshAgentBackupKey()
  const commitMarkerKey = getWindowFreshAgentCommitMarkerKey()
  const pendingMarkerKey = getWindowFreshAgentPendingMarkerKey()
  try {
    localStorage.setItem(backupKey, originalRaw)
  } catch (error) {
    warnStructured('fresh_agent_layout_backup_write_failed', {
      key: backupKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  const currentRaw = localStorage.getItem(layoutKey)
  if (currentRaw !== expectedCurrentRaw) {
    try {
      localStorage.removeItem(backupKey)
      localStorage.removeItem(commitMarkerKey)
      localStorage.removeItem(pendingMarkerKey)
    } catch (error) {
      warnStructured('fresh_agent_layout_interleaving_cleanup_failed', {
        backupKey,
        markerKey: commitMarkerKey,
        pendingMarkerKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    warnStructured('fresh_agent_layout_interleaving_write_detected', {
      key: layoutKey,
    })
    return false
  }

  const pendingMarkerRaw = JSON.stringify({
    version: 1,
    migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
    backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
    originalHash: hashPersistedLayoutRaw(originalRaw),
    migratedHash: hashPersistedLayoutRaw(migratedRaw),
    startedAt: Date.now(),
  })

  try {
    localStorage.removeItem(commitMarkerKey)
    localStorage.setItem(pendingMarkerKey, pendingMarkerRaw)
  } catch (error) {
    warnStructured('fresh_agent_layout_pending_marker_write_failed', {
      key: pendingMarkerKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  // Durable evidence sidecar (e2r4 review finding 1): mirror the PRE-rewrite
  // raw into a dedicated key so the health classifier can still see what the
  // rewrite sanitized after a reload — the process-local capture below is
  // empty in the next JS realm. Written ONLY when the key holds no value:
  // OLDEST EVIDENCE WINS, a later boot's rewrite must never overwrite the
  // original corrupt raw. A failed write only warns; this boot still
  // classifies through the process-local capture.
  try {
    if (localStorage.getItem(getWindowLayoutPreMigrationRawKey()) === null) {
      localStorage.setItem(getWindowLayoutPreMigrationRawKey(), originalRaw)
    }
  } catch (error) {
    warnStructured('fresh_agent_layout_evidence_write_failed', {
      key: getWindowLayoutPreMigrationRawKey(),
      error: error instanceof Error ? error.message : String(error),
    })
  }

  preMigrationLayoutRaw = originalRaw
  try {
    localStorage.setItem(layoutKey, migratedRaw)
  } catch (error) {
    try {
      localStorage.removeItem(pendingMarkerKey)
    } catch {
      // keep the original write failure as the useful signal
    }
    warnStructured('fresh_agent_layout_write_failed', {
      key: layoutKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.setItem(commitMarkerKey, JSON.stringify({
      version: 1,
      migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
      backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hashPersistedLayoutRaw(originalRaw),
      migratedHash: hashPersistedLayoutRaw(migratedRaw),
      committedAt: Date.now(),
    }))
  } catch (error) {
    warnStructured('fresh_agent_layout_commit_marker_write_failed', {
      key: commitMarkerKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.removeItem(pendingMarkerKey)
  } catch (error) {
    warnStructured('fresh_agent_layout_pending_marker_cleanup_failed', {
      key: pendingMarkerKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return true
}

function migratePersistedLayout(): PersistedLayoutMigrationResult {
  const expectedCurrentRaw = localStorage.getItem(getWindowLayoutKey())
  const raw = readRecoverablePersistedLayoutRaw()
  if (!raw) return 'none'

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'none'
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.tabs || !parsed.panes) {
    return 'none'
  }

  const nextTabs = Array.isArray(parsed.tabs.tabs)
    ? parsed.tabs.tabs.map((tab: Record<string, unknown>) => normalizeLayoutTab(tab))
    : []
  const nextLayouts = parsed.panes.layouts && typeof parsed.panes.layouts === 'object'
    ? Object.fromEntries(
      Object.entries(parsed.panes.layouts as Record<string, unknown>).map(([tabId, node]) => [tabId, normalizeLayoutNode(node)]),
    )
    : {}

  const migratedRaw = JSON.stringify({
    persistedAt: typeof parsed.persistedAt === 'number' ? parsed.persistedAt : Date.now(),
    version: LAYOUT_SCHEMA_VERSION,
    machineId: typeof parsed.machineId === 'string' && parsed.machineId ? parsed.machineId : undefined,
    tabs: {
      ...parsed.tabs,
      activeTabId: parsed.tabs.activeTabId ?? null,
      tabs: nextTabs,
    },
    panes: {
      version: Math.max(typeof parsed.panes.version === 'number' ? parsed.panes.version : 1, PANES_SCHEMA_VERSION),
      layouts: nextLayouts,
      activePane: parsed.panes.activePane ?? {},
      paneTitles: parsed.panes.paneTitles ?? {},
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser ?? {},
    },
    tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
  })

  return writeMigratedLayoutWithRecovery(raw, migratedRaw, expectedCurrentRaw ?? raw) ? 'migrated' : 'failed'
}

function preservePersistedLayout(): PersistedLayoutMigrationResult {
  if (hasFreshAgentLayoutMigrationMarkerForCurrentRaw()) {
    return 'none'
  }

  const migrated = migratePersistedLayout()
  if (migrated !== 'none') {
    return migrated
  }

  if (!migrateV2ToV3()) {
    return 'none'
  }

  return migratePersistedLayout()
}

/** One-shot LEGACY adoption (delta round 3, finding 1; e3r1 finding 2):
 * when THIS window's derived per-window layout key is ABSENT but the
 * pre-change origin-wide key exists, adopt the legacy envelope as this
 * window's own: a byte-identical copy into the derived key, which the
 * normal preserve/migrate flow below then migrates exactly as today. The
 * adoption is ONE-SHOT and GLOBAL — the FIRST window to adopt sets the
 * `freshell.layout.legacy-adopted.v1` marker; every LATER window (fresh
 * id, no derived key) sees the marker and NEVER adopts, so it classifies
 * absent and rebuilds via the machine-bootstrap inventory instead of
 * copying an obsolete envelope (or mis-attributing an unstamped one to a
 * newly selected machine). The legacy key is NEVER deleted: other live
 * pre-change windows may still read it. A window that already has its
 * own envelope ignores later legacy-key writes from pre-change windows.
 *
 * e3r2 finding 2 (claim-then-verify) + e3r4 finding 1
 * (claim → copy → confirm-commit): two simultaneous upgrade boots can
 * both pass the absent checks before either sets the marker, so the
 * claim is written FIRST — the marker carrying THIS window's
 * layout-window-id — and read back immediately; the copy proceeds ONLY
 * if the read still returns the claimer's own id. The one-shot is
 * committed as spent only AFTER the legacy copy succeeds: a failed copy
 * (quota/write error) rolls the claim back — best-effort remove, and
 * only while the marker still carries OUR id (removing a foreign
 * claimant's marker would un-spend THEIR one-shot) — so a later window
 * can still adopt. A POST-COPY re-verify round then re-reads the claim:
 * if a foreign claimant won the marker while we copied, we discard our
 * copied key (best-effort remove) and take the absent path (own-snapshot
 * rebuild), so the previously unrecoverable interleave
 * A-write → A-read → B-write → B-read (both read back their own id,
 * both copy) converges to exactly ONE adopter: B keeps, A discards and
 * rebuilds. Residual, irreducible without an atomic test-and-set: when
 * the claim legitimately survives our re-verify BEFORE a foreign
 * claimant's write lands (A completes fully, then B claims), BOTH
 * windows adopt — but they copy the SAME shared legacy envelope, so the
 * worst case equals the pre-upgrade shared-envelope behavior for exactly
 * those two simultaneously-booting windows; every later window is still
 * gated by the marker-present check. Serialization guarantee relied on:
 * each single localStorage getItem/setItem is atomic against the shared
 * per-origin map, but HTML explicitly promises NO locking across agent
 * clusters — "authors are encouraged to assume that there is no locking
 * mechanism" (webstorage.html §12.1). The COMPLETE future mechanism is
 * navigator.locks (Web Locks API); this path deliberately stays
 * dependency-free. */
function readLegacyAdoptionClaimOwnerId(): unknown {
  try {
    return (JSON.parse(localStorage.getItem(LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY) ?? '') as { ownerId?: unknown })?.ownerId
  } catch {
    return undefined
  }
}

function adoptLegacyLayoutIntoWindowKey(): void {
  const ownKey = getWindowLayoutKey()
  try {
    if (localStorage.getItem(ownKey) !== null) return
    const legacyRaw = localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY)
    if (legacyRaw === null) return
    if (localStorage.getItem(LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY) !== null) return
    const ownerId = getLayoutWindowId()
    localStorage.setItem(LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY, JSON.stringify({
      version: 1,
      ownerId,
      adoptedAt: Date.now(),
    }))
    if (readLegacyAdoptionClaimOwnerId() !== ownerId) return
    try {
      localStorage.setItem(ownKey, legacyRaw)
    } catch (error) {
      if (readLegacyAdoptionClaimOwnerId() === ownerId) {
        try {
          localStorage.removeItem(LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY)
        } catch {
          // best-effort rollback: a retained marker only costs later
          // windows the rebuild path
        }
      }
      warnStructured('layout_legacy_adoption_copy_failed', {
        key: ownKey,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (readLegacyAdoptionClaimOwnerId() !== ownerId) {
      let discarded = false
      try {
        localStorage.removeItem(ownKey)
        discarded = true
      } catch {
        // best-effort discard: a surviving copy degrades to the bounded
        // double-adopt residual, never data loss
      }
      warnStructured('layout_legacy_adoption_claim_lost', {
        key: ownKey,
        discarded,
      })
      return
    }
    log.info('Adopted the legacy layout envelope into this window\u2019s per-window key (one-shot).')
  } catch (error) {
    warnStructured('layout_legacy_adoption_write_failed', {
      key: ownKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Remove a layout envelope and every side channel attached to its key:
 * the .bak backup, the fresh-agent centralization channels, and the
 * pre-migration evidence sidecar (the per-window sidecar for a derived
 * key, the legacy shared sidecar for the bare legacy key). */
function removeLayoutEnvelopeAndChannels(envelopeKey: string, layoutWindowId?: string): void {
  localStorage.removeItem(envelopeKey)
  localStorage.removeItem(`${envelopeKey}.bak`)
  localStorage.removeItem(`${envelopeKey}.${FRESH_AGENT_BACKUP_KEY_SUFFIX}`)
  localStorage.removeItem(`${envelopeKey}.${FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX}`)
  localStorage.removeItem(`${envelopeKey}.${FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX}`)
  localStorage.removeItem(
    layoutWindowId !== undefined
      ? derivedLayoutPreMigrationRawKey(layoutWindowId)
      : LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
  )
}

/** The prune paths' shared aging rule: returns the envelope's numeric
 * persistedAt ONLY when it is older than STALE_LAYOUT_MS — the same
 * threshold the health gate uses — else null (including unparseable raw
 * or a non-numeric persistedAt: an envelope whose age cannot be
 * determined is kept, because the health gate owns corrupt
 * classification and the prune never destroys evidence it cannot age). */
function staleEnvelopePersistedAt(raw: string | null, now: number): number | null {
  if (raw === null) return null
  let persistedAt: unknown
  try {
    persistedAt = (JSON.parse(raw) as { persistedAt?: unknown })?.persistedAt
  } catch {
    return null
  }
  return typeof persistedAt === 'number' && now - persistedAt > STALE_LAYOUT_MS
    ? persistedAt
    : null
}

/** Stale-threshold prune sweep at migration boot (e3r1 finding 5): fresh
 * contexts mint new layout-window ids with no close/expiry path, so
 * closed-window envelopes (and their side channels) would accumulate
 * unboundedly until quota exhaustion breaks persistence. Enumerate the
 * layout-prefix keys, parse ONLY envelope-shaped keys (the derived
 * per-window envelopes and the bare legacy key), and remove those beyond
 * the shared stale age. Runs BEFORE legacy adoption so a beyond-threshold
 * legacy envelope is pruned rather than adopted. THIS window's own
 * derived key is SPARED (e3 post-cap finding 2): the boot classifier must
 * see a stale own envelope to classify it STALE and rebuild with the
 * stale reason propagated — sweeping it here relabeled every real stale
 * boot 'absent'. The App gate retires the own envelope after its
 * keep-vs-rebuild decision via pruneOwnStaleLayoutEnvelope(); every other
 * window's key keeps the abandoned-key hygiene below. */
function pruneStaleLayoutEnvelopes(): void {
  try {
    const now = Date.now()
    const ownKey = getWindowLayoutKey()
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LAYOUT_STORAGE_KEY_PREFIX)) continue
      const isLegacyEnvelope = key === LEGACY_LAYOUT_STORAGE_KEY
      if (!isLegacyEnvelope && !isDerivedLayoutKey(key)) continue
      if (key === ownKey) continue
      const persistedAt = staleEnvelopePersistedAt(localStorage.getItem(key), now)
      if (persistedAt === null) continue
      if (isLegacyEnvelope) {
        removeLayoutEnvelopeAndChannels(key)
        continue
      }
      const layoutWindowId = key.slice(LAYOUT_STORAGE_KEY_PREFIX.length + 1)
      removeLayoutEnvelopeAndChannels(key, layoutWindowId)
      warnStructured('layout_stale_envelope_pruned', {
        key,
        persistedAt,
      })
    }
  } catch (error) {
    warnStructured('layout_stale_prune_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** The App boot gate's DEFERRED own-key prune (e3 post-cap finding 2):
 * the migration-boot sweep above spares this window's envelope so
 * classifyPersistedLayoutHealth can see a stale layout; once the gate's
 * keep-vs-rebuild decision completes, it calls this to retire the
 * beyond-threshold envelope (and its channels) with the shared aging
 * rule. A fresh or absent envelope is a no-op, and the gate never
 * reaches the call on a failed rebuild — the envelope survives as the
 * retry boot's stale-classification evidence. Re-exported through
 * layout-health (the gate's recovery boundary) so App's import graph
 * keeps a single recovery module. */
export function pruneOwnStaleLayoutEnvelope(): void {
  try {
    const key = getWindowLayoutKey()
    const persistedAt = staleEnvelopePersistedAt(localStorage.getItem(key), Date.now())
    if (persistedAt === null) return
    removeLayoutEnvelopeAndChannels(key, getLayoutWindowId())
    warnStructured('layout_stale_envelope_pruned', {
      key,
      persistedAt,
    })
  } catch (error) {
    warnStructured('layout_stale_prune_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function runStorageMigration(): void {
  try {
    pruneStaleLayoutEnvelopes()
    adoptLegacyLayoutIntoWindowKey()
    const currentVersion = readStorageVersion()
    if (currentVersion >= STORAGE_VERSION) {
      const migratedLayout = preservePersistedLayout()
      if (migratedLayout === 'failed') {
        warnStructured('fresh_agent_layout_migration_aborted', {
          key: getWindowLayoutKey(),
        })
      }
      if (migratedLayout === 'migrated') {
        log.info('Migrated localStorage fresh-agent layout state without changing storage version.')
      }
      return
    }

    const preservedAuthToken = localStorage.getItem(AUTH_STORAGE_KEY)
    const migratedLayout = preservePersistedLayout()
    if (migratedLayout === 'failed') {
      warnStructured('fresh_agent_layout_migration_aborted', {
        key: getWindowLayoutKey(),
      })
      return
    }
    clearFreshellKeysExcept(
      [
        AUTH_STORAGE_KEY,
        BROWSER_PREFERENCES_STORAGE_KEY,
        // The one-shot legacy-adoption marker must survive the wipe, or a
        // post-wipe fresh window would re-adopt the (also spared) legacy
        // envelope — un-bounding the migration (e3r1 finding 2).
        LEGACY_LAYOUT_ADOPTION_MARKER_STORAGE_KEY,
        ...LEGACY_BROWSER_PREFERENCE_KEYS,
      ],
      [
        // Every window's envelope, .bak, fresh-agent channels, and
        // pre-migration evidence sidecar — plus the never-deleted legacy
        // shapes of all of them (covered by the same prefixes).
        LAYOUT_STORAGE_KEY_PREFIX,
        LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX,
      ],
    )

    if (preservedAuthToken) {
      localStorage.setItem(AUTH_STORAGE_KEY, preservedAuthToken)
    } else {
      clearAuthCookie()
    }

    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION))
    log.info(
      `Migrated localStorage (version ${currentVersion} → ${STORAGE_VERSION}) ` +
      `${migratedLayout === 'migrated' ? 'while preserving restorable layout state.' : 'without preserved layout state.'}`
    )
  } catch (err) {
    log.warn('Storage migration failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module
