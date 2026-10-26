import { z } from 'zod'

export const FreshAgentSessionTypeSchema = z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode'])
export const FreshAgentRuntimeProviderSchema = z.enum(['claude', 'codex', 'opencode'])

export const FreshAgentThreadLocatorSchema = z.object({
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  threadId: z.string().min(1),
}).strict()

export const FreshAgentRequestIdSchema = z.union([z.string().min(1), z.number().int()])

export const FreshAgentSettingScopeSchema = z.enum(['per-send', 'create-only', 'unsupported'])
export type FreshAgentSettingScope = z.infer<typeof FreshAgentSettingScopeSchema>
export const FreshAgentSettingScopesSchema = z.object({
  model: FreshAgentSettingScopeSchema.optional(),
  effort: FreshAgentSettingScopeSchema.optional(),
  sandbox: FreshAgentSettingScopeSchema.optional(),
  permissionMode: FreshAgentSettingScopeSchema.optional(),
}).strict()
export type FreshAgentSettingScopes = z.infer<typeof FreshAgentSettingScopesSchema>

export const FreshAgentCapabilitiesSchema = z.object({
  send: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  fork: z.boolean(),
  worktrees: z.boolean().optional(),
  diffs: z.boolean().optional(),
  childThreads: z.boolean().optional(),
  // kata 1wxv: conversation rollback capability stamps. Absent on legacy
  // (TS) servers — the client treats absent as false.
  undo: z.boolean().optional(),
  redo: z.boolean().optional(),
  // kata z7j7: per-knob application scope advertisement ('per-send' = mid-session
  // honored; 'create-only' = applied only at session create; 'unsupported' = the
  // provider has no concept for the knob).
  settingScopes: FreshAgentSettingScopesSchema.optional(),
}).strict()

export const FreshAgentTokenUsageSchema = z.object({
  observed: z.boolean().optional(),
  modelContextWindow: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().optional(),
  compactPercent: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
}).strict()

export const FreshAgentSettingsSchema = z.object({
  model: z.string().min(1).optional(),
  permissionMode: z.string().min(1).optional(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  plugins: z.array(z.string()).optional(),
}).strict()

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]))

export const FreshAgentTranscriptItemSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('text'),
    text: z.string(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('thinking'),
    text: z.string(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('reasoning'),
    summary: z.array(z.string()),
    content: z.array(z.string()),
    text: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    title: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('tool_use'),
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: JsonValueSchema.optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('tool_result'),
    toolUseId: z.string().min(1),
    content: JsonValueSchema,
    isError: z.boolean(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'declined']),
    output: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('file_change'),
    output: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'declined']),
    changes: z.array(z.record(z.string(), z.unknown())),
    extensions: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('mcp_tool'),
    progress: z.string().optional(),
    server: z.string(),
    tool: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    arguments: JsonValueSchema,
    result: JsonValueSchema.optional(),
    error: JsonValueSchema.optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('dynamic_tool'),
    namespace: z.string().nullable().optional(),
    tool: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    arguments: JsonValueSchema,
    contentItems: z.array(z.unknown()).nullable().optional(),
    success: z.boolean().nullable().optional(),
    // Persisted opencode tool failure text (`part.state.error`), CLI-visible
    // in the TUI's failed tool blocks. Optional: absent on every non-error
    // state and on other providers.
    error: z.string().min(1).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('task_delegation'),
    status: z.enum(['running', 'completed', 'failed', 'interrupted']),
    provider: FreshAgentRuntimeProviderSchema.optional(),
    nativeStatus: z.string().nullable().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    title: z.string(),
    description: z.string().optional(),
    subagent: z.string().optional(),
    background: z.boolean().optional(),
    childSessionId: z.string().optional(),
    startedAtMs: z.number().optional(),
    endedAtMs: z.number().optional(),
    durationMs: z.number().nonnegative().optional(),
    activity: z.array(z.object({
      tool: z.string(),
      status: z.enum(['running', 'completed', 'failed']),
      preview: z.string(),
    }).strict()).optional(),
    result: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('retry'),
    attempt: z.number().int().positive(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('delegated_task'),
    agent: z.string().optional(),
    description: z.string().optional(),
    command: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('collab_agent'),
    tool: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    senderThreadId: z.string().min(1),
    receiverThreadIds: z.array(z.string().min(1)),
    prompt: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
    agentsStates: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('web_search'),
    query: z.string(),
    action: z.unknown().nullable().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('image_view'),
    path: z.string(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('image_generation'),
    status: z.string(),
    revisedPrompt: z.string().nullable().optional(),
    result: z.string(),
    savedPath: z.string().optional(),
    displayStatus: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('review_mode'),
    event: z.enum(['entered', 'exited']),
    review: z.string(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('context_compaction'),
  }).strict(),
])

export const FreshAgentTurnSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  /** Provider-native identity for an observed user row when it differs from
   *  the display key or must be matched to a server-accepted submission. */
  nativeTurnId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative().optional(),
  source: z.enum(['durable', 'live', 'server']).optional(),
  outputState: z.object({
    provenance: z.enum(['saved', 'retained', 'saved-and-retained', 'preview']),
    diagnostic: z.enum(['interrupted', 'unsaved', 'provider-truncated']).optional(),
    refreshPending: z.boolean(),
    retainedItems: z.array(FreshAgentTranscriptItemSchema).optional(),
    savedItems: z.array(FreshAgentTranscriptItemSchema).optional(),
  }).strict().optional(),
  role: z.enum(['user', 'assistant', 'system', 'tool']).optional(),
  timestamp: z.string().optional(),
  model: z.string().optional(),
  // The durable error module of a turn. OpenCode persists provider/abort
  // errors on the assistant message (`info.error`, `{name, data}`); the
  // snapshot projects them onto the owning turn, mirroring the CLI's
  // `errorMessage` helper (a string `data.message` verbatim, else the whole
  // persisted error object as pretty-printed JSON). Claude projects its
  // persisted API-error lines (`ApiError`) and local-command stderr
  // (`CommandError`, e.g. a failed /compact) as item-less turns carrying only
  // this error. Optional: codex and older servers omit it.
  error: z.object({
    // OpenCode error class, e.g. 'UnknownError' / 'MessageAbortedError'.
    name: z.string().min(1),
    // Non-empty display text; the server always stamps prose.
    message: z.string().min(1),
  }).strict().optional(),
  summary: z.string(),
  // Provenance of `summary`: 'echo' = mechanical projection of the turn's own
  // items (foldable caption); 'authored' = provider-written prose (permanent
  // boundary). Optional: a server that predates the field omits it and the
  // client treats unknown provenance as authored (conservative).
  summaryKind: z.enum(['echo', 'authored']).optional(),
  items: z.array(FreshAgentTranscriptItemSchema),
  // kata 1wxv: stamped on turns surfaced in the snapshot's rolledBackTurns
  // marker bucket (decision 6 — marked in durable history, gone live).
  rolledBack: z.boolean().optional(),
  // Rolled-back section lifecycle: server-stamped per rolledBackTurns marker
  // row — true only while the step is still restorable (current rollback
  // chain, redo available); always false for out-of-band fallback markers.
  // Absent (an older-server payload) ⇒ not restorable ⇒ collapsed history
  // presentation. Never stamped on live turns[].
  restorable: z.boolean().optional(),
}).strict()

const EventRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const TranscriptPatchBase = { revision: EventRevisionSchema, nativeTurnId: z.string().min(1) }
export const FreshAgentTranscriptPatchSchema = z.object({
  type: z.literal('freshAgent.transcript.patch').optional(),
  sessionId: z.string().min(1),
  projectionId: z.string().min(1),
  historyGeneration: EventRevisionSchema,
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ ...TranscriptPatchBase, op: z.literal('resetTurn'), turns: z.array(FreshAgentTurnSchema), completedItemIds: z.array(z.string()).optional(), nonAppendableItemIds: z.array(z.string()).optional() }).strict(),
    z.object({ ...TranscriptPatchBase, op: z.literal('upsertItem'), row: FreshAgentTurnSchema, item: FreshAgentTranscriptItemSchema, complete: z.boolean().optional() }).strict(),
    z.object({ ...TranscriptPatchBase, op: z.literal('appendItem'), rowId: z.string().min(1), itemId: z.string().min(1), field: z.enum(['text', 'output', 'summary', 'content']), index: z.number().int().nonnegative().max(1023).nullable().optional(), text: z.string() }).strict(),
    z.object({ ...TranscriptPatchBase, op: z.literal('settleTurn'), status: z.string().optional() }).strict(),
  ])),
}).strict()

export type FreshAgentTranscriptPatch = z.infer<typeof FreshAgentTranscriptPatchSchema>

// Claude's permission update (the SDK's `PermissionUpdate`): what the CLI
// suggests on an approval, and what "Allow and don't ask again" sends back as
// `updatedPermissions`. Mirrors the server's normalizer
// (crates/freshell-freshagent/src/claude_permission_update.rs), which drops
// anything outside this shape before it reaches a snapshot.
const FreshAgentPermissionUpdateDestinationSchema = z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'])
const FreshAgentPermissionRulesSchema = z.array(z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
}).strict()).min(1)
const FreshAgentPermissionRulesUpdateSchema = (type: 'addRules' | 'replaceRules' | 'removeRules') => z.object({
  type: z.literal(type),
  rules: FreshAgentPermissionRulesSchema,
  behavior: z.enum(['allow', 'deny', 'ask']),
  destination: FreshAgentPermissionUpdateDestinationSchema,
}).strict()
const FreshAgentPermissionDirectoriesUpdateSchema = (type: 'addDirectories' | 'removeDirectories') => z.object({
  type: z.literal(type),
  directories: z.array(z.string()).min(1),
  destination: FreshAgentPermissionUpdateDestinationSchema,
}).strict()
export const FreshAgentPermissionUpdateSchema = z.discriminatedUnion('type', [
  FreshAgentPermissionRulesUpdateSchema('addRules'),
  FreshAgentPermissionRulesUpdateSchema('replaceRules'),
  FreshAgentPermissionRulesUpdateSchema('removeRules'),
  z.object({
    type: z.literal('setMode'),
    mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']),
    destination: FreshAgentPermissionUpdateDestinationSchema,
  }).strict(),
  FreshAgentPermissionDirectoriesUpdateSchema('addDirectories'),
  FreshAgentPermissionDirectoriesUpdateSchema('removeDirectories'),
])

export const FreshAgentPendingApprovalSchema = z.object({
  requestId: FreshAgentRequestIdSchema,
  toolName: z.string().optional(),
  toolUseID: z.string().optional(),
  blockedPath: z.string().optional(),
  decisionReason: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  native: z.record(z.string(), z.unknown()).optional(),
  // Claude only: the CLI's own suggestions for not asking again.
  suggestions: z.array(FreshAgentPermissionUpdateSchema).optional(),
  providerRequest: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const FreshAgentQuestionDefinitionSchema = z.object({
  id: z.string().optional(),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string(),
  }).strict()).optional(),
  multiSelect: z.boolean().optional(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
}).strict()

export const FreshAgentPendingQuestionSchema = z.object({
  requestId: FreshAgentRequestIdSchema,
  isBlocking: z.boolean().optional(),
  questions: z.array(FreshAgentQuestionDefinitionSchema),
  providerRequest: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const FreshAgentElicitationFieldSchema = z.object({
  id: z.string().min(1), title: z.string(), description: z.string().optional(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
  required: z.boolean(), secret: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  choices: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
  minimum: z.number().optional(), maximum: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  format: z.string().optional(),
}).strict()
export const FreshAgentPendingElicitationSchema = z.object({
  requestId: FreshAgentRequestIdSchema,
  mode: z.enum(['form', 'openai/form', 'openaiForm', 'url']),
  serverName: z.string(), message: z.string(), title: z.string().optional(),
  fields: z.array(FreshAgentElicitationFieldSchema).max(32).optional(),
  url: z.string().optional(), elicitationId: z.string().optional(),
  providerRequest: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type FreshAgentPendingElicitation = z.infer<typeof FreshAgentPendingElicitationSchema>
export type FreshAgentElicitationContent = Record<string, string | number | boolean | string[]>

export const FreshAgentWorktreeSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().optional(),
}).strict()

export const FreshAgentDiffSummarySchema = z.object({
  id: z.string().min(1),
  path: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  diff: z.string().optional(),
}).strict()

export const FreshAgentChildThreadSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  origin: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  model: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  receiverThreadIds: z.array(z.string().min(1)).optional(),
}).strict()

export const FreshAgentExtensionsSchema = z.object({
  claude: z.record(z.string(), z.unknown()).optional(),
  codex: z.record(z.string(), z.unknown()).optional(),
  opencode: z.record(z.string(), z.unknown()).optional(),
}).strict()

/**
 * A provider-advertised session command (the SDK SlashCommand shape with
 * argumentHint made optional so providers without hints can advertise rows).
 * Description may be '' for providers that do not supply one.
 */
export const FreshAgentSessionCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string().optional(),
  aliases: z.array(z.string()).optional(),
}).strict()

export const FreshAgentSnapshotSchema = FreshAgentThreadLocatorSchema.extend({
  sessionId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  latestTurnId: z.string().nullable().optional(),
  status: z.string().min(1),
  summary: z.string().optional(),
  capabilities: FreshAgentCapabilitiesSchema,
  settings: FreshAgentSettingsSchema.optional(),
  tokenUsage: FreshAgentTokenUsageSchema,
  pendingApprovals: z.array(FreshAgentPendingApprovalSchema).default([]),
  pendingQuestions: z.array(FreshAgentPendingQuestionSchema).default([]),
  pendingElicitations: z.array(FreshAgentPendingElicitationSchema).optional(),
  worktrees: z.array(FreshAgentWorktreeSchema).default([]),
  diffs: z.array(FreshAgentDiffSummarySchema).default([]),
  childThreads: z.array(FreshAgentChildThreadSchema).default([]),
  turns: z.array(FreshAgentTurnSchema).default([]),
  // kata 1wxv: the rolled-back marker bucket (each turn stamped
  // `rolledBack:true`) + redo availability. `turns[]` is always exactly what
  // the model sees next; the marker bucket is separate.
  rolledBackTurns: z.array(FreshAgentTurnSchema).optional(),
  rollback: z.object({
    canRedo: z.boolean(),
    undoneDepth: z.number().int().nonnegative(),
    // Delta-r1 F6: the SERVER-AUTHORED per-marker "Redo to here" gate — the exact
    // turn ids at the ends of the redoable steps of the CURRENT epoch (the tail of
    // the marker bucket; frozen prior-epoch markers are never listed). Optional:
    // legacy servers emit neither this nor the block — absent ⇒ no marker offers
    // the affordance.
    redoableTurnIds: z.array(z.string()).optional(),
  }).strict().optional(),
  extensions: FreshAgentExtensionsSchema.default({}),
  // Provider-advertised session commands. Optional on purpose: absence means
  // the provider has nothing to advertise (freshcodex, Rust port, offline),
  // and old servers/clients keep parsing unchanged (graceful absence).
  commands: z.array(FreshAgentSessionCommandSchema).readonly().optional(),
}).strict()

export const FreshAgentChildReadSchema = z.object({
  parentSessionId: z.string().min(1),
  childThreadId: z.string().min(1),
  observedEpoch: z.number().int().nonnegative().optional(),
  observedGeneration: z.number().int().nonnegative().optional(),
}).strict()

const ChildIdentity = { parentThreadId: z.string().min(1), childThreadId: z.string().min(1) }
export const FreshAgentChildObservationSchema = z.discriminatedUnion('status', [
  z.object({ ...ChildIdentity, status: z.literal('live'), snapshot: FreshAgentSnapshotSchema }).strict(),
  z.object({ ...ChildIdentity, status: z.literal('saved'), snapshot: FreshAgentSnapshotSchema }).strict(),
  z.object({ ...ChildIdentity, status: z.literal('pending'), reason: z.literal('history_unmaterialized'), retryable: z.literal(true) }).strict(),
  z.object({ ...ChildIdentity, status: z.literal('unavailable'), reason: z.enum(['ephemeral_history_unavailable', 'history_unavailable', 'source_unavailable']), retryable: z.boolean() }).strict(),
]).superRefine((value, context) => {
  if ('snapshot' in value && (value.snapshot.threadId !== value.childThreadId || value.snapshot.provider !== 'codex' || value.snapshot.sessionType !== 'freshcodex')) {
    context.addIssue({ code: 'custom', message: 'Child snapshot identity mismatch', path: ['snapshot'] })
  }
})
export type FreshAgentChildRead = z.infer<typeof FreshAgentChildReadSchema>
export type FreshAgentChildObservation = z.infer<typeof FreshAgentChildObservationSchema>

export const FreshAgentTurnPageSchema = FreshAgentThreadLocatorSchema.extend({
  revision: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  backwardsCursor: z.string().nullable().optional(),
  turns: z.array(FreshAgentTurnSchema),
  bodies: z.record(z.string(), FreshAgentTurnSchema).optional(),
}).strict()

export const FreshAgentTurnBodySchema = FreshAgentTurnSchema.extend({
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  threadId: z.string().min(1),
  revision: z.number().int().nonnegative(),
}).strict()

export const FreshAgentActionResultSchema = FreshAgentThreadLocatorSchema.extend({
  action: z.enum([
    'send',
    'interrupt',
    'fork',
    'review',
    'question.respond',
    'approval.respond',
  ]),
  revision: z.number().int().nonnegative().optional(),
  result: z.record(z.string(), z.unknown()).default({}),
}).strict()

export const FreshAgentContractErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  sessionType: FreshAgentSessionTypeSchema.optional(),
  provider: FreshAgentRuntimeProviderSchema.optional(),
  threadId: z.string().min(1).optional(),
  details: z.unknown().optional(),
}).strict()

export const FRESH_AGENT_CONTRACT_SCHEMA_NAMES = [
  'FreshAgentThreadLocatorSchema',
  'FreshAgentRequestIdSchema',
  'FreshAgentCapabilitiesSchema',
  'FreshAgentTokenUsageSchema',
  'FreshAgentSettingsSchema',
  'FreshAgentTranscriptItemSchema',
  'FreshAgentTurnSchema',
  'FreshAgentTranscriptPatchSchema',
  'FreshAgentPendingApprovalSchema',
  'FreshAgentPendingQuestionSchema',
  'FreshAgentElicitationFieldSchema',
  'FreshAgentPendingElicitationSchema',
  'FreshAgentWorktreeSchema',
  'FreshAgentDiffSummarySchema',
  'FreshAgentChildThreadSchema',
  'FreshAgentExtensionsSchema',
  'FreshAgentSessionCommandSchema',
  'FreshAgentSnapshotSchema',
  'FreshAgentTurnPageSchema',
  'FreshAgentTurnBodySchema',
  'FreshAgentActionResultSchema',
  'FreshAgentContractErrorSchema',
] as const

export type FreshAgentThreadLocator = z.infer<typeof FreshAgentThreadLocatorSchema>
export type FreshAgentRequestId = z.infer<typeof FreshAgentRequestIdSchema>
export type FreshAgentTranscriptItem = z.infer<typeof FreshAgentTranscriptItemSchema>
export type FreshAgentTurn = z.infer<typeof FreshAgentTurnSchema>
export type FreshAgentPendingApproval = z.infer<typeof FreshAgentPendingApprovalSchema>
export type FreshAgentPermissionUpdate = z.infer<typeof FreshAgentPermissionUpdateSchema>
export type FreshAgentPendingQuestion = z.infer<typeof FreshAgentPendingQuestionSchema>
export type FreshAgentSessionCommand = z.infer<typeof FreshAgentSessionCommandSchema>
export type FreshAgentSnapshot = z.infer<typeof FreshAgentSnapshotSchema>
export type FreshAgentTurnPage = z.infer<typeof FreshAgentTurnPageSchema>
export type FreshAgentTurnBody = z.infer<typeof FreshAgentTurnBodySchema>
