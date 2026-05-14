import { z } from 'zod'

export const CODEX_DURABILITY_SCHEMA_VERSION = 1 as const

export const CodexDurabilityStateNameSchema = z.enum([
  'identity_pending',
  'captured_pre_turn',
  'turn_in_progress_unproven',
  'proof_checking',
  'durable',
  'durable_resuming',
  'durability_unproven_after_completion',
  'non_restorable',
])

export type CodexDurabilityStateName = z.infer<typeof CodexDurabilityStateNameSchema>

export const CodexCandidateSourceSchema = z.enum([
  'thread_start_response',
  'thread_started_notification',
  'restored_client_state',
  'durable_resume',
])

export type CodexCandidateSource = z.infer<typeof CodexCandidateSourceSchema>

export const CodexRolloutProofFailureReasonSchema = z.enum([
  'invalid_path',
  'missing',
  'not_regular_file',
  'empty',
  'malformed_json',
  'wrong_record_type',
  'missing_payload_id',
  'mismatched_thread_id',
  'read_error',
])

export type CodexRolloutProofFailureReason = z.infer<typeof CodexRolloutProofFailureReasonSchema>

export const CodexCandidateIdentitySchema = z.object({
  provider: z.literal('codex'),
  candidateThreadId: z.string().min(1),
  rolloutPath: z.string().min(1),
  source: CodexCandidateSourceSchema,
  capturedAt: z.number().int().nonnegative(),
  cliVersion: z.string().min(1).optional(),
}).strict()

export type CodexCandidateIdentity = z.infer<typeof CodexCandidateIdentitySchema>

export const CodexProofFailureSchema = z.object({
  reason: CodexRolloutProofFailureReasonSchema,
  message: z.string().min(1),
  checkedAt: z.number().int().nonnegative(),
}).strict()

export type CodexProofFailure = z.infer<typeof CodexProofFailureSchema>

export const CodexDurabilityRefSchema = z.object({
  schemaVersion: z.literal(CODEX_DURABILITY_SCHEMA_VERSION),
  state: CodexDurabilityStateNameSchema,
  candidate: CodexCandidateIdentitySchema.optional(),
  turnCompletedAt: z.number().int().nonnegative().optional(),
  lastProofFailure: CodexProofFailureSchema.optional(),
  durableThreadId: z.string().min(1).optional(),
  nonRestorableReason: z.string().min(1).optional(),
}).strict()

export type CodexDurabilityRef = z.infer<typeof CodexDurabilityRefSchema>

export const CodexDurabilityStoreRecordSchema = CodexDurabilityRefSchema.extend({
  terminalId: z.string().min(1),
  tabId: z.string().min(1).optional(),
  paneId: z.string().min(1).optional(),
  serverInstanceId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
}).strict()

export type CodexDurabilityStoreRecord = z.infer<typeof CodexDurabilityStoreRecordSchema>

export function sanitizeCodexDurabilityRef(value: unknown): CodexDurabilityRef | undefined {
  const parsed = CodexDurabilityRefSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
