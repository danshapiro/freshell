import { z } from 'zod'

export const CodexRequestIdSchema = z.union([z.string(), z.number().int()])

export const CodexInitializeCapabilitiesSchema = z.object({
  experimentalApi: z.boolean().default(false),
  optOutNotificationMethods: z.array(z.string()).nullable().optional(),
}).strict()

export const CodexInitializeParamsSchema = z.object({
  clientInfo: z.object({
    name: z.string().min(1),
    title: z.string().nullable().optional(),
    version: z.string().min(1),
  }).strict(),
  capabilities: CodexInitializeCapabilitiesSchema.nullable().optional(),
}).strict()

export const CodexInitializeResultSchema = z.object({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
}).passthrough()

export const CodexReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
export const CodexSandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access'])
export const CodexNetworkAccessSchema = z.enum(['restricted', 'enabled'])
export const CodexApprovalsReviewerSchema = z.enum(['user', 'auto_review', 'guardian_subagent'])

const CodexGranularAskForApprovalSchema = z.object({
  sandbox_approval: z.boolean(),
  rules: z.boolean(),
  mcp_elicitations: z.boolean(),
  skill_approval: z.boolean().default(false),
  request_permissions: z.boolean().default(false),
}).strict()

export const CodexAskForApprovalSchema = z.union([
  z.enum(['untrusted', 'on-failure', 'on-request', 'never']),
  z.object({ granular: CodexGranularAskForApprovalSchema }).strict(),
])

export const CodexSandboxPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dangerFullAccess') }).strict(),
  z.object({
    type: z.literal('readOnly'),
    networkAccess: z.boolean().default(false),
  }).strict(),
  z.object({
    type: z.literal('externalSandbox'),
    networkAccess: CodexNetworkAccessSchema.default('restricted'),
  }).strict(),
  z.object({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(z.string()).default([]),
    networkAccess: z.boolean().default(false),
    excludeTmpdirEnvVar: z.boolean().default(false),
    excludeSlashTmp: z.boolean().default(false),
  }).strict(),
])

export const CodexSandboxResultSchema = z.union([
  CodexSandboxModeSchema,
  CodexSandboxPolicySchema,
])

export const CodexUserInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    text_elements: z.array(z.unknown()).default([]),
  }).passthrough(),
  z.object({
    type: z.literal('image'),
    url: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal('localImage'),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal('skill'),
    name: z.string(),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal('mention'),
    name: z.string(),
    path: z.string(),
  }).passthrough(),
])

export const CodexThreadStatusSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('notLoaded') }).strict(),
  z.object({ type: z.literal('idle') }).strict(),
  z.object({ type: z.literal('systemError') }).passthrough(),
  z.object({
    type: z.literal('active'),
    activeFlags: z.array(z.unknown()),
  }).passthrough(),
])

export const CodexTurnStatusSchema = z.enum(['completed', 'interrupted', 'failed', 'inProgress'])
export const CodexThreadItemsViewSchema = z.enum(['notLoaded', 'summary', 'full'])

export const CodexSessionSourceSchema = z.union([
  z.enum(['cli', 'vscode', 'exec', 'appServer', 'unknown']),
  z.object({ custom: z.string() }).strict(),
  z.object({ subAgent: z.unknown() }).strict(),
])

export const CodexThreadItemTypeSchema = z.enum([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
])

export const CodexThreadItemSchema = z.object({
  type: CodexThreadItemTypeSchema,
  id: z.string().min(1),
}).passthrough()

export const CodexTurnSchema = z.object({
  id: z.string().min(1),
  items: z.array(CodexThreadItemSchema),
  itemsView: CodexThreadItemsViewSchema.optional(),
  status: CodexTurnStatusSchema,
  error: z.unknown().nullable().optional().default(null),
  startedAt: z.number().nullable().optional().default(null),
  completedAt: z.number().nullable().optional().default(null),
  durationMs: z.number().nullable().optional().default(null),
}).passthrough()

export const CodexThreadSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  preview: z.string().optional().default(''),
  ephemeral: z.boolean().optional().default(false),
  modelProvider: z.string().optional().default('unknown'),
  createdAt: z.number().optional().default(0),
  updatedAt: z.number().optional().default(0),
  status: CodexThreadStatusSchema.optional().default({ type: 'idle' }),
  cwd: z.string().optional().default(''),
  cliVersion: z.string().optional().default(''),
  source: CodexSessionSourceSchema.optional().default('unknown'),
  turns: z.array(CodexTurnSchema).optional().default([]),
  forkedFromId: z.string().nullable().optional().default(null),
  path: z.string().nullable().optional().default(null),
  agentNickname: z.string().nullable().optional().default(null),
  agentRole: z.string().nullable().optional().default(null),
  gitInfo: z.unknown().nullable().optional().default(null),
  name: z.string().nullable().optional().default(null),
}).passthrough()

export const CodexThreadStartParamsSchema = z.object({
  cwd: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  serviceName: z.string().nullable().optional(),
  sandbox: CodexSandboxModeSchema.nullable().optional(),
  approvalPolicy: CodexAskForApprovalSchema.nullable().optional(),
  approvalsReviewer: CodexApprovalsReviewerSchema.nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  baseInstructions: z.string().nullable().optional(),
  developerInstructions: z.string().nullable().optional(),
  personality: z.unknown().nullable().optional(),
  ephemeral: z.boolean().nullable().optional(),
  threadSource: z.unknown().nullable().optional(),
  sessionStartSource: z.enum(['startup', 'clear']).nullable().optional(),
  experimentalRawEvents: z.boolean().optional().default(false),
  persistExtendedHistory: z.boolean().optional().default(false),
}).strict()

export const CodexThreadResumeParamsSchema = z.object({
  threadId: z.string().min(1),
  cwd: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  sandbox: CodexSandboxModeSchema.nullable().optional(),
  approvalPolicy: CodexAskForApprovalSchema.nullable().optional(),
  approvalsReviewer: CodexApprovalsReviewerSchema.nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  baseInstructions: z.string().nullable().optional(),
  developerInstructions: z.string().nullable().optional(),
  personality: z.unknown().nullable().optional(),
  persistExtendedHistory: z.boolean().optional().default(false),
  excludeTurns: z.boolean().nullable().optional(),
}).strict()

export const CodexThreadForkParamsSchema = z.object({
  threadId: z.string().min(1),
  cwd: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  sandbox: CodexSandboxModeSchema.nullable().optional(),
  approvalPolicy: CodexAskForApprovalSchema.nullable().optional(),
  approvalsReviewer: CodexApprovalsReviewerSchema.nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  baseInstructions: z.string().nullable().optional(),
  developerInstructions: z.string().nullable().optional(),
  personality: z.unknown().nullable().optional(),
  ephemeral: z.boolean().nullable().optional(),
  excludeTurns: z.boolean().nullable().optional(),
}).strict()

export const CodexThreadOperationResultSchema = z.object({
  thread: CodexThreadSchema,
  approvalPolicy: CodexAskForApprovalSchema,
  approvalsReviewer: CodexApprovalsReviewerSchema,
  cwd: z.string(),
  model: z.string(),
  modelProvider: z.string(),
  sandbox: CodexSandboxResultSchema,
  serviceTier: z.string().nullable().optional().default(null),
  instructionSources: z.array(z.unknown()).optional().default([]),
  reasoningEffort: CodexReasoningEffortSchema.nullable().optional().default(null),
}).passthrough()

export const CodexFsWatchParamsSchema = z.object({
  path: z.string().min(1),
  watchId: z.string().min(1),
})

export const CodexFsWatchResultSchema = z.object({
  path: z.string().min(1),
})

export const CodexFsUnwatchParamsSchema = z.object({
  watchId: z.string().min(1),
})

export const CodexLoadedThreadListResultSchema = z.object({
  data: z.array(z.string().min(1)),
})

export const CodexThreadReadParamsSchema = z.object({
  threadId: z.string().min(1),
  includeTurns: z.boolean().optional().default(false),
}).strict()

export const CodexThreadReadResultSchema = z.object({
  thread: CodexThreadSchema,
}).passthrough()

export const CodexThreadPageParamsSchema = z.object({
  threadId: z.string().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  itemsView: CodexThreadItemsViewSchema.optional(),
}).strict()

export const CodexThreadTurnsListResultSchema = z.preprocess((value) => {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'data' in value
    && !('turns' in value)
  ) {
    return {
      ...value,
      turns: (value as { data: unknown }).data,
    }
  }
  return value
}, z.object({
  revision: z.number().int().nonnegative().optional(),
  nextCursor: z.string().nullable().optional().default(null),
  backwardsCursor: z.string().nullable().optional().default(null),
  turns: z.array(CodexTurnSchema),
  bodies: z.record(z.string(), CodexTurnSchema).optional(),
}).passthrough())

export const CodexThreadTurnReadParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  revision: z.number().int().nonnegative().optional(),
}).strict()

export const CodexThreadTurnReadResultSchema = CodexTurnSchema.extend({
  turnId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative().optional(),
}).passthrough()

export const CodexTurnStartParamsSchema = z.object({
  threadId: z.string().min(1),
  input: z.array(CodexUserInputSchema),
  cwd: z.string().nullable().optional(),
  approvalPolicy: CodexAskForApprovalSchema.nullable().optional(),
  approvalsReviewer: CodexApprovalsReviewerSchema.nullable().optional(),
  sandboxPolicy: CodexSandboxPolicySchema.nullable().optional(),
  model: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  effort: CodexReasoningEffortSchema.nullable().optional(),
  summary: z.string().nullable().optional(),
  personality: z.unknown().nullable().optional(),
  outputSchema: z.unknown().nullable().optional(),
}).strict()

export const CodexTurnStartResultSchema = z.object({
  turn: CodexTurnSchema,
}).passthrough()

export const CodexTurnInterruptParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
}).strict()

export const CodexTurnInterruptResultSchema = z.object({}).strict()

export const CodexRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().min(1),
  data: z.unknown().optional(),
}).passthrough()

export const CodexRpcSuccessEnvelopeSchema = z.object({
  id: CodexRequestIdSchema,
  result: z.unknown(),
}).strict()

export const CodexRpcErrorEnvelopeSchema = z.object({
  id: CodexRequestIdSchema.optional(),
  error: CodexRpcErrorSchema,
}).strict()

export const CodexRpcNotificationEnvelopeSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
}).passthrough()

export const CodexThreadStartedNotificationSchema = z.object({
  method: z.literal('thread/started'),
  params: z.object({
    thread: CodexThreadSchema,
  }).passthrough(),
}).passthrough()

export const CodexThreadStartedLifecycleNotificationSchema = CodexThreadStartedNotificationSchema

export const CodexThreadClosedNotificationSchema = z.object({
  method: z.literal('thread/closed'),
  params: z.object({
    threadId: z.string().min(1),
  }).passthrough(),
}).passthrough()

export const CodexThreadStatusChangedNotificationSchema = z.object({
  method: z.literal('thread/status/changed'),
  params: z.object({
    threadId: z.string().min(1),
    status: z.object({
      type: z.string().min(1),
    }).passthrough(),
  }).passthrough(),
}).passthrough()

export const CodexThreadLifecycleNotificationSchema = z.union([
  CodexThreadStartedLifecycleNotificationSchema,
  CodexThreadClosedNotificationSchema,
  CodexThreadStatusChangedNotificationSchema,
])

export const CodexFsChangedNotificationSchema = z.object({
  method: z.literal('fs/changed'),
  params: z.object({
    watchId: z.string().min(1),
    changedPaths: z.array(z.string()),
  }),
}).passthrough()

export const CodexTurnStartedNotificationSchema = z.object({
  method: z.literal('turn/started'),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  }).passthrough(),
}).passthrough()

export const CodexTurnCompletedNotificationSchema = z.object({
  method: z.literal('turn/completed'),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    // The real app-server reports the authoritative outcome inline as the completed
    // turn object (status 'completed' | 'interrupted' | 'failed'). turn/completed
    // fires for interrupts too, so consumers must read turn.status to chime only on
    // a positive completion rather than treating the bare notification as success.
    turn: z.object({
      id: z.string().min(1).optional(),
      status: CodexTurnStatusSchema.optional(),
    }).passthrough().optional(),
    // Some app-server forms report the outcome flat at params.status instead of inline
    // under turn; consumers read params.turn?.status ?? params.status.
    status: CodexTurnStatusSchema.optional(),
  }).passthrough(),
}).passthrough()

export type CodexRequestId = z.infer<typeof CodexRequestIdSchema>
export type CodexInitializeCapabilities = z.infer<typeof CodexInitializeCapabilitiesSchema>
export type CodexInitializeParams = z.infer<typeof CodexInitializeParamsSchema>
export type CodexInitializeResult = z.infer<typeof CodexInitializeResultSchema>
export type CodexThreadHandle = z.input<typeof CodexThreadSchema>
export type CodexThreadStartParams = z.input<typeof CodexThreadStartParamsSchema>
export type CodexThreadResumeParams = z.input<typeof CodexThreadResumeParamsSchema>
export type CodexThreadForkParams = z.input<typeof CodexThreadForkParamsSchema>
export type CodexThreadOperationResult = z.infer<typeof CodexThreadOperationResultSchema>
export type CodexFsWatchParams = z.infer<typeof CodexFsWatchParamsSchema>
export type CodexFsWatchResult = z.infer<typeof CodexFsWatchResultSchema>
export type CodexFsUnwatchParams = z.infer<typeof CodexFsUnwatchParamsSchema>
export type CodexLoadedThreadListResult = z.infer<typeof CodexLoadedThreadListResultSchema>
export type CodexThreadReadParams = z.input<typeof CodexThreadReadParamsSchema>
export type CodexThreadReadResult = z.infer<typeof CodexThreadReadResultSchema>
export type CodexThreadPageParams = z.input<typeof CodexThreadPageParamsSchema>
export type CodexThreadTurnsListParams = CodexThreadPageParams
export type CodexThreadTurnsListResult = z.infer<typeof CodexThreadTurnsListResultSchema>
export type CodexThreadTurnReadParams = z.infer<typeof CodexThreadTurnReadParamsSchema>
export type CodexThreadTurnReadResult = z.infer<typeof CodexThreadTurnReadResultSchema>
export type CodexTurnStartParams = z.input<typeof CodexTurnStartParamsSchema>
export type CodexTurnStartResult = z.infer<typeof CodexTurnStartResultSchema>
export type CodexTurnInterruptParams = z.input<typeof CodexTurnInterruptParamsSchema>
export type CodexTurnInterruptResult = z.infer<typeof CodexTurnInterruptResultSchema>
export type CodexRpcError = z.infer<typeof CodexRpcErrorSchema>
export type CodexThreadStartedNotification = z.infer<typeof CodexThreadStartedNotificationSchema>
export type CodexThreadClosedNotification = z.infer<typeof CodexThreadClosedNotificationSchema>
export type CodexThreadStatusChangedNotification = z.infer<typeof CodexThreadStatusChangedNotificationSchema>
export type CodexThreadLifecycleNotification = z.infer<typeof CodexThreadLifecycleNotificationSchema>
export type CodexFsChangedNotification = z.infer<typeof CodexFsChangedNotificationSchema>
export type CodexTurnStartedNotification = z.infer<typeof CodexTurnStartedNotificationSchema>
export type CodexTurnCompletedNotification = z.infer<typeof CodexTurnCompletedNotificationSchema>
