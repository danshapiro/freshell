type Provider = 'claude' | 'codex' | 'opencode' | 'amplifier'

// Match the owned startup phases in freshell-platform/provider_startup.rs.
// A replacement stages inputs before its existing stop/create/native wait;
// the 4,201-file selection must be allowed to finish both ordinary projections.
function providerPreparationWaitMs(provider: Provider): number {
  const controller = 35_000
  if (provider !== 'claude') return controller
  const nativeObservation = 25_000
  const ordinaryProjection = 25_000
  const readerCleanup = 5_000
  return controller + nativeObservation + readerCleanup
    + nativeObservation + ordinaryProjection * 2 + readerCleanup
}

export function managedLifecycleWaitMs(provider: Provider): number {
  const runtimeStopCreateAndNativeReady = 90_000
  const retainedMountpointCleanup = 60_000
  const mountpointCreate = 60_000
  const mountpointWork = 30_000
  const mountpointCleanup = 60_000
  const publisherOperationAndCleanup = 20_000 + 60_000
  // Slow rootless Docker creation/removal is valid within these separate
  // backend bounds. Both terminal and fresh-agent creates include preparation
  // before a runtime can start and return its requester-scoped acknowledgement.
  return runtimeStopCreateAndNativeReady + providerPreparationWaitMs(provider)
    + retainedMountpointCleanup + mountpointCreate + mountpointWork
    + mountpointCleanup + publisherOperationAndCleanup
}
