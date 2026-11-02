import fs from 'node:fs'

import type { InitialProviderVolumeAuthorization } from '../../scripts/testing/runtime-test-broker.js'
import { captureProviderParityVolumes, cleanupProviderParityVolumes } from './provider-parity-broker.js'

type ManagedCodexCleanup = {
  rig: {
    stop(): Promise<{ ok: boolean; errors: string[] }>
    runtime: { writeIncident(name: string, value: unknown): void }
  } | undefined
  owners: InitialProviderVolumeAuthorization[]
  wire: { close(): Promise<void> } | undefined
  model: { stop(signal: AbortSignal): Promise<void> } | undefined
  finalObservation: ((signal: AbortSignal) => Promise<unknown>) | undefined
  naming: { closeAllConnections(): void; close(callback: (error?: Error) => void): unknown } | undefined
  restoreGrants: (() => void) | undefined
  grantsDirectory: string | undefined
  home: string | undefined
}

const cleanupDependencies = {
  captureVolumes: captureProviderParityVolumes,
  removeVolumes: cleanupProviderParityVolumes,
  removeDirectory: (directory: string) => fs.rmSync(directory, { recursive: true, force: true }),
}

/** Collect the two provider-side parts of the final managed Codex incident. */
export async function collectManagedCodexProviderDiagnostics(
  signal: AbortSignal,
  readNativeFiles: () => Promise<unknown>,
  readTraffic: () => Promise<unknown>,
  retainedTraffic: unknown,
): Promise<{ nativeFiles: unknown; traffic: unknown }> {
  let nativeFiles: unknown
  signal.throwIfAborted()
  try { nativeFiles = await readNativeFiles() }
  catch (error) {
    if (signal.aborted) throw error
    nativeFiles = { error: String(error) }
  }
  signal.throwIfAborted()
  let traffic: unknown
  try { traffic = await readTraffic() }
  catch (error) {
    if (signal.aborted) throw error
    traffic = { retained: retainedTraffic, error: String(error) }
  }
  signal.throwIfAborted()
  return { nativeFiles, traffic }
}

/** Settle the installed-Codex parity fixture and its receipt-owned runtime. */
export async function cleanupManagedCodexParity(
  { rig, owners, wire, model, finalObservation, naming, restoreGrants, grantsDirectory, home }: ManagedCodexCleanup,
  dependencies = cleanupDependencies,
): Promise<void> {
  const errors: unknown[] = []
  const attempt = async (operation: () => unknown | Promise<unknown>) => {
    try { await operation() } catch (error) { errors.push(error) }
  }

  const cancellation = new AbortController()
  let runtimeStopped = !rig
  let volumes: ReturnType<typeof captureProviderParityVolumes> | undefined
  let runtimeSettlement: Promise<void> | undefined
  const startRuntimeStop = () => {
    if (!rig || runtimeSettlement) return
    runtimeSettlement = (async () => {
      await attempt(() => { volumes = dependencies.captureVolumes(owners) })
      await attempt(async () => {
        const result = await rig.stop()
        if (!result.ok) throw new Error(result.errors.join('\n') || 'managed Codex runtime cleanup failed')
        runtimeStopped = true
      })
    })()
  }
  // Start the existing owner while its probes are still pending, so it can
  // cancel and join them instead of letting sequential reads exhaust the hook.
  const deadline = rig ? setTimeout(() => {
    const error = new Error('managed Codex diagnostic or fixture cleanup exceeded its 30 second grace period')
    errors.push(error)
    cancellation.abort(error)
    startRuntimeStop()
  }, 30_000) : undefined
  try {
    if (rig && finalObservation) {
      try { rig.runtime.writeIncident('freshcodex-managed-native-final-state', await finalObservation(cancellation.signal)) }
      catch (error) {
        try { rig.runtime.writeIncident('freshcodex-managed-native-final-state-error', { error: String(error) }) }
        catch (writeError) { errors.push(error, writeError) }
      }
    }
    await attempt(() => wire?.close())
    if (!cancellation.signal.aborted) await attempt(() => model?.stop(cancellation.signal))
  } finally {
    if (deadline) clearTimeout(deadline)
    startRuntimeStop()
    await runtimeSettlement
  }
  if (runtimeStopped && volumes) {
    const captured = volumes
    await attempt(() => dependencies.removeVolumes(captured))
  }
  if (naming) {
    await attempt(() => naming.closeAllConnections())
    await attempt(() => new Promise<void>((resolve, reject) => naming.close(error => error ? reject(error) : resolve())))
  }
  await attempt(() => restoreGrants?.())
  const directories = [grantsDirectory, home].filter((directory): directory is string => !!directory)
  if (runtimeStopped) {
    for (const directory of directories) await attempt(() => dependencies.removeDirectory(directory))
  } else if (directories.length) {
    errors.push(new Error(`managed Codex fixture paths retained because runtime cleanup was not confirmed: ${directories.join(', ')}`))
  }
  if (errors.length) throw new AggregateError(errors, 'managed Codex parity cleanup failed')
}
