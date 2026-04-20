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
})

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

export type CodexInitializeCapabilities = z.infer<typeof CodexInitializeCapabilitiesSchema>
export type CodexInitializeParams = z.infer<typeof CodexInitializeParamsSchema>
export type CodexInitializeResult = z.infer<typeof CodexInitializeResultSchema>
export type CodexThreadStartParams = z.infer<typeof CodexThreadStartParamsSchema>
export type CodexThreadResumeParams = z.infer<typeof CodexThreadResumeParamsSchema>
export type CodexThreadOperationResult = z.infer<typeof CodexThreadOperationResultSchema>
export type CodexRpcError = z.infer<typeof CodexRpcErrorSchema>
export type CodexThreadStartedNotification = z.infer<typeof CodexThreadStartedNotificationSchema>
