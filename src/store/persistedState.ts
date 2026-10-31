import { z } from 'zod'
import { TABS_STORAGE_KEY, PANES_STORAGE_KEY } from './storage-keys'
import {
  getWindowFreshAgentBackupKey,
  getWindowFreshAgentCommitMarkerKey,
  getWindowFreshAgentPendingMarkerKey,
  getWindowLayoutKey,
} from './window-layout-keys'
import {
  buildRestoreError,
  migrateLegacyTerminalDurableState,
  type RestoreError,
  sanitizeSessionRef,
} from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { migrateLegacyFreshAgentContent, migrateLegacyFreshAgentDurableState } from '@shared/fresh-agent'
import { TabNameSourceSchema } from '@shared/session-names'
import { parsePaneNamingIdentityInput } from '@/lib/tab-name-source'
import {
  stripScopedPaneTitleMetadata,
  stripSessionOwnedTabFreezeFlags,
} from '@/lib/session-name-migration'
import {
  freshAgentCheckpointConversationKeyForContent,
  normalizeFreshAgentCheckpointWorkspace,
  normalizeFreshAgentCheckpointOutcomes,
  normalizeFreshAgentPaneModelSelection,
} from './paneTypes'
import { createLogger } from '@/lib/client-logger'
import { isValidMachineIdStamp } from '@/lib/machine-identity'
import { isDurableProviderSessionId } from '@shared/session-flavor'

export { TABS_STORAGE_KEY, PANES_STORAGE_KEY }

const log = createLogger('PersistedState')

export const TABS_SCHEMA_VERSION = 2
export const PANES_SCHEMA_VERSION = 7
// The fresh-agent centralization migration's payload-field constants: the
// marker payloads carry these as the `backupKey`/migration identifiers
// (parseLayoutFreshAgentCommitMarker validates against them), while the
// marker/backup STORAGE keys are per-window channel suffixes — see
// window-layout-keys.ts (delta round 3, finding 1).
export const LAYOUT_FRESH_AGENT_BACKUP_KEY = 'freshell.layout.v3.backup-before-fresh-agent-centralization'
export const LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY = 'freshell.layout.v3.fresh-agent-centralization-commit'
export const LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY = 'freshell.layout.v3.fresh-agent-centralization-pending'
export const LAYOUT_FRESH_AGENT_MIGRATION_ID = 'fresh-agent-centralization'

// Compatibility-only fields: foreign/extension-authored tabs (e.g. from the MCP `tab.create`
// command) may write arbitrary values here. An invalid value (wrong type, empty string) is
// sanitized to `undefined` rather than rejecting the tab - these fields are best-effort
// compat data, not tab identity.
const zSanitizedOptionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.length > 0 ? value : undefined),
  z.string().optional(),
)

const zTabMode = zSanitizedOptionalString
const zCodingCliProvider = zSanitizedOptionalString
const zCheckpointWorkspace = z.preprocess(
  (value) => normalizeFreshAgentCheckpointWorkspace(value),
  z.object({
    path: z.string().min(1),
    provenance: z.enum(['directory-picker', 'resolved-project', 'legacy-checkpoint']),
  }).optional(),
)

const zTab = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number().optional(),
  titleSetByUser: z.boolean().optional(),
  // Compatibility-only fields (may exist in persisted tabs before pane layout is created).
  mode: zTabMode,
  codingCliProvider: zCodingCliProvider,
  resumeSessionId: z.string().optional(),
  checkpointWorkspace: zCheckpointWorkspace,
}).passthrough()

// The tabs array is validated per-element (see `salvageTabs`) rather than atomically via
// `z.array(zTab)`. A single structurally-invalid tab (e.g. missing `id`) must not invalidate
// every other valid tab in the same persisted payload.
const zPersistedTabsState = z.object({
  activeTabId: z.string().nullable().optional(),
  tabs: z.array(z.unknown()),
}).passthrough()

const zTombstone = z.object({
  id: z.string(),
  deletedAt: z.number(),
})

const zPersistedTabsPayload = z.object({
  version: z.number().optional(),
  tabs: zPersistedTabsState,
  tombstones: z.array(zTombstone).optional(),
}).passthrough()

type PersistedTab = z.infer<typeof zTab>

export type ParsedPersistedTabsState = {
  activeTabId: string | null
  tabs: PersistedTab[]
} & Record<string, unknown>

export type ParsedPersistedTabs = {
  version: number
  tabs: ParsedPersistedTabsState
  tombstones: Array<{ id: string; deletedAt: number }>
}

/**
 * Validate persisted tabs one at a time instead of atomically via `z.array(zTab)`.
 *
 * A single structurally-invalid tab (e.g. missing `id`) must not invalidate every other
 * valid tab in the same persisted payload - that would silently wipe a user's entire tab
 * strip because of one corrupt entry. Invalid tabs are dropped and logged; valid tabs are
 * normalized and kept.
 */
function salvageTabs(rawTabs: unknown[]): PersistedTab[] {
  const salvaged: PersistedTab[] = []
  for (const rawTab of rawTabs) {
    const res = zTab.safeParse(rawTab)
    if (!res.success) {
      const record = rawTab && typeof rawTab === 'object' ? (rawTab as Record<string, unknown>) : {}
      const id = typeof record.id === 'string' ? record.id : '<unknown>'
      const title = typeof record.title === 'string' ? record.title : '<unknown>'
      log.error(`Dropping corrupt persisted tab (id=${id}, title=${title}): ${res.error.message}`)
      continue
    }
    salvaged.push(normalizePersistedTab(res.data as unknown as Record<string, unknown>))
  }
  return salvaged
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

function normalizePersistedTab(tab: Record<string, unknown>): PersistedTab {
  const mode = typeof tab.mode === 'string' ? tab.mode : undefined
  const codingCliProvider = typeof tab.codingCliProvider === 'string' ? tab.codingCliProvider : undefined
  const legacyCodingCliSessionId = typeof tab.codingCliSessionId === 'string' && tab.codingCliSessionId.length > 0
    ? tab.codingCliSessionId
    : undefined
  const legacyClaudeSessionId = typeof tab.claudeSessionId === 'string' && tab.claudeSessionId.length > 0
    ? tab.claudeSessionId
    : undefined
  const provider = codingCliProvider || (mode && mode !== 'shell' ? mode : undefined)
  const legacySessionId = legacyCodingCliSessionId || legacyClaudeSessionId
  const durableState = migrateLegacyTerminalDurableState({
    provider,
    sessionRef: tab.sessionRef,
    resumeSessionId: typeof tab.resumeSessionId === 'string'
      ? tab.resumeSessionId
      : legacySessionId,
  })
  const codexDurability = sanitizeCodexDurabilityRef(tab.codexDurability)
  const {
    resumeSessionId: _resumeSessionId,
    sessionRef: _legacySessionRef,
    codingCliSessionId: _codingCliSessionId,
    claudeSessionId: _claudeSessionId,
    nameSource: _unvalidatedNameSource,
    ...rest
  } = tab

  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
    // Unified agent names (Task 6): a valid tab nameSource survives the
    // persisted parse; a malformed one drops (never a corrupt relationship).
    ...(TabNameSourceSchema.safeParse(tab.nameSource).success
      ? { nameSource: tab.nameSource }
      : {}),
  } as PersistedTab
}

export function parsePersistedTabsRaw(raw: string): ParsedPersistedTabs | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const res = zPersistedTabsPayload.safeParse(parsed)
  if (!res.success) return null

  const version = typeof res.data.version === 'number' ? res.data.version : 0
  if (version > TABS_SCHEMA_VERSION) return null

  return sanitizeParsedTabsHalf({
    version,
    tabs: {
      ...res.data.tabs,
      activeTabId: res.data.tabs.activeTabId ?? null,
      tabs: salvageTabs(res.data.tabs.tabs),
    },
    tombstones: res.data.tombstones || [],
  })
}

/**
 * Unified agent names (Task 7): the persisted-parse gate for the ONE client
 * sanitizer — a scoped agent pane's local title/user-flag and a
 * session-owned tab's freeze flag are retired legacy aliases (the canonical
 * server record owns those names); identity, source pointers and canonical
 * title projections survive. Applied at every parse exit so every hydrate
 * path (slice initial loads, crossTabSync, boot loaders, recovery) consumes
 * sanitized metadata. The tabs half needs only each tab's own nameSource
 * (a session-owned tab is one whose pointer exists).
 */
function sanitizeParsedTabsHalf(parsed: ParsedPersistedTabs): ParsedPersistedTabs {
  return {
    ...parsed,
    tabs: {
      ...parsed.tabs,
      tabs: stripSessionOwnedTabFreezeFlags(parsed.tabs.tabs),
    },
  }
}

function sanitizeParsedPanesHalf(parsed: {
  version: number
  layouts: Record<string, unknown>
  activePane: Record<string, string>
  paneTitles: Record<string, Record<string, string>>
  paneTitleSetByUser: Record<string, Record<string, boolean>>
}): ParsedPersistedPanes {
  const { paneTitles, paneTitleSetByUser } = stripScopedPaneTitleMetadata(
    parsed.layouts,
    parsed.paneTitles,
    parsed.paneTitleSetByUser,
  )
  return { ...parsed, paneTitles, paneTitleSetByUser }
}

const zPaneTitles = z.record(z.string(), z.record(z.string(), z.string()))
const zPaneTitleSetByUser = z.record(z.string(), z.record(z.string(), z.boolean()))

const zPersistedPanesPayload = z.object({
  version: z.number().optional(),
  // Layout nodes can be partially corrupted; migrations and runtime code should tolerate malformed nodes.
  // We validate only that layouts is a plain object and leave deeper repairs to higher-level logic.
  layouts: z.record(z.string(), z.unknown()).optional(),
  activePane: z.record(z.string(), z.string()).optional(),
  paneTitles: zPaneTitles.optional(),
  paneTitleSetByUser: zPaneTitleSetByUser.optional(),
}).passthrough()

export type ParsedPersistedPanes = {
  version: number
  layouts: Record<string, unknown>
  activePane: Record<string, string>
  paneTitles: Record<string, Record<string, string>>
  paneTitleSetByUser: Record<string, Record<string, boolean>>
}

/**
 * Unified agent names (Task 6): validate a persisted pane content's naming
 * identity — the SHARED parse point (`parsePaneNamingIdentityInput`) keeps
 * only a schema-valid `nameRef` and a non-empty `namingHandle`; malformed
 * values drop so a corrupt persisted/hydrated identity never enters pane
 * content (the transient runtime id strip elsewhere never touches these
 * fields).
 */
function sanitizePaneNamingIdentity(content: Record<string, unknown>): Record<string, unknown> {
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return content
  const { nameRef: _nameRef, namingHandle: _namingHandle, ...rest } = content
  return {
    ...rest,
    ...parsePaneNamingIdentityInput(content),
  }
}

function normalizeTerminalContent(content: Record<string, unknown>): Record<string, unknown> {
  const durableState = migrateLegacyTerminalDurableState({
    provider: typeof content.mode === 'string' && content.mode !== 'shell' ? content.mode : undefined,
    sessionRef: content.sessionRef,
    resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
  })
  const existingRestoreError = readRestoreError(content.restoreError)
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
  const codexDurability = sanitizeCodexDurabilityRef(content.codexDurability)
  const isLegacyRecoveryFailed = (
    rest.kind === 'terminal'
    && rest.mode === 'codex'
    && rest.status === 'recovery_failed'
  )
  const normalizedRuntime = normalizeLegacyRecoveryFailedTerminal(rest, durableState)
  const normalizedRestoreError = isLegacyRecoveryFailed
    ? undefined
    : durableState.restoreError ?? existingRestoreError
  const normalizedSessionRef = isLegacyRecoveryFailed && !isCodexSessionRef(durableState.sessionRef)
    ? undefined
    : durableState.sessionRef

  return {
    ...normalizedRuntime,
    ...(normalizedSessionRef ? { sessionRef: normalizedSessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
    ...(normalizedRestoreError
      ? { restoreError: normalizedRestoreError }
      : {}),
  }
}

function normalizeFreshAgentContent(content: Record<string, unknown>): Record<string, unknown> {
  if ('collaborationMode' in content && content.collaborationMode !== 'default' && content.collaborationMode !== 'plan') {
    const { collaborationMode: _invalidMode, ...rest } = content
    content = rest
  }
  if ('effortIsNativeDefault' in content && typeof content.effortIsNativeDefault !== 'boolean') {
    const { effortIsNativeDefault: _invalidEffortIntent, ...rest } = content
    content = rest
  }

  // Only the native child selection is durable. Bodies and ownership fences
  // are read again through the parent's current provider after reload.
  if ('observedChildThreadId' in content && (content.provider !== 'codex' || typeof content.observedChildThreadId !== 'string' || !content.observedChildThreadId.trim())) {
    const { observedChildThreadId: _invalidChild, ...rest } = content
    content = rest
  }
  const checkpointOutcomes = normalizeFreshAgentCheckpointOutcomes(
    content.checkpointOutcomes,
    typeof content.createRequestId === 'string' ? content.createRequestId : undefined,
    freshAgentCheckpointConversationKeyForContent(content),
  )
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
      checkpointOutcomes: _legacyCheckpointOutcomes,
      // Vestigial per-pane display overrides (no writer since 2026-04):
      // dropped during rehydration, never constructed into pane content.
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
      ...rest,
      ...(retainedSessionRef ? { sessionRef: retainedSessionRef } : {}),
      ...(retainedSessionRef?.provider === 'claude' ? { sessionId: retainedSessionRef.sessionId } : {}),
      restoreError: existingRestoreError,
      ...(checkpointOutcomes ? { checkpointOutcomes } : {}),
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
    checkpointOutcomes: _legacyCheckpointOutcomes,
    // Vestigial per-pane display overrides (no writer since 2026-04):
    // dropped during rehydration, never constructed into pane content.
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
    ...restWithNormalizedModel,
    // Older Claude panes persisted a runtime placeholder alongside their
    // durable reference. New runtimes use that durable UUID from creation.
    ...(provider === 'claude' && durableState.sessionRef?.provider === 'claude'
      ? { sessionId: durableState.sessionRef.sessionId }
      : {}),
    ...(checkpointOutcomes ? { checkpointOutcomes } : {}),
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(('restoreError' in durableState && durableState.restoreError) || existingRestoreError
      ? { restoreError: ('restoreError' in durableState && durableState.restoreError) || existingRestoreError }
      : {}),
  }
}

function normalizePersistedNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node

  const candidate = node as Record<string, unknown>
  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = migrateLegacyFreshAgentContent(candidate.content as Record<string, unknown>) as Record<string, unknown>
    let nextContent = content
    if (content.kind === 'terminal') {
      nextContent = sanitizePaneNamingIdentity(normalizeTerminalContent(content))
    } else if (content.kind === 'fresh-agent') {
      nextContent = sanitizePaneNamingIdentity(normalizeFreshAgentContent(content))
    } else if ('sessionRef' in content) {
      const sanitizedSessionRef = sanitizeSessionRef(content.sessionRef)
      const { sessionRef: _legacySessionRef, ...rest } = content
      nextContent = {
        ...rest,
        ...(sanitizedSessionRef ? { sessionRef: sanitizedSessionRef } : {}),
      }
    }
    return {
      ...candidate,
      content: nextContent,
    }
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length === 2) {
    return {
      ...candidate,
      children: [
        normalizePersistedNode(candidate.children[0]),
        normalizePersistedNode(candidate.children[1]),
      ],
    }
  }

  return node
}

function normalizePersistedLayouts(layouts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(layouts).map(([tabId, node]) => [tabId, normalizePersistedNode(node)]),
  )
}

export function parsePersistedPanesRaw(raw: string): ParsedPersistedPanes | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const res = zPersistedPanesPayload.safeParse(parsed)
  if (!res.success) return null

  let version = typeof res.data.version === 'number' ? res.data.version : 1
  if (version < 1) version = 1
  if (version > PANES_SCHEMA_VERSION) return null

  return sanitizeParsedPanesHalf({
    version,
    layouts: normalizePersistedLayouts((res.data.layouts || {}) as Record<string, unknown>),
    activePane: (res.data.activePane || {}) as Record<string, string>,
    paneTitles: (res.data.paneTitles || {}) as Record<string, Record<string, string>>,
    paneTitleSetByUser: (res.data.paneTitleSetByUser || {}) as Record<string, Record<string, boolean>>,
  })
}

// --- Combined layout key (v4) ---

export const LAYOUT_SCHEMA_VERSION = 4

const zPersistedLayoutPayload = z.object({
  version: z.number(),
  tabs: zPersistedTabsState,
  panes: zPersistedPanesPayload,
  tombstones: z.array(zTombstone).optional(),
}).passthrough()

export type ParsedPersistedLayout = {
  version: number
  tabs: ParsedPersistedTabsState
  panes: ParsedPersistedPanes
  tombstones: Array<{ id: string; deletedAt: number }>
  persistedAt?: number
  machineId?: string
}

export type LayoutFreshAgentCommitMarker = {
  version: 1
  migration: typeof LAYOUT_FRESH_AGENT_MIGRATION_ID
  backupKey: typeof LAYOUT_FRESH_AGENT_BACKUP_KEY
  originalHash: string
  migratedHash: string
  committedAt: number
}

export type LayoutFreshAgentPendingMarker = {
  version: 1
  migration: typeof LAYOUT_FRESH_AGENT_MIGRATION_ID
  backupKey: typeof LAYOUT_FRESH_AGENT_BACKUP_KEY
  originalHash: string
  migratedHash: string
  startedAt: number
}

export function hashPersistedLayoutRaw(raw: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${raw.length}:${hash.toString(16).padStart(8, '0')}`
}

export function parseLayoutFreshAgentCommitMarker(raw: string | null): LayoutFreshAgentCommitMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutFreshAgentCommitMarker>
    if (
      parsed?.version !== 1
      || parsed.migration !== LAYOUT_FRESH_AGENT_MIGRATION_ID
      || parsed.backupKey !== LAYOUT_FRESH_AGENT_BACKUP_KEY
      || typeof parsed.originalHash !== 'string'
      || typeof parsed.migratedHash !== 'string'
      || typeof parsed.committedAt !== 'number'
    ) {
      return null
    }
    return parsed as LayoutFreshAgentCommitMarker
  } catch {
    return null
  }
}

export function parseLayoutFreshAgentPendingMarker(raw: string | null): LayoutFreshAgentPendingMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutFreshAgentPendingMarker>
    if (
      parsed?.version !== 1
      || parsed.migration !== LAYOUT_FRESH_AGENT_MIGRATION_ID
      || parsed.backupKey !== LAYOUT_FRESH_AGENT_BACKUP_KEY
      || typeof parsed.originalHash !== 'string'
      || typeof parsed.migratedHash !== 'string'
      || typeof parsed.startedAt !== 'number'
    ) {
      return null
    }
    return parsed as LayoutFreshAgentPendingMarker
  } catch {
    return null
  }
}

export function readRecoverablePersistedLayoutRaw(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  const raw = storage.getItem(getWindowLayoutKey())
  const backup = storage.getItem(getWindowFreshAgentBackupKey())
  const markerRaw = storage.getItem(getWindowFreshAgentCommitMarkerKey())
  const pendingMarkerRaw = storage.getItem(getWindowFreshAgentPendingMarkerKey())

  if (!raw) return backup
  if (!backup) return raw

  const currentHash = hashPersistedLayoutRaw(raw)
  const marker = parseLayoutFreshAgentCommitMarker(markerRaw)
  if (marker && marker.migratedHash === currentHash) {
    return raw
  }

  const pendingMarker = parseLayoutFreshAgentPendingMarker(pendingMarkerRaw)
  if (
    pendingMarker
    && pendingMarker.originalHash === hashPersistedLayoutRaw(backup)
    && pendingMarker.migratedHash === currentHash
  ) {
    return backup
  }

  // e5r1: the fallback exists for STRUCTURALLY destroyed primaries — the
  // class parseLayoutStructure refuses (JSON-level, wrong-shape, or
  // newer-schema-version failure). A present-but-malformed machineId or
  // persistedAt is NOT that class: the malformed PRIMARY must flow through
  // to the boot migration and health classifier as corrupt evidence.
  // Selecting the older backup here would make the migration rewrite the
  // layout key with the backup's tabs and mirror the backup — not the
  // malformed primary — as pre-migration evidence, so the classifier would
  // keep a healthy-looking layout and silently roll back newer tabs and
  // panes instead of rebuilding.
  return parseLayoutStructure(raw) ? raw : backup
}

/** The structural parse gate shared by the loader-grade parse and the
 * recoverable-read fallback (e5r1): JSON-level, envelope-shape (zod), and
 * schema-version checks ONLY. Present-but-malformed envelope METADATA
 * (a machineId that is not a non-empty string, or a persistedAt that is
 * not a number) is deliberately outside this gate — it is a corruption
 * class the boot classifier must see, not structural destruction. */
function parseLayoutStructure(raw: string): z.infer<typeof zPersistedLayoutPayload> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const res = zPersistedLayoutPayload.safeParse(parsed)
  if (!res.success) return null
  if (res.data.version > LAYOUT_SCHEMA_VERSION) return null
  return res.data
}

export function parsePersistedLayoutRaw(raw: string): ParsedPersistedLayout | null {
  const structural = parseLayoutStructure(raw)
  if (!structural) return null

  // Present-but-malformed top-level metadata is corruption, not a legacy
  // absence (delta r5 finding 1, empty values added e5r2): the schema
  // passes both keys through, and silently coercing a non-string machineId
  // (or, per machine-identity's nonEmptyString normalization, an empty or
  // whitespace-only one) or a non-number persistedAt to undefined let a
  // corrupt envelope parse as unstamped legacy — the boot classifier kept
  // it and the healthy path's stamp backfill relabeled it as the currently
  // selected machine. Only genuinely ABSENT keys keep the legacy meaning,
  // so refuse the parse instead of coercing.
  const rawMetadata = structural as { machineId?: unknown; persistedAt?: unknown }
  if (rawMetadata.machineId !== undefined && !isValidMachineIdStamp(rawMetadata.machineId)) return null
  if (rawMetadata.persistedAt !== undefined && typeof rawMetadata.persistedAt !== 'number') return null

  const panes = structural.panes
  let panesVersion = typeof panes.version === 'number' ? panes.version : 1
  if (panesVersion < 1) panesVersion = 1

  const sanitizedPanes = sanitizeParsedPanesHalf({
    version: Math.max(panesVersion, PANES_SCHEMA_VERSION),
    layouts: normalizePersistedLayouts((panes.layouts || {}) as Record<string, unknown>),
    activePane: (panes.activePane || {}) as Record<string, string>,
    paneTitles: (panes.paneTitles || {}) as Record<string, Record<string, string>>,
    paneTitleSetByUser: (panes.paneTitleSetByUser || {}) as Record<string, Record<string, boolean>>,
  })
  return {
    version: Math.max(structural.version, LAYOUT_SCHEMA_VERSION),
    tabs: {
      ...structural.tabs,
      activeTabId: structural.tabs.activeTabId ?? null,
      tabs: stripSessionOwnedTabFreezeFlags(salvageTabs(structural.tabs.tabs)),
    },
    panes: sanitizedPanes,
    tombstones: structural.tombstones || [],
    persistedAt: typeof (structural as any).persistedAt === 'number' ? (structural as any).persistedAt : undefined,
    machineId: typeof (structural as any).machineId === 'string' ? (structural as any).machineId : undefined,
  }
}

/**
 * Migrate from separate v2 tabs+panes keys to the combined v3 layout key.
 * Returns the parsed v3 layout, or null if no v2 data existed.
 */
export function migrateV2ToV3(): ParsedPersistedLayout | null {
  const tabsKey = TABS_STORAGE_KEY
  const panesKey = PANES_STORAGE_KEY
  const layoutKey = getWindowLayoutKey()

  const tabsRaw = localStorage.getItem(tabsKey)
  if (!tabsRaw) return null

  const tabsParsed = parsePersistedTabsRaw(tabsRaw)
  if (!tabsParsed) return null

  const panesRaw = localStorage.getItem(panesKey)
  const panesParsed = panesRaw ? parsePersistedPanesRaw(panesRaw) : null

  const emptyPanes: ParsedPersistedPanes = {
    version: PANES_SCHEMA_VERSION,
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  }

  const layout: ParsedPersistedLayout = {
    version: LAYOUT_SCHEMA_VERSION,
    tabs: tabsParsed.tabs,
    panes: panesParsed || emptyPanes,
    tombstones: tabsParsed.tombstones,
  }

  // Write v3 key and clean up v2 keys
  const v3Payload = {
    version: LAYOUT_SCHEMA_VERSION,
    tabs: layout.tabs,
    panes: {
      version: layout.panes.version,
      layouts: layout.panes.layouts,
      activePane: layout.panes.activePane,
      paneTitles: layout.panes.paneTitles,
      paneTitleSetByUser: layout.panes.paneTitleSetByUser,
    },
    tombstones: layout.tombstones,
  }
  localStorage.setItem(layoutKey, JSON.stringify(v3Payload))
  localStorage.removeItem(tabsKey)
  localStorage.removeItem(panesKey)

  return layout
}
