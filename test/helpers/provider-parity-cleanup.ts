import fs from 'node:fs'

import type { InitialProviderVolumeAuthorization } from '../../scripts/testing/runtime-test-broker.js'
import { captureProviderParityVolumes, cleanupProviderParityVolumes } from './provider-parity-broker.js'

type ParityRuntime = {
  stop(): Promise<{ ok: boolean; errors: string[] }>
  runtime: { writeIncident(name: string, value: unknown): void }
}

type ParityCleanup = {
  connections: readonly { close(): Promise<void> }[]
  rig: ParityRuntime | undefined
  registeredVolumes?: InitialProviderVolumeAuthorization[]
  restoreOnecliEnvironment: (() => void) | undefined
  inheritedEnvironment?: Record<string, string | undefined>
  directories: readonly (string | undefined)[]
}

const cleanupDependencies = {
  captureVolumes: captureProviderParityVolumes,
  removeVolumes: cleanupProviderParityVolumes,
  removeDirectory: (directory: string) => fs.rmSync(directory, { recursive: true, force: true }),
}

/** Shared teardown for the fixture parity suites; no provider startup or test registration. */
export async function cleanupProviderParity(
  { connections, rig, registeredVolumes, restoreOnecliEnvironment, inheritedEnvironment = {}, directories }: ParityCleanup,
  dependencies = cleanupDependencies,
): Promise<void> {
  try {
    await Promise.allSettled(connections.map(connection => connection.close()))
    if (rig) {
      let volumes: ReturnType<typeof captureProviderParityVolumes> = []
      let captureError: unknown
      if (registeredVolumes) {
        try {
          volumes = dependencies.captureVolumes(registeredVolumes)
          rig.runtime.writeIncident('provider-parity-registered-volumes', volumes)
        } catch (error) { captureError = error }
      }
      const cleanup = await rig.stop()
      if (cleanup.ok !== true) throw new Error(cleanup.errors.join('\n') || 'provider parity runtime cleanup failed')
      if (captureError) throw captureError
      if (registeredVolumes) {
        rig.runtime.writeIncident('provider-parity-registered-volume-cleanup', {
          removed: dependencies.removeVolumes(volumes),
        })
      }
    }
  } finally {
    restoreOnecliEnvironment?.()
    for (const [key, value] of Object.entries(inheritedEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const directory of directories) {
      if (directory) dependencies.removeDirectory(directory)
    }
  }
}
