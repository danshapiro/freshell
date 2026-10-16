import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeRecoveryState,
  ManagedRuntimeViewVisibility,
} from '@shared/managed-runtime'

export function managedRuntimeInventoryFixture(options: {
  soulId: string
  viewId: string
  terminalId?: string
  terminalCreateRequestId?: string
  viewRevision?: number
  soulIntentRevision?: number
  visibility?: ManagedRuntimeViewVisibility
  desiredState?: 'running' | 'stopped'
  recoveryState?: ManagedRuntimeRecoveryState
}): ManagedRuntimeInventorySnapshot {
  const revision = options.viewRevision ?? 2
  const soulIntentRevision = options.soulIntentRevision ?? 7
  const desiredState = options.desiredState ?? 'running'
  const recoveryState = options.recoveryState ?? (desiredState === 'stopped' ? 'stopped' : 'live')
  const stopped = desiredState === 'stopped'
  return {
    revision,
    readiness: {
      inventoryRevision: revision,
      initialScanState: 'complete',
      initialScanStartedAt: 1,
      initialScanFinishedAt: 2,
      blockedSubsystems: [],
      startupRecoveryConcurrencyLimit: 1,
      startupRecoveryPeak: 1,
      initialScanDurationMs: 1,
    },
    souls: [{
      soulId: options.soulId,
      incarnationId: `incarnation-${options.soulId}`,
      launchState: stopped ? 'stopped' : 'running',
      cleanupState: stopped ? 'verified_empty' : 'none',
      intentRevision: soulIntentRevision,
      executionGeneration: 1,
      terminalId: options.terminalId,
      terminalCreateRequestId: options.terminalCreateRequestId,
      desiredState,
      recoveryState,
      durabilityState: 'resume_captured',
      allocationState: 'verified_durable',
      evidenceRevision: 1,
      successfulRecoveriesInWindow: 0,
    }],
    viewIntents: [{
      viewId: options.viewId,
      soulId: options.soulId,
      ownerId: 'test-installation',
      workspaceId: 'test-workspace',
      kind: 'automatic_primary',
      preferredTabId: 'tab-1',
      preferredPaneId: 'pane-1',
      title: 'Managed test view',
      placementGroup: 'Recovered agents',
      visibility: options.visibility ?? 'visible',
      revision: revision,
      soulIntentRevision,
      createdAt: 1,
      updatedAt: 2,
    }],
    pendingProjectionCount: 0,
  }
}
