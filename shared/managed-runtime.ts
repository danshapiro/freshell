import { z } from 'zod'

const NonEmptyIdSchema = z.string().trim().min(1).max(160)
const NonNegativeIntSchema = z.number().int().nonnegative()

export const ManagedRuntimeLaunchStateSchema = z.enum([
  'prepared',
  'created',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
])
export const ManagedRuntimeCleanupStateSchema = z.enum([
  'none',
  'requested',
  'termination_unconfirmed',
  'verified_empty',
  'blocked_ownership',
])
export const ManagedRuntimeDesiredStateSchema = z.enum(['running', 'stopped'])
export const ManagedRuntimeRecoveryStateSchema = z.enum([
  'live',
  'recovering',
  'blocked',
  'lost',
  'stopped',
])
export const ManagedRuntimeDurabilityStateSchema = z.enum([
  'unknown',
  'live_only',
  'resume_captured',
  'checkpoint_captured',
  'intrinsically_non_resumable',
])
export const ManagedRuntimeAllocationStateSchema = z.enum([
  'allocated',
  'materializing',
  'verified_durable',
  'degraded',
])
export const ManagedRuntimeInitialScanStateSchema = z.enum([
  'pending',
  'scanning',
  'complete',
  'blocked',
])
export const ManagedRuntimeViewKindSchema = z.enum(['automatic_primary', 'explicit'])
export const ManagedRuntimeViewVisibilitySchema = z.enum(['visible', 'detached', 'hidden'])
export const ManagedRuntimeLimitApplicationSchema = z.enum(['applied_now', 'next_incarnation'])

export const ManagedRuntimeLimitsSchema = z.object({
  cpuMilli: NonNegativeIntSchema,
  memoryBytes: NonNegativeIntSchema,
  swapBytes: NonNegativeIntSchema,
  pidsMax: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeMetricsSchema = z.object({
  cpuUsageUsec: NonNegativeIntSchema,
  cpuThrottledUsec: NonNegativeIntSchema,
  cpuNrThrottled: NonNegativeIntSchema,
  memoryCurrentBytes: NonNegativeIntSchema,
  memoryPeakBytes: NonNegativeIntSchema,
  memoryOom: NonNegativeIntSchema,
  memoryOomKill: NonNegativeIntSchema,
  pidsCurrent: NonNegativeIntSchema,
  pidsMax: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeReadinessSchema = z.object({
  inventoryRevision: NonNegativeIntSchema,
  initialScanState: ManagedRuntimeInitialScanStateSchema,
  initialScanStartedAt: z.number().int().optional(),
  initialScanFinishedAt: z.number().int().optional(),
  blockedSubsystems: z.array(z.string()),
  startupRecoveryConcurrencyLimit: NonNegativeIntSchema,
  startupRecoveryPeak: NonNegativeIntSchema,
  initialScanDurationMs: NonNegativeIntSchema.optional(),
}).strict()

export const ManagedRuntimeSoulSchema = z.object({
  soulId: NonEmptyIdSchema,
  incarnationId: NonEmptyIdSchema,
  launchState: ManagedRuntimeLaunchStateSchema,
  cleanupState: ManagedRuntimeCleanupStateSchema,
  intentRevision: NonNegativeIntSchema,
  containerId: z.string().optional(),
  hostBootId: z.string().optional(),
  executionGeneration: NonNegativeIntSchema,
  effectiveLimits: ManagedRuntimeLimitsSchema.optional(),
  configuredLimits: ManagedRuntimeLimitsSchema.optional(),
  viewIntentRevision: NonNegativeIntSchema.optional(),
  terminalId: z.string().optional(),
  terminalStreamId: z.string().optional(),
  terminalMode: z.string().optional(),
  terminalCwd: z.string().optional(),
  terminalCreateRequestId: z.string().optional(),
  terminalResumeSessionId: z.string().optional(),
  projectKey: z.string().optional(),
  profile: z.enum(['default_agent', 'test_fixture', 'custom']).optional(),
  desiredState: ManagedRuntimeDesiredStateSchema,
  recoveryState: ManagedRuntimeRecoveryStateSchema,
  durabilityState: ManagedRuntimeDurabilityStateSchema,
  allocationState: ManagedRuntimeAllocationStateSchema,
  provider: z.string().optional(),
  nativeSessionId: z.string().optional(),
  recoveryReason: z.string().optional(),
  incidentId: NonEmptyIdSchema.optional(),
  priorIncarnationId: z.string().optional(),
  recoveryAttemptId: z.string().optional(),
  evidenceRevision: NonNegativeIntSchema,
  successfulRecoveriesInWindow: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeViewIntentSchema = z.object({
  viewId: NonEmptyIdSchema,
  soulId: NonEmptyIdSchema,
  ownerId: z.string(),
  workspaceId: z.string(),
  kind: ManagedRuntimeViewKindSchema,
  preferredTabId: NonEmptyIdSchema,
  preferredPaneId: NonEmptyIdSchema,
  title: z.string(),
  placementGroup: z.string(),
  visibility: ManagedRuntimeViewVisibilitySchema,
  revision: NonNegativeIntSchema,
  soulIntentRevision: NonNegativeIntSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict()

export const ManagedRuntimeInventorySnapshotSchema = z.object({
  revision: NonNegativeIntSchema,
  readiness: ManagedRuntimeReadinessSchema,
  souls: z.array(ManagedRuntimeSoulSchema),
  viewIntents: z.array(ManagedRuntimeViewIntentSchema),
  pendingProjectionCount: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeSoulDetailSchema = z.object({
  revision: NonNegativeIntSchema,
  readiness: ManagedRuntimeReadinessSchema,
  soul: ManagedRuntimeSoulSchema,
  viewIntents: z.array(ManagedRuntimeViewIntentSchema),
  actualUsage: ManagedRuntimeMetricsSchema.nullable(),
}).strict()

export const ManagedRuntimeUpdateLimitsResultSchema = z.object({
  view: ManagedRuntimeSoulSchema,
  application: ManagedRuntimeLimitApplicationSchema,
  configuredLimits: ManagedRuntimeLimitsSchema,
  effectiveLimits: ManagedRuntimeLimitsSchema.optional(),
}).strict()

export const ManagedRuntimeResourceSummarySchema = z.object({
  configured: ManagedRuntimeLimitsSchema.optional(),
  effective: ManagedRuntimeLimitsSchema.optional(),
  actual: ManagedRuntimeMetricsSchema.optional(),
  application: ManagedRuntimeLimitApplicationSchema.optional(),
}).strict()

export const ManagedRuntimeRecoverySummarySchema = z.object({
  desiredState: ManagedRuntimeDesiredStateSchema,
  recoveryState: ManagedRuntimeRecoveryStateSchema,
  reason: z.string().optional(),
  attemptId: z.string().optional(),
  incidentId: NonEmptyIdSchema.optional(),
  durabilityState: ManagedRuntimeDurabilityStateSchema,
  allocationState: ManagedRuntimeAllocationStateSchema,
}).strict()

/** Optional projection carried by terminal and fresh-agent pane/tab surfaces. */
export const ManagedRuntimeProjectionFieldsSchema = z.object({
  soulId: NonEmptyIdSchema.optional(),
  incarnationId: NonEmptyIdSchema.optional(),
  runtimeState: ManagedRuntimeLaunchStateSchema.optional(),
  viewIntentId: NonEmptyIdSchema.optional(),
  viewIntentRevision: NonNegativeIntSchema.optional(),
  soulIntentRevision: NonNegativeIntSchema.optional(),
  incidentId: NonEmptyIdSchema.optional(),
  placementGroup: z.string().optional(),
  resourceSummary: ManagedRuntimeResourceSummarySchema.optional(),
  recoverySummary: ManagedRuntimeRecoverySummarySchema.optional(),
}).strict()

export const ManagedRuntimeRevisionMutationSchema = z.object({
  requestId: NonEmptyIdSchema,
  expectedIntentRevision: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeLimitsMutationSchema = ManagedRuntimeRevisionMutationSchema.extend({
  cpuMilli: NonNegativeIntSchema,
  memoryBytes: NonNegativeIntSchema,
  swapBytes: NonNegativeIntSchema,
  pidsMax: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeViewMutationSchema = z.object({
  requestId: NonEmptyIdSchema,
  visibility: ManagedRuntimeViewVisibilitySchema,
  expectedRevision: NonNegativeIntSchema,
  expectedSoulIntentRevision: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeLossIncidentStateSchema = z.enum([
  'cleanup_pending',
  'cleanup_failed',
  'closed',
])

export const ManagedRuntimeLossCleanupReportSchema = z.object({
  ownedHandleRef: z.string(),
  ownershipVerified: z.boolean(),
  gracefulAttempt: z.string(),
  forcedAttempt: z.string(),
  verifiedEmpty: z.boolean(),
  verifiedAt: z.string().optional(),
  foreignObjectsTouched: NonNegativeIntSchema,
}).strict()

export const ManagedRuntimeIncidentSummarySchema = z.object({
  incidentId: NonEmptyIdSchema,
  correlationId: NonEmptyIdSchema,
  soulId: NonEmptyIdSchema,
  provider: z.string(),
  state: ManagedRuntimeLossIncidentStateSchema,
  reasonCode: z.string(),
  observedCause: z.string(),
  cleanup: ManagedRuntimeLossCleanupReportSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

export const ManagedRuntimeNoticeKindSchema = z.enum([
  'cleanup_succeeded',
  'cleanup_failed',
  'ended_without_process',
])
export const ManagedRuntimeNoticeDeliveryStateSchema = z.enum([
  'pending',
  'rendered',
  'acknowledged',
  'dismissed',
])
export const ManagedRuntimeNoticeSchema = z.object({
  noticeId: NonEmptyIdSchema,
  kind: ManagedRuntimeNoticeKindSchema,
  message: z.string(),
  reference: z.string(),
  incidentIds: z.array(NonEmptyIdSchema),
  deliveryState: ManagedRuntimeNoticeDeliveryStateSchema,
  createdAt: z.string(),
}).strict()
export const ManagedRuntimeNoticesResponseSchema = z.object({
  notices: z.array(ManagedRuntimeNoticeSchema),
}).strict()

export const ManagedRuntimeCounterSchema = z.object({
  name: z.string(),
  label: z.string(),
  value: NonNegativeIntSchema,
}).strict()
export const ManagedRuntimeMetricsSnapshotSchema = z.object({
  counters: z.array(ManagedRuntimeCounterSchema),
}).strict()

export const ManagedRuntimeRolloutModeSchema = z.enum([
  'legacy',
  'managed-opt-in',
  'managed-default',
])
export const ManagedRuntimeMigrationPlanSchema = z.object({
  migrationId: NonEmptyIdSchema,
  currentMode: ManagedRuntimeRolloutModeSchema,
  requestedMode: ManagedRuntimeRolloutModeSchema,
  dryRun: z.boolean(),
  controllerReady: z.boolean(),
  imageVerified: z.boolean(),
  registryBackupRequired: z.boolean(),
  registryBackupVerified: z.boolean(),
  registryBackupPath: z.string().optional(),
  registryBackupSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  registryBackupSchemaVersion: NonNegativeIntSchema.optional(),
  managedSoulCount: NonNegativeIntSchema,
  legacyMetadataCount: NonNegativeIntSchema,
  projectedCpuMilli: NonNegativeIntSchema,
  projectedMemoryBytes: NonNegativeIntSchema,
  projectedPids: NonNegativeIntSchema,
  blockers: z.array(z.string()),
}).strict()

export const ManagedRuntimeRepairAuditSchema = z.object({
  registryIntegrity: z.string(),
  protectedReceiptCount: NonNegativeIntSchema,
  unresolvedObjectCount: NonNegativeIntSchema,
  unknownOwnershipCount: NonNegativeIntSchema,
  blockedObjects: z.array(z.string()),
  mutationPerformed: z.boolean(),
}).strict()

export const ManagedRuntimeInventoryChangedMessageSchema = z.object({
  type: z.literal('runtime.inventory.changed'),
  revision: NonNegativeIntSchema,
  readiness: ManagedRuntimeReadinessSchema,
}).strict()

export const ManagedRuntimeViewChangedMessageSchema = z.object({
  type: z.literal('runtime.view.changed'),
  inventoryRevision: NonNegativeIntSchema,
  eventId: NonEmptyIdSchema,
  view: ManagedRuntimeViewIntentSchema,
}).strict()

export type ManagedRuntimeLimits = z.infer<typeof ManagedRuntimeLimitsSchema>
export type ManagedRuntimeMetrics = z.infer<typeof ManagedRuntimeMetricsSchema>
export type ManagedRuntimeReadiness = z.infer<typeof ManagedRuntimeReadinessSchema>
export type ManagedRuntimeSoul = z.infer<typeof ManagedRuntimeSoulSchema>
export type ManagedRuntimeViewIntent = z.infer<typeof ManagedRuntimeViewIntentSchema>
export type ManagedRuntimeViewVisibility = z.infer<typeof ManagedRuntimeViewVisibilitySchema>
export type ManagedRuntimeInventorySnapshot = z.infer<typeof ManagedRuntimeInventorySnapshotSchema>
export type ManagedRuntimeSoulDetail = z.infer<typeof ManagedRuntimeSoulDetailSchema>
export type ManagedRuntimeUpdateLimitsResult = z.infer<typeof ManagedRuntimeUpdateLimitsResultSchema>
export type ManagedRuntimeIncidentSummary = z.infer<typeof ManagedRuntimeIncidentSummarySchema>
export type ManagedRuntimeNotice = z.infer<typeof ManagedRuntimeNoticeSchema>
export type ManagedRuntimeNoticeDeliveryState = z.infer<typeof ManagedRuntimeNoticeDeliveryStateSchema>
export type ManagedRuntimeMetricsSnapshot = z.infer<typeof ManagedRuntimeMetricsSnapshotSchema>
export type ManagedRuntimeRolloutMode = z.infer<typeof ManagedRuntimeRolloutModeSchema>
export type ManagedRuntimeMigrationPlan = z.infer<typeof ManagedRuntimeMigrationPlanSchema>
export type ManagedRuntimeRepairAudit = z.infer<typeof ManagedRuntimeRepairAuditSchema>
export type ManagedRuntimeResourceSummary = z.infer<typeof ManagedRuntimeResourceSummarySchema>
export type ManagedRuntimeRecoverySummary = z.infer<typeof ManagedRuntimeRecoverySummarySchema>
export type ManagedRuntimeProjectionFields = z.infer<typeof ManagedRuntimeProjectionFieldsSchema>
export type ManagedRuntimeRevisionMutation = z.infer<typeof ManagedRuntimeRevisionMutationSchema>
export type ManagedRuntimeLimitsMutation = z.infer<typeof ManagedRuntimeLimitsMutationSchema>
export type ManagedRuntimeViewMutation = z.infer<typeof ManagedRuntimeViewMutationSchema>
export type ManagedRuntimeInventoryChangedMessage = z.infer<typeof ManagedRuntimeInventoryChangedMessageSchema>
export type ManagedRuntimeViewChangedMessage = z.infer<typeof ManagedRuntimeViewChangedMessageSchema>
