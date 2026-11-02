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
  model: { stop(): Promise<void> } | undefined
  finalObservation: (() => Promise<unknown>) | undefined
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

/** Settle the installed-Codex parity fixture and its receipt-owned runtime. */
export async function cleanupManagedCodexParity(
  { rig, owners, wire, model, finalObservation, naming, restoreGrants, grantsDirectory, home }: ManagedCodexCleanup,
  dependencies = cleanupDependencies,
): Promise<void> {
  const errors: unknown[] = []
  const attempt = async (operation: () => unknown | Promise<unknown>) => {
    try { await operation() } catch (error) { errors.push(error) }
  }

  if (rig && finalObservation) {
    try { rig.runtime.writeIncident('freshcodex-managed-native-final-state', await finalObservation()) }
    catch (error) {
      try { rig.runtime.writeIncident('freshcodex-managed-native-final-state-error', { error: String(error) }) }
      catch (writeError) { errors.push(error, writeError) }
    }
  }
  await attempt(() => wire?.close())
  await attempt(() => model?.stop())
  let runtimeStopped = !rig
  if (rig) {
    let volumes: ReturnType<typeof captureProviderParityVolumes> | undefined
    await attempt(() => { volumes = dependencies.captureVolumes(owners) })
    await attempt(async () => {
      const result = await rig.stop()
      if (!result.ok) throw new Error(result.errors.join('\n') || 'managed Codex runtime cleanup failed')
      runtimeStopped = true
    })
    if (runtimeStopped && volumes) {
      const captured = volumes
      await attempt(() => dependencies.removeVolumes(captured))
    }
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
