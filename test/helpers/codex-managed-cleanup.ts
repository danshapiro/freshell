import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

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
const fixtureJoinBudgetMs = 30_000

type QualifiedDockerTarget = { daemonId: string; socket: string; cli: string }

// The installed-test driver supplies these values after independently
// qualifying the guest. They are captured before late fixture setup can
// supply an owner or volume authorization.
function qualifiedDockerTarget(): QualifiedDockerTarget {
  const daemonId = process.env.FRESHELL_TASK4_DAEMON_ID
  const socket = process.env.FRESHELL_TASK4_DOCKER_SOCKET
  const cli = process.env.FRESHELL_TASK4_DOCKER_CLI
  if (process.env.FRESHELL_TASK4_GUEST_QUALIFIED !== '1'
    || !daemonId || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(daemonId)
    || !socket || !path.isAbsolute(socket) || !cli || !path.isAbsolute(cli)) {
    throw new Error('qualified managed Codex daemon identity is unavailable')
  }
  return { daemonId, socket, cli }
}

// Check the process's effective Docker socket and CLI against the admitted
// target. The installed-test driver separately qualifies the broker route.
// Never put Docker stderr or environment contents into a cleanup error.
function requireQualifiedDockerTarget(target: QualifiedDockerTarget): void {
  try {
    if (process.env.DOCKER_HOST !== `unix://${target.socket}` || process.env.DOCKER_CONTEXT
      || process.env.DOCKER_CERT_PATH || process.env.DOCKER_TLS_VERIFY || !fs.statSync(target.socket).isSocket()) {
      throw new Error('unexpected Docker route')
    }
    const docker = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'docker'))
      .find(candidate => {
        try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile() } catch { return false }
      })
    if (!docker || fs.realpathSync(docker) !== fs.realpathSync(target.cli)) throw new Error('unexpected Docker CLI')
    const actual = execFileSync('docker', ['info', '--format', '{{.ID}}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: volumeOperationBudgetMs,
    }).trim()
    if (actual !== target.daemonId) throw new Error('unexpected Docker daemon')
  } catch {
    throw new Error('qualified managed Codex daemon identity is unavailable or changed')
  }
}

function boundedDocker(deadline: number) {
  return (args: string[]) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('managed Codex volume operation exceeded its time budget')
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: remaining,
    })
  }
}

export const managedCodexCleanupDependencies = {
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
    get signal(): AbortSignal { return controller.signal },
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
  dependencies = managedCodexCleanupDependencies,
): Promise<void> {
  const errors: unknown[] = []
  const attempt = async (operation: () => unknown | Promise<unknown>) => {
    try { await operation() } catch (error) { errors.push(error) }
  }

  const fixtureWasActive = fixtureWork?.cancel() ?? false
  const cancellation = new AbortController()
  const qualifiedGuard = !!rig && process.env.FRESHELL_TASK4_INSTALLED_CLEANUP_GUARD === '1'
  let target: QualifiedDockerTarget | undefined
  let daemonFailure: Error | undefined
  let notifyDaemonFailure!: () => void
  const daemonFailureSignal = new Promise<void>(resolve => { notifyDaemonFailure = resolve })
  const recordDaemonFailure = (stage: string) => {
    if (daemonFailure) return
    daemonFailure = new Error(`qualified managed Codex daemon identity unavailable or changed before ${stage}; resources retained`)
    errors.push(daemonFailure)
    cancellation.abort(daemonFailure)
    notifyDaemonFailure()
  }
  if (qualifiedGuard) {
    try { target = qualifiedDockerTarget() } catch { recordDaemonFailure('cleanup') }
  }
  const checkDaemon = (stage: string): boolean => {
    if (!qualifiedGuard) return true
    if (daemonFailure || !target) return false
    try { requireQualifiedDockerTarget(target); return true } catch { recordDaemonFailure(stage); return false }
  }
  // If a probe does not honor cancellation and owner stop is unsafe, stop
  // awaiting it but retain its resources and report the unresolved work.
  const awaitDaemonWork = async <T>(work: Promise<T>): Promise<T> => {
    if (!qualifiedGuard) return work
    return Promise.race([
      work,
      daemonFailureSignal.then(() => { throw new Error('managed Codex daemon cleanup work unresolved after identity failure') }),
    ])
  }
  let runtimeStopped = !rig
  let volumes: ReturnType<typeof captureProviderParityVolumes> | undefined
  let runtimeSettlement: Promise<void> | undefined
  const startRuntimeStop = () => {
    if (!rig || runtimeSettlement) return
    runtimeSettlement = (async () => {
      if (daemonFailure) return
      await attempt(() => { volumes = dependencies.captureVolumes(owners, volumeOperationBudgetMs) })
      if (!checkDaemon('owner stop')) return
      await attempt(async () => {
        const result = await rig.stop()
        if (!result.ok) throw new Error(result.errors.join('\n') || 'managed Codex runtime cleanup failed')
        runtimeStopped = true
      })
    })()
  }
  // Start the existing owner while its probes are still pending, so it can
  // cancel and join them instead of letting sequential reads exhaust the hook.
  if (rig) checkDaemon('cleanup')
  const deadline = rig ? setTimeout(() => {
    const error = new Error('managed Codex diagnostic or fixture cleanup exceeded its 30 second grace period')
    errors.push(error)
    cancellation.abort(error)
    startRuntimeStop()
  }, 30_000) : undefined
  try {
    if (rig && finalObservation && !daemonFailure) {
      try { rig.runtime.writeIncident('freshcodex-managed-native-final-state', await awaitDaemonWork(finalObservation(cancellation.signal))) }
      catch (error) {
        if (daemonFailure) errors.push(new Error('managed Codex diagnostic work unresolved after daemon identity failure'))
        else {
          try { rig.runtime.writeIncident('freshcodex-managed-native-final-state-error', { error: String(error) }) }
          catch (writeError) { errors.push(error, writeError) }
        }
      }
    }
    await attempt(() => wire?.close())
    if (!cancellation.signal.aborted && !fixtureWasActive && model) {
      await attempt(() => awaitDaemonWork(model.stop(cancellation.signal)))
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    startRuntimeStop()
    await runtimeSettlement
    if (fixtureWork && daemonFailure) {
      await attempt(async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const joined = await Promise.race([
            fixtureWork.join().then(() => true),
            new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), fixtureJoinBudgetMs) }),
          ])
          if (!joined) throw new Error('managed Codex fixture work unresolved after daemon identity failure')
        } finally { if (timeout) clearTimeout(timeout) }
      })
    } else {
      await attempt(() => fixtureWork?.join())
    }
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
