import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

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
  fixtureWork?: { cancel(): boolean; join(): Promise<void> }
  finalObservation: ((signal: AbortSignal) => Promise<unknown>) | undefined
  naming: { closeAllConnections(): void; close(callback: (error?: Error) => void): unknown } | undefined
  restoreGrants: (() => void) | undefined
  grantsDirectory: string | undefined
  home: string | undefined
}

const volumeOperationBudgetMs = 10_000

function boundedDocker(deadline: number) {
  return (args: string[]) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('managed Codex volume operation exceeded its time budget')
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: remaining,
    })
  }
}

const cleanupDependencies = {
  captureVolumes: (owners: InitialProviderVolumeAuthorization[], budgetMs: number) =>
    captureProviderParityVolumes(owners, boundedDocker(Date.now() + budgetMs)),
  removeVolumes: (volumes: ReturnType<typeof captureProviderParityVolumes>, budgetMs: number) =>
    cleanupProviderParityVolumes(volumes, boundedDocker(Date.now() + budgetMs)),
  removeDirectory: (directory: string) => fs.rmSync(directory, { recursive: true, force: true }),
}

/** Track test-owned fixture work until teardown has cancelled and joined it. */
export function createManagedCodexFixtureWork() {
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let settlement: Promise<PromiseSettledResult<unknown>[]> | undefined
  let activeAtCancellation = false
  return {
    throwIfAborted(): void { controller.signal.throwIfAborted() },
    run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted()
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return operation(controller.signal)
      }).then(value => {
        controller.signal.throwIfAborted()
        return value
      })
      pending.add(work)
      void work.then(() => { pending.delete(work) }, () => { pending.delete(work) })
      return work
    },
    cancel(): boolean {
      if (settlement) return activeAtCancellation
      const work = [...pending]
      activeAtCancellation = work.length > 0
      controller.abort(new Error('managed Codex fixture lifecycle cancelled by teardown'))
      settlement = Promise.allSettled(work)
      return activeAtCancellation
    },
    async join(): Promise<void> {
      const results = await settlement
      const errors = (results ?? []).flatMap(result => result.status === 'rejected' && result.reason !== controller.signal.reason
        ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'managed Codex fixture work failed during teardown')
    },
  }
}

/** Read the active model traffic from the installed-Codex test body. */
export function readManagedCodexFixtureTraffic<T>(
  fixtureWork: ReturnType<typeof createManagedCodexFixtureWork>, model: { traffic(): Promise<T> },
): Promise<T> {
  return fixtureWork.run(() => model.traffic())
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
  { rig, owners, wire, model, fixtureWork, finalObservation, naming, restoreGrants, grantsDirectory, home }: ManagedCodexCleanup,
  dependencies = cleanupDependencies,
): Promise<void> {
  const errors: unknown[] = []
  const attempt = async (operation: () => unknown | Promise<unknown>) => {
    try { await operation() } catch (error) { errors.push(error) }
  }

  const fixtureWasActive = fixtureWork?.cancel() ?? false
  const cancellation = new AbortController()
  let runtimeStopped = !rig
  let volumes: ReturnType<typeof captureProviderParityVolumes> | undefined
  let runtimeSettlement: Promise<void> | undefined
  const startRuntimeStop = () => {
    if (!rig || runtimeSettlement) return
    runtimeSettlement = (async () => {
      await attempt(() => { volumes = dependencies.captureVolumes(owners, volumeOperationBudgetMs) })
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
    if (!cancellation.signal.aborted && !fixtureWasActive) await attempt(() => model?.stop(cancellation.signal))
  } finally {
    if (deadline) clearTimeout(deadline)
    startRuntimeStop()
    await runtimeSettlement
    await attempt(() => fixtureWork?.join())
  }
  if (runtimeStopped && volumes) {
    const captured = volumes
    await attempt(() => dependencies.removeVolumes(captured, volumeOperationBudgetMs))
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
