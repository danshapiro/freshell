import { z } from 'zod'

export const CodexInitializeCapabilitiesSchema = z.object({
  experimentalApi: z.boolean(),
  optOutNotificationMethods: z.array(z.string()).optional(),
})

export const CodexInitializeParamsSchema = z.object({
  clientInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  capabilities: CodexInitializeCapabilitiesSchema.nullable(),
})

export const CodexInitializeResultSchema = z.object({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
})

export const CodexThreadSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).nullable().optional(),
  ephemeral: z.boolean().optional(),
}).passthrough()

export const CodexThreadStartParamsSchema = z.object({
  cwd: z.string().optional(),
  model: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  approvalPolicy: z.string().optional(),
  experimentalRawEvents: z.boolean(),
  persistExtendedHistory: z.boolean(),
})

export const CodexThreadResumeParamsSchema = z.object({
  threadId: z.string().min(1),
  cwd: z.string().optional(),
  model: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  approvalPolicy: z.string().optional(),
  persistExtendedHistory: z.boolean(),
})

export const CodexThreadOperationResultSchema = z.object({
  thread: CodexThreadSchema,
})

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

export const CodexRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string().min(1),
}).passthrough()

export const CodexRpcSuccessEnvelopeSchema = z.object({
  id: z.number().int(),
  result: z.unknown(),
}).passthrough()

export const CodexRpcErrorEnvelopeSchema = z.object({
  id: z.number().int().optional(),
  error: CodexRpcErrorSchema,
}).passthrough()

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

export const CodexFsChangedNotificationSchema = z.object({
  method: z.literal('fs/changed'),
  params: z.object({
    watchId: z.string().min(1),
    changedPaths: z.array(z.string()),
  }),
}).passthrough()

export type CodexInitializeCapabilities = z.infer<typeof CodexInitializeCapabilitiesSchema>
export type CodexInitializeParams = z.infer<typeof CodexInitializeParamsSchema>
export type CodexInitializeResult = z.infer<typeof CodexInitializeResultSchema>
export type CodexThreadHandle = z.infer<typeof CodexThreadSchema>
export type CodexThreadStartParams = z.infer<typeof CodexThreadStartParamsSchema>
export type CodexThreadResumeParams = z.infer<typeof CodexThreadResumeParamsSchema>
export type CodexThreadOperationResult = z.infer<typeof CodexThreadOperationResultSchema>
export type CodexFsWatchParams = z.infer<typeof CodexFsWatchParamsSchema>
export type CodexFsWatchResult = z.infer<typeof CodexFsWatchResultSchema>
export type CodexFsUnwatchParams = z.infer<typeof CodexFsUnwatchParamsSchema>
export type CodexRpcError = z.infer<typeof CodexRpcErrorSchema>
export type CodexThreadStartedNotification = z.infer<typeof CodexThreadStartedNotificationSchema>
export type CodexFsChangedNotification = z.infer<typeof CodexFsChangedNotificationSchema>
