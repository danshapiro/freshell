import { z } from 'zod'
import { AUDIT_SCENARIOS } from './scenarios.js'

export const AUDIT_PROFILE_IDS = ['desktop_local', 'mobile_restricted'] as const
export const AUDIT_SCENARIO_IDS = [
  'auth-required-cold-boot',
  'terminal-cold-boot',
  'agent-chat-cold-boot',
  'sidebar-search-large-corpus',
  'terminal-reconnect-backlog',
  'offscreen-tab-selection',
] as const

const AUDIT_PROFILE_ORDER = new Map(AUDIT_PROFILE_IDS.map((id, index) => [id, index]))
const AUDIT_SCENARIO_ORDER = new Map(AUDIT_SCENARIO_IDS.map((id, index) => [id, index]))

function isStableSubsetOrder<T extends string>(values: readonly T[], order: Map<T, number>): boolean {
  let previousIndex = -1
  const seen = new Set<T>()

  for (const value of values) {
    const index = order.get(value)
    if (index === undefined || seen.has(value) || index <= previousIndex) {
      return false
    }
    seen.add(value)
    previousIndex = index
  }

  return true
}

const VisibleFirstProfileSchema = z.object({
  id: z.enum(AUDIT_PROFILE_IDS),
}).strict().passthrough()

const VisibleFirstSummaryMetricSchema = z.object({
  focusedReadyMs: z.number().nonnegative().optional(),
  wsReadyMs: z.number().nonnegative().optional(),
  terminalInputToFirstOutputMs: z.number().nonnegative().optional(),
  httpRequestsBeforeReady: z.number().nonnegative().optional(),
  httpBytesBeforeReady: z.number().nonnegative().optional(),
  wsFramesBeforeReady: z.number().nonnegative().optional(),
  wsBytesBeforeReady: z.number().nonnegative().optional(),
  offscreenHttpRequestsBeforeReady: z.number().nonnegative().optional(),
  offscreenHttpBytesBeforeReady: z.number().nonnegative().optional(),
  offscreenWsFramesBeforeReady: z.number().nonnegative().optional(),
  offscreenWsBytesBeforeReady: z.number().nonnegative().optional(),
}).strict().catchall(z.unknown())

export const VisibleFirstAuditSampleSchema = z.object({
  profileId: z.enum(AUDIT_PROFILE_IDS),
  status: z.enum(['ok', 'timeout', 'error']),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  browser: z.object({}).passthrough(),
  transport: z.object({}).passthrough(),
  server: z.object({}).passthrough(),
  derived: z.object({}).passthrough(),
  errors: z.array(z.string()),
}).strict()

const VisibleFirstSummaryByProfileSchema = z.object({
  desktop_local: VisibleFirstSummaryMetricSchema.optional(),
  mobile_restricted: VisibleFirstSummaryMetricSchema.optional(),
}).strict().refine(
  (value) => value.desktop_local !== undefined || value.mobile_restricted !== undefined,
  { message: 'summaryByProfile must contain at least one profile summary' },
)

export const VisibleFirstAuditScenarioSchema = z.object({
  id: z.enum(AUDIT_SCENARIO_IDS),
  description: z.string().min(1),
  focusedReadyMilestone: z.string().min(1),
  samples: z.array(VisibleFirstAuditSampleSchema)
    .min(1)
    .max(AUDIT_PROFILE_IDS.length)
    .refine(
      (samples) => isStableSubsetOrder(samples.map((sample) => sample.profileId), AUDIT_PROFILE_ORDER),
      { message: 'samples must follow the stable profile order without duplicates' },
    ),
  summaryByProfile: VisibleFirstSummaryByProfileSchema,
}).strict()

export const VisibleFirstAuditSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  git: z.object({
    commit: z.string().min(1),
    branch: z.string().min(1),
    dirty: z.boolean(),
  }).strict(),
  build: z.object({
    nodeVersion: z.string().min(1),
    browserVersion: z.string().min(1),
    command: z.string().min(1),
  }).strict(),
  profiles: z.array(VisibleFirstProfileSchema)
    .min(1)
    .max(AUDIT_PROFILE_IDS.length)
    .refine(
      (profiles) => isStableSubsetOrder(profiles.map((profile) => profile.id), AUDIT_PROFILE_ORDER),
      { message: 'profiles must follow the stable profile order without duplicates' },
    ),
  scenarios: z.array(VisibleFirstAuditScenarioSchema)
    .min(1)
    .max(AUDIT_SCENARIO_IDS.length)
    .refine(
      (scenarios) => isStableSubsetOrder(scenarios.map((scenario) => scenario.id), AUDIT_SCENARIO_ORDER),
      { message: 'scenarios must follow the stable scenario order without duplicates' },
    ),
}).strict()

export type VisibleFirstAuditArtifact = z.infer<typeof VisibleFirstAuditSchema>
export type VisibleFirstAuditScenario = z.infer<typeof VisibleFirstAuditScenarioSchema>
export type VisibleFirstAuditSample = z.infer<typeof VisibleFirstAuditSampleSchema>
export type VisibleFirstProfileId = typeof AUDIT_PROFILE_IDS[number]
export type VisibleFirstScenarioId = typeof AUDIT_SCENARIO_IDS[number]

export function assertVisibleFirstAuditTrusted(artifact: VisibleFirstAuditArtifact): void {
  const failures = artifact.scenarios.flatMap((scenario) =>
    scenario.samples
      .filter((sample) => sample.status !== 'ok')
      .map((sample) => `${scenario.id}/${sample.profileId}:${sample.status}`),
  )

  if (failures.length === 0) {
    return
  }

  throw new Error(`Visible-first audit is untrustworthy: ${failures.join(', ')}`)
}

export function getScenarioDescription(scenarioId: VisibleFirstScenarioId): string {
  return AUDIT_SCENARIOS.find((scenario) => scenario.id === scenarioId)?.description ?? scenarioId
}
