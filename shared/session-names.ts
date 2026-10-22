/**
 * Canonical coding-agent session names — shared wire contract
 * (unified-agent-names plan, Task 1).
 *
 * One saved name per scoped Claude/Codex/OpenCode session (terminal modes
 * `claude`/`codex`/`opencode` and fresh types `freshclaude`/`freshcodex`/
 * `freshopencode`). The Rust server's `SessionNames` store is the authority;
 * these Zod schemas are the language-neutral wire shapes mirrored by
 * `crates/freshell-protocol/src/session_names.rs`.
 *
 * Wire rules:
 * - `NameRevision`-typed counters are JS-safe integers (`0 ..= 2^53-1`).
 * - `SessionNameRef` keys encode as a JSON discriminated TUPLE
 *   (`sessionNameRefKey`) — never colon-split opaque provider session IDs.
 * - Kilroy is out of scope: it shares the Claude runtime but keeps its
 *   existing naming behavior.
 */
import { z } from 'zod'

export const NamedProviderSchema = z.enum(['claude', 'codex', 'opencode'])
export type NamedProvider = z.infer<typeof NamedProviderSchema>

/** The six scoped coding-agent modes: three terminal CLIs + three fresh types. */
export const UnifiedAgentModeSchema = z.enum([
  'claude',
  'codex',
  'opencode',
  'freshclaude',
  'freshcodex',
  'freshopencode',
])
export type UnifiedAgentMode = z.infer<typeof UnifiedAgentModeSchema>

/** Who asked for a name: a human (`user`) or automation (`automatic`). */
export const NameIntentSchema = z.enum(['user', 'automatic'])
export type NameIntent = z.infer<typeof NameIntentSchema>

/**
 * Provenance of an accepted name. `legacy_protected` is assigned ONLY by the
 * Task 7 migration: its historic origin is unknown (never claimed as human).
 */
export const NameSourceSchema = z.enum([
  'manual',
  'legacy_protected',
  'freshell_ai',
  'provider_ai',
  'first_message',
  'directory',
])
export type NameSource = z.infer<typeof NameSourceSchema>

export const LEGACY_ORIGIN_UNKNOWN = 'unknown' as const

/** Monotonically allocated, JS-safe revision counter (0 ..= 2^53-1). */
export const NameRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export type NameRevision = z.infer<typeof NameRevisionSchema>

/** Hard accepted-name cap in Unicode scalar values — mirrors the Rust store. */
export const MAX_NAME_SCALARS = 200

/** Unicode control characters (category Cc) — exactly Rust's `char::is_control`. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Accepted-name text, mirroring the Rust store's `validate_name` exactly so a
 * client-side-valid name can never fail server-side validation: non-empty
 * after trimming, at most 200 Unicode scalar values, and no control
 * characters anywhere (display safety — deliberately stricter than the
 * plan's control-ONLY rejection, kept on both sides of the wire).
 */
export const SessionNameTextSchema = z.string().superRefine((name, ctx) => {
  if (name.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a session name cannot be empty or whitespace-only',
      path: [],
    })
    return
  }
  if ([...name].length > MAX_NAME_SCALARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `a session name cannot exceed ${MAX_NAME_SCALARS} characters`,
      path: [],
    })
    return
  }
  if (CONTROL_CHARACTERS.test(name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a session name cannot contain control characters',
      path: [],
    })
  }
})

/**
 * Naming target: a pre-durable pending handle (minted per logical
 * conversation before provider identity exists) or the durable
 * provider/session identity. The session variant reuses the existing
 * structured provider/session identity — no new restore identity.
 */
export const SessionNameRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), id: z.string().min(1) }),
  z.object({ kind: z.literal('session'), provider: NamedProviderSchema, sessionId: z.string().min(1) }),
])
export type SessionNameRef = z.infer<typeof SessionNameRefSchema>

/**
 * Which session names a tab: `{kind:'session',paneId}` follows that pane's
 * canonical session name; `{kind:'legacy'}` keeps the existing non-agent
 * derivation. A tab stores the relationship, never a second name.
 */
export const TabNameSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), paneId: z.string().min(1) }),
  z.object({ kind: z.literal('legacy') }),
])
export type TabNameSource = z.infer<typeof TabNameSourceSchema>

/**
 * One accepted name record. `manualRevision`/`renamedAt` are assigned only by
 * an actual explicit user rename; `legacyOrigin` is required (and only
 * legal) for `legacy_protected`.
 */
export const SessionNameRecordSchema = z
  .object({
    ref: SessionNameRefSchema,
    name: SessionNameTextSchema,
    source: NameSourceSchema,
    revision: NameRevisionSchema,
    manualRevision: NameRevisionSchema.optional(),
    renamedAt: z.number().int().nonnegative().optional(),
    legacyOrigin: z.literal(LEGACY_ORIGIN_UNKNOWN).optional(),
  })
  .superRefine((record, ctx) => {
    // Only migration assigns legacy_protected, and it must never claim human
    // origin: legacyOrigin is required there and illegal everywhere else.
    if (record.source === 'legacy_protected' && record.legacyOrigin !== LEGACY_ORIGIN_UNKNOWN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'legacyOrigin is required for legacy_protected records',
        path: ['legacyOrigin'],
      })
    }
    if (record.source !== 'legacy_protected' && record.legacyOrigin !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'legacyOrigin is only legal on legacy_protected records',
        path: ['legacyOrigin'],
      })
    }
  })
export type SessionNameRecord = z.infer<typeof SessionNameRecordSchema>

/** Pending→durable redirect, so late operations on a bound handle resolve. */
export const SessionNameRedirectSchema = z.object({
  from: SessionNameRefSchema,
  to: SessionNameRefSchema,
  revision: NameRevisionSchema,
})
export type SessionNameRedirect = z.infer<typeof SessionNameRedirectSchema>

/** Native writeback status (Task 3): display/status data, never a name authority. */
export const NativeSyncStatusSchema = z.enum(['pending', 'synced', 'unsynced', 'unsupported'])
export type NativeSyncStatus = z.infer<typeof NativeSyncStatusSchema>

/**
 * The native writeback status projected alongside a record (Task 3).
 * `synced` requires a current-revision readback of the exact desired name at
 * the attempted location; `unsynced` retains the uncertainty/exhaustion
 * reason; `unsupported` is a diagnosed capability failure. Status-only
 * updates fold on the client by `documentGeneration`, not name revision.
 */
export const NativeSyncSchema = z.object({
  status: NativeSyncStatusSchema,
  desiredRevision: NameRevisionSchema,
  locationRevision: NameRevisionSchema,
  observedCurrent: z.boolean().optional(),
  reason: z.string().optional(),
})
export type NativeSync = z.infer<typeof NativeSyncSchema>

/**
 * Why a rename did not change the saved name (name-reliability Task 4):
 * an automation rename never replaces a protected name (`protected_name`)
 * and never saves a default or derived label (`default_label`);
 * `unchanged` means the saved name already is the requested text.
 */
export const RenameOutcomeReasonSchema = z.enum(['protected_name', 'default_label', 'unchanged'])
export type RenameOutcomeReason = z.infer<typeof RenameOutcomeReasonSchema>

/** Whether a rename applied. Rename RESPONSES carry it; broadcasts never do. */
export const RenameOutcomeSchema = z.object({
  applied: z.boolean(),
  reason: RenameOutcomeReasonSchema.optional(),
})
export type RenameOutcome = z.infer<typeof RenameOutcomeSchema>

/** The common response/broadcast shape for every naming operation. A
 * malformed or newer-server `outcome` is dropped, never a reason to reject
 * the update it rides on. */
export const SessionNameUpdateSchema = z.object({
  record: SessionNameRecordSchema,
  documentGeneration: NameRevisionSchema,
  redirects: z.array(SessionNameRedirectSchema),
  changed: z.boolean(),
  nativeSync: NativeSyncSchema.optional(),
  outcome: RenameOutcomeSchema.optional().catch(undefined),
})
export type SessionNameUpdate = z.infer<typeof SessionNameUpdateSchema>

/** Rename request (HTTP PATCH body / MCP-bridged rename). */
export const RenameSessionNameRequestSchema = z.object({
  target: SessionNameRefSchema,
  name: SessionNameTextSchema,
  nameIntent: NameIntentSchema.optional(),
  ifRevision: NameRevisionSchema.optional(),
})
export type RenameSessionNameRequest = z.infer<typeof RenameSessionNameRequestSchema>

const TERMINAL_UNIFIED_MODES = new Set(['claude', 'codex', 'opencode'])
const FRESH_UNIFIED_SESSION_TYPES = new Set(['freshclaude', 'freshcodex', 'freshopencode'])

/**
 * Scope predicate: is this pane content one of the six unified naming modes?
 * Terminal scope is `mode in {claude,codex,opencode}`; fresh scope is
 * `sessionType in {freshclaude,freshcodex,freshopencode}` (fresh types also
 * match when passed as the mode, since fresh panes identify by session type).
 * Kilroy is explicitly out of scope even though it shares the Claude
 * runtime — a kilroy sessionType is never scoped, regardless of mode.
 */
export function isUnifiedAgentMode(mode: string | undefined, sessionType?: string): boolean {
  // Kilroy shares the Claude runtime but keeps its existing naming behavior:
  // a kilroy sessionType is never scoped, regardless of the mode it rides on.
  if (sessionType === 'kilroy') return false
  // Fresh panes identify by sessionType (fresh types also match when a caller
  // passes one as the mode).
  if (sessionType !== undefined && FRESH_UNIFIED_SESSION_TYPES.has(sessionType)) return true
  return mode !== undefined && (TERMINAL_UNIFIED_MODES.has(mode) || FRESH_UNIFIED_SESSION_TYPES.has(mode))
}

/**
 * Stable key for a naming ref: the JSON encoding of a discriminated TUPLE
 * (["pending",id] / ["session",provider,sessionId]) — never colon-splitting
 * opaque provider session IDs.
 */
export function sessionNameRefKey(ref: SessionNameRef): string {
  return ref.kind === 'pending'
    ? JSON.stringify(['pending', ref.id])
    : JSON.stringify(['session', ref.provider, ref.sessionId])
}

// ---------------------------------------------------------------------------
// Task 7 — legacy-name migration envelope
// ---------------------------------------------------------------------------

/**
 * Where a legacy candidate's label lived. Scope breaks total-order ties:
 * session > pane > source_tab > terminal > derived.
 */
export const LegacyCandidateScopeSchema = z.enum([
  'session',
  'pane',
  'source_tab',
  'terminal',
  'derived',
])
export type LegacyCandidateScope = z.infer<typeof LegacyCandidateScopeSchema>

/**
 * What protection the raw evidence claims for a legacy candidate.
 * `explicit_rename` is reliable explicit-rename evidence (honored only from
 * server-side boot evidence — the old durable session-rename ladder);
 * `legacy_flag` is an old manual/protected flag whose human origin is
 * unrecoverable (pane/tab user-set booleans, unsourced title overrides);
 * `none` is an unprotected label with a known automatic origin.
 */
export const LegacyProtectionEvidenceSchema = z.enum(['explicit_rename', 'legacy_flag', 'none'])
export type LegacyProtectionEvidence = z.infer<typeof LegacyProtectionEvidenceSchema>

/**
 * A migration candidate's target: the canonical naming ref, or a legacy
 * identity the server resolves through the existing canonical
 * identity/ledger — never a new key.
 */
export const LegacyNameTargetSchema = z.union([
  SessionNameRefSchema,
  z.object({
    kind: z.literal('legacy_session'),
    sessionRef: z.object({ provider: z.string().min(1), sessionId: z.string().min(1) }).strict(),
    codexDurability: z
      .object({
        schemaVersion: z.literal(1),
        state: z.string().min(1),
        durableThreadId: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    kind: z.literal('legacy_terminal'),
    terminalId: z.string().min(1),
    serverInstanceId: z.string().min(1),
  }),
])
export type LegacyNameTarget = z.infer<typeof LegacyNameTargetSchema>

/**
 * One legacy-name candidate. The stable candidate `id` is the JSON tuple
 * `[storageKey,deviceId,tabId,paneId,scope,provider,sessionId,name,source,
 * protectionEvidence,explicitRenameAt]` with absent entries null;
 * `explicitRenameAt` must carry evidence (never receipt/import time) and is
 * absent when no trustworthy explicit-rename time exists.
 */
export const LegacyNameCandidateSchema = z.object({
  id: z.string().min(1),
  target: LegacyNameTargetSchema,
  name: z.string(),
  source: NameSourceSchema,
  scope: LegacyCandidateScopeSchema,
  explicitRenameAt: z.number().int().nonnegative().optional(),
  evidenceKey: z.string(),
  protectionEvidence: LegacyProtectionEvidenceSchema,
})
export type LegacyNameCandidate = z.infer<typeof LegacyNameCandidateSchema>

/**
 * One immutable raw evidence envelope: the bytes of one legacy storage
 * payload, preserved verbatim before any sanitization could clear it.
 */
export const LegacyEvidenceEnvelopeSchema = z.object({
  storageKey: z.string().min(1),
  raw: z.string(),
})
export type LegacyEvidenceEnvelope = z.infer<typeof LegacyEvidenceEnvelopeSchema>

/**
 * The Task 7 import envelope (fixed at version 1). `importId` is the
 * persisted retry-stable id of one captured raw envelope; the server derives
 * its immutable per-import backup filename from it. At most 100 candidates
 * per import.
 */
export const LegacyNameImportSchema = z.object({
  version: z.literal(1),
  importId: z.string().min(1),
  evidence: z.array(LegacyEvidenceEnvelopeSchema),
  candidates: z.array(LegacyNameCandidateSchema),
})
export type LegacyNameImport = z.infer<typeof LegacyNameImportSchema>

/**
 * The import result: every acknowledged candidate id (per-candidate
 * acknowledgment, never an early whole-import shortcut) plus the updates for
 * the records the import touched.
 */
export const LegacyImportResultSchema = z.object({
  acknowledged: z.array(z.string()),
  names: z.array(SessionNameUpdateSchema),
})
export type LegacyImportResult = z.infer<typeof LegacyImportResultSchema>

/**
 * The stable legacy-candidate id: the JSON tuple
 * `[storageKey,deviceId,tabId,paneId,scope,provider,sessionId,name,source,
 * protectionEvidence,explicitRenameAt]` with absent entries null. Never
 * receipt/import time; every entry that exists must come from evidence.
 */
export function legacyNameCandidateId(input: {
  storageKey: string
  deviceId?: string
  tabId?: string
  paneId?: string
  scope: LegacyCandidateScope
  provider?: string
  sessionId?: string
  name: string
  source: NameSource
  protectionEvidence: LegacyProtectionEvidence
  explicitRenameAt?: number
}): string {
  return JSON.stringify([
    input.storageKey,
    input.deviceId ?? null,
    input.tabId ?? null,
    input.paneId ?? null,
    input.scope,
    input.provider ?? null,
    input.sessionId ?? null,
    input.name,
    input.source,
    input.protectionEvidence,
    input.explicitRenameAt ?? null,
  ])
}
