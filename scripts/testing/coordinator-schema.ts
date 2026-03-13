import { z } from 'zod'

const summarySourceSchema = z.enum(['flag', 'env', 'fallback'])
const repoSchema = z.object({
  invocationCwd: z.string().optional(),
  checkoutRoot: z.string(),
  repoRoot: z.string(),
  commonDir: z.string(),
  worktreePath: z.string(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  isDirty: z.boolean().optional(),
})
const runtimeSchema = z.object({
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
})
const agentSchema = z.object({
  kind: z.string().optional(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
})
const entrypointSchema = z.object({
  commandKey: z.string(),
  suiteKey: z.string().optional(),
})
const commandSchema = z.object({
  display: z.string(),
  argv: z.array(z.string()),
})

export const holderRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  summary: z.string(),
  summarySource: summarySourceSchema,
  startedAt: z.string(),
  pid: z.number().int(),
  hostname: z.string().optional(),
  username: z.string().optional(),
  entrypoint: entrypointSchema,
  command: commandSchema,
  repo: repoSchema,
  runtime: runtimeSchema,
  agent: agentSchema,
})

export const latestRunRecordSchema = z.object({
  runId: z.string(),
  summary: z.string(),
  summarySource: summarySourceSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  outcome: z.enum(['success', 'failure']),
  exitCode: z.number().int(),
  entrypoint: entrypointSchema,
  command: commandSchema,
  repo: repoSchema,
  runtime: runtimeSchema,
  agent: agentSchema,
})

export const reusableSuccessRecordSchema = latestRunRecordSchema.extend({
  reusableKey: z.string(),
})

export const latestRunsFileSchema = z.object({
  schemaVersion: z.literal(1),
  byKey: z.record(z.string(), latestRunRecordSchema),
})

export const reusableSuccessFileSchema = z.object({
  schemaVersion: z.literal(1),
  byReusableKey: z.record(z.string(), reusableSuccessRecordSchema),
})

export type HolderRecord = z.infer<typeof holderRecordSchema>
export type LatestRunRecord = z.infer<typeof latestRunRecordSchema>
export type LatestRunsFile = z.infer<typeof latestRunsFileSchema>
export type ReusableSuccessRecord = z.infer<typeof reusableSuccessRecordSchema>
export type ReusableSuccessFile = z.infer<typeof reusableSuccessFileSchema>

export function emptyLatestRunsFile(): LatestRunsFile {
  return {
    schemaVersion: 1,
    byKey: {},
  }
}

export function emptyReusableSuccessFile(): ReusableSuccessFile {
  return {
    schemaVersion: 1,
    byReusableKey: {},
  }
}

export function buildReusableSuccessKey(input: {
  suiteKey: string
  commit?: string
  isDirty?: boolean
  nodeVersion: string
  platform: string
  arch: string
}): string {
  return `${input.suiteKey}|${input.commit ?? 'unknown'}|dirty:${input.isDirty ? 1 : 0}|node:${input.nodeVersion}|${input.platform}|${input.arch}`
}
