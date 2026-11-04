// Real execution requires independent guest qualification and a separately
// admitted bounded driver; the local preflight is only a second check.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ManagedRuntimeOwner, dockerSocketPath, newSoul } from './runtime-sandbox.js'
import { checkInFlightOwnedProbe } from './codex-inflight-owned-probe.js'
import { readProviderParitySource } from '../../test/helpers/provider-parity-broker.js'

type Input = { repo: string; daemonId: string; socket: string; dockerCli: string }
type OwnerResult = Awaited<ReturnType<ManagedRuntimeOwner['stop']>>
type Failure = { phase: 'case' | 'owner_stop' | 'final_observation'; kind: 'assertion' | 'operation' | 'reported_failure' | 'unsettled' }

function event(name: string, fields: Record<string, unknown>): void {
  const severity = name.endsWith('.failed') || name.endsWith('.recovery_required') ? 'error' : 'info'
  process.stdout.write(`${JSON.stringify({ severity, event: name, ...fields })}\n`)
}

// Confirm the run identity was written before any fixture can be allocated.
function recordIdentity(name: 'real_probe_driver.owner' | 'real_probe_driver.fixture_attempt' | 'real_probe_driver.recovery_required', fields: Record<string, unknown>): Promise<void> {
  const severity = name === 'real_probe_driver.recovery_required' ? 'error' : 'info'
  const line = `${JSON.stringify({ severity, event: name, ...fields })}\n`
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    process.stdout.once('error', onError)
    try {
      process.stdout.write(line, error => {
        if (error) {
          setImmediate(() => process.stdout.off('error', onError))
          reject(error)
        } else {
          process.stdout.off('error', onError)
          resolve()
        }
      })
    } catch (error) {
      process.stdout.off('error', onError)
      reject(error)
    }
  })
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024,
  }).trim()
}

function exactVolumeExists(volume: string, daemonId: string): boolean {
  assert.match(volume, /^freshell-provider-[a-f0-9]{24}$/)
  const requireDaemon = () => assert.equal(docker(['info', '--format', '{{.ID}}']), daemonId)
  requireDaemon()
  const names = docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']).split('\n')
  requireDaemon()
  return names.includes(volume)
}

/** Run only inside the independently qualified, admitted disposable guest. */
export async function runOwnedHeartbeatProbe({ repo, daemonId, socket, dockerCli }: Input): Promise<void> {
  assert.equal(process.env.DOCKER_HOST, `unix://${socket}`)
  assert.equal(dockerSocketPath(), socket)

  const owner = new ManagedRuntimeOwner(() => { throw new Error('web server is unused by this probe') }, repo, 2)
  const actualStop = owner.stop
  let stopPromise: Promise<OwnerResult> | undefined
  let stopCalls = 0
  let stopRefused = false
  let supervisorId: string | null = null
  let containerId: string | null = null
  let providerVolume: string | null = null
  // This only records and joins the actual owner's one stop promise; it never
  // creates another owner or substitutes cleanup. A second call is a failure.
  owner.stop = () => {
    if (stopPromise) throw new Error('owner stop was requested more than once')
    stopPromise = (async () => {
      try {
        assert.equal(process.env.DOCKER_HOST, `unix://${socket}`)
        assert.equal(dockerSocketPath(), socket)
        assert.equal(docker(['info', '--format', '{{.ID}}']), daemonId)
      } catch (error) {
        stopRefused = true
        // The in-flight probe may not settle without owner cleanup. Hand off
        // known identity before waiting so the guest driver can recover it.
        await recordIdentity('real_probe_driver.recovery_required', { daemonId, runId: owner.runtime.runId,
          supervisorId, containerId, providerVolume, stopCalls, ownerStopped: null,
          failures: [{ phase: 'owner_stop', kind: 'unsettled' }] })
        throw error
      }
      stopCalls++
      return actualStop.call(owner)
    })()
    return stopPromise
  }
  let stopResult: OwnerResult | undefined
  let bodyComplete = false
  const failures: Failure[] = []
  const errors: unknown[] = []
  try {
    await recordIdentity('real_probe_driver.owner', { daemonId, runId: owner.runtime.runId, testRoot: owner.runtime.testRoot,
      buildDir: owner.runtime.buildDir, evidenceDir: owner.runtime.evidenceDir })
    await owner.runtime.prepare()
    const supervisor = await owner.runtime.startSupervisor({ scenarioId: 'task4-owned-probe' })
    owner.supervisor = supervisor
    supervisorId = supervisor.containerId
    const health = await owner.runtime.adminOk(supervisor, { method: 'health' })
    assert.equal(health.kind, 'health')
    const installationId = health.data.installation_id
    const epoch = health.data.control_epoch ?? health.data.controlEpoch
    assert.ok(typeof installationId === 'string')
    assert.ok(Number.isSafeInteger(epoch) && epoch >= 0)
    const source = await readProviderParitySource(owner.runtime, installationId)
    // The helper queried the broker endpoint; the shared preflight and probe
    // independently query the inherited direct CLI endpoint.
    assert.equal(source.daemonId, daemonId)

    const soulId = newSoul()
    const expectedVolume = `freshell-provider-${createHash('sha256')
      .update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}`
    assert.equal(exactVolumeExists(expectedVolume, daemonId), false, 'never adopt a pre-existing fixture volume')
    await recordIdentity('real_probe_driver.fixture_attempt', {
      daemonId, runId: owner.runtime.runId, soulId, providerVolume: expectedVolume,
    })
    providerVolume = expectedVolume
    const reply = await owner.runtime.adminOk(supervisor, owner.runtime.launchBody({
      soulId, fixture: 'heartbeat', profile: 'test_fixture', projectKey: 'task4-owned-probe',
      limits: { cpuMilli: 500, memoryBytes: 256 * 1024 * 1024, swapBytes: 0, pidsMax: 64 },
      expectedControlEpoch: epoch,
    }))
    assert.equal(reply.kind, 'launch')
    assert.equal(reply.data.workerLaunchCount, 1)
    const view = reply.data.view
    assert.equal(view.soulId, soulId)
    const currentContainerId: unknown = view.containerId
    assert.ok(typeof currentContainerId === 'string')
    assert.match(currentContainerId, /^[a-f0-9]{64}$/)
    assert.equal(typeof view.incarnationId, 'string')
    containerId = currentContainerId
    assert.equal(owner.runtime.isContainerRunning(currentContainerId, true), true)
    const receipts = owner.runtime.broker.receipts().filter(receipt => receipt.containerId === currentContainerId)
    assert.equal(receipts.length, 1)
    const receipt = receipts[0]
    assert.equal(receipt.installationId, installationId)
    assert.equal(receipt.soulId, soulId)
    assert.equal(receipt.incarnationId, view.incarnationId)
    assert.equal(receipt.imageRef, owner.runtime.imageRef)
    assert.equal(receipt.hostBinaryPath, owner.runtime.testHostBinary)
    assert.ok(owner.runtime.broker.receiptIds().has(currentContainerId))
    assert.equal(receipt.providerVolumeName, expectedVolume)
    // This route uses the heartbeat's receipt-owned fixture volume, not an
    // unreserved initial provider volume; stop if actual behavior differs.
    assert.equal(owner.runtime.broker.initialProviderVolumeCreations()
      .some(authorization => authorization.providerVolumeName === providerVolume), false)
    assert.equal(exactVolumeExists(providerVolume, daemonId), true)
    const heartbeat = path.join(owner.runtime.runtimeDir(supervisor, view.incarnationId), 'heartbeat.json')
    await owner.runtime.waitForFile(heartbeat)
    event('real_probe_driver.heartbeat_ready', { daemonId, runId: owner.runtime.runId,
      supervisorId, containerId, providerVolume, receiptCount: receipts.length })

    // This calls real cleanupManagedCodexParity and the real owner.stop(); it
    // asserts both exact processes are live at stop and settled afterward.
    await checkInFlightOwnedProbe({ owner, containerId: currentContainerId, owners: [], daemonId, daemonSocket: socket, dockerCli })
    assert.ok(stopPromise, 'the probe must initiate the owner cleanup')
    bodyComplete = true
  } catch (error) {
    failures.push({ phase: 'case', kind: error instanceof assert.AssertionError ? 'assertion' : 'operation' })
    errors.push(error)
  }

  // If setup failed before the probe started cleanup, attempt the same real
  // owner stop once. Otherwise join the already-started stop without retry.
  try {
    stopResult = await (stopPromise ?? owner.stop())
    if (!stopResult.ok) {
      failures.push({ phase: 'owner_stop', kind: 'reported_failure' })
      errors.push(new Error('owner stop returned failure'))
    }
  } catch (error) {
    failures.push({ phase: 'owner_stop', kind: stopRefused ? 'unsettled' : 'operation' })
    errors.push(error)
  } finally {
    owner.stop = actualStop
  }

  if (bodyComplete && stopResult?.ok && containerId && providerVolume) {
    try {
      assert.equal(stopCalls, 1)
      const cleanup = JSON.parse(fs.readFileSync(path.join(owner.runtime.evidenceDir, 'cleanup.json'), 'utf8'))
      assert.equal(cleanup.ok, true)
      assert.equal(cleanup.brokerSettlementComplete, true)
      assert.equal(cleanup.verifiedResourcesAbsent, true)
      assert.ok(Array.isArray(cleanup.exactContainerIds) && cleanup.exactContainerIds.includes(containerId))
      assert.ok(Array.isArray(cleanup.volumes) && cleanup.volumes.includes(providerVolume))
      assert.equal(exactVolumeExists(providerVolume, daemonId), false)
    } catch (error) {
      failures.push({ phase: 'final_observation', kind: error instanceof assert.AssertionError ? 'assertion' : 'operation' })
      errors.push(error)
    }
  }
  if (failures.length || !bodyComplete || !stopResult?.ok) {
    event('real_probe_driver.recovery_required', { daemonId, runId: owner.runtime.runId,
      supervisorId, containerId, providerVolume, stopCalls, ownerStopped: stopResult?.ok ?? null, failures })
    throw new AggregateError(errors, 'real owned probe case or teardown failed')
  }
  event('real_probe_driver.completed', { daemonId, runId: owner.runtime.runId, containerId,
    providerVolume, stopCalls, ownerStopped: true, passedCases: 1 })
}

async function main(): Promise<void> {
  const { requireQualifiedGuest } = await import('./codex-real-volume-lifecycle.js')
  const { repo, daemonId } = requireQualifiedGuest()
  const socket = process.env.FRESHELL_TASK4_DOCKER_SOCKET
  const dockerCli = process.env.FRESHELL_TASK4_DOCKER_CLI
  assert.ok(socket && dockerCli)
  await runOwnedHeartbeatProbe({ repo, daemonId, socket, dockerCli })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never print original errors, Docker stderr, commands or environment.
    event('real_probe_driver.failed', { phase: 'driver', kind: 'operation' })
    process.exitCode = 1
  })
}
