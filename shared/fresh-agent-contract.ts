import { z } from 'zod'

export const FreshAgentSessionTypeSchema = z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode'])
export const FreshAgentRuntimeProviderSchema = z.enum(['claude', 'codex', 'opencode'])

export const FreshAgentThreadLocatorSchema = z.object({
  sessionType: FreshAgentSessionTypeSchema,
  provider: FreshAgentRuntimeProviderSchema,
  threadId: z.string().min(1),
}).strict()

export const FreshAgentRequestIdSchema = z.union([z.string().min(1), z.number().int()])

export const FreshAgentCapabilitiesSchema = z.object({
  send: z.boolean(),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  fork: z.boolean(),
  worktrees: z.boolean().optional(),
  diffs: z.boolean().optional(),
  childThreads: z.boolean().optional(),
}).strict()

export const FreshAgentTokenUsageSchema = z.object({
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
    status: z.enum(['running', 'completed', 'failed', 'declined']),
    changes: z.array(z.record(z.string(), z.unknown())),
    extensions: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('mcp_tool'),
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
  messageId: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative().optional(),
  source: z.enum(['durable', 'live', 'server']).optional(),
  role: z.enum(['user', 'assistant', 'system', 'tool']).optional(),
  timestamp: z.string().optional(),
  model: z.string().optional(),
  summary: z.string(),
  items: z.array(FreshAgentTranscriptItemSchema),
}).strict()

export const FreshAgentPendingApprovalSchema = z.object({
  requestId: FreshAgentRequestIdSchema,
  toolName: z.string().optional(),
  toolUseID: z.string().optional(),
  blockedPath: z.string().optional(),
  decisionReason: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  providerRequest: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const FreshAgentQuestionDefinitionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string(),
  }).strict()).optional(),
  multiSelect: z.boolean().optional(),
}).strict()

export const FreshAgentPendingQuestionSchema = z.object({
  requestId: FreshAgentRequestIdSchema,
  questions: z.array(FreshAgentQuestionDefinitionSchema),
  providerRequest: z.record(z.string(), z.unknown()).optional(),
}).strict()

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
}).strict()

export const FreshAgentChildThreadSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  origin: z.string(),
  title: z.string().optional(),
  receiverThreadIds: z.array(z.string().min(1)).optional(),
}).strict()

export const FreshAgentExtensionsSchema = z.object({
  claude: z.record(z.string(), z.unknown()).optional(),
  codex: z.record(z.string(), z.unknown()).optional(),
  opencode: z.record(z.string(), z.unknown()).optional(),
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
  worktrees: z.array(FreshAgentWorktreeSchema).default([]),
  diffs: z.array(FreshAgentDiffSummarySchema).default([]),
  childThreads: z.array(FreshAgentChildThreadSchema).default([]),
  turns: z.array(FreshAgentTurnSchema).default([]),
  extensions: FreshAgentExtensionsSchema.default({}),
}).strict()

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
  'FreshAgentPendingApprovalSchema',
  'FreshAgentPendingQuestionSchema',
  'FreshAgentWorktreeSchema',
  'FreshAgentDiffSummarySchema',
  'FreshAgentChildThreadSchema',
  'FreshAgentExtensionsSchema',
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
export type FreshAgentPendingQuestion = z.infer<typeof FreshAgentPendingQuestionSchema>
export type FreshAgentSnapshot = z.infer<typeof FreshAgentSnapshotSchema>
export type FreshAgentTurnPage = z.infer<typeof FreshAgentTurnPageSchema>
export type FreshAgentTurnBody = z.infer<typeof FreshAgentTurnBodySchema>
