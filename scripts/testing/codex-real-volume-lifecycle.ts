// Real-daemon cases remain unrun. Independent guest qualification and an
// external bounded guest driver are mandatory; see the accompanying report.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ManagedRuntimeOwner } from './runtime-sandbox.js'
import { captureInitialProviderVolumes, cleanupInitialProviderVolumes } from './initial-provider-volume.js'
import type { InitialProviderVolumeAuthorization } from './runtime-test-broker.js'
import { cleanupManagedCodexParity, managedCodexCleanupDependencies } from '../../test/helpers/codex-managed-cleanup.js'

type Captured = ReturnType<typeof captureInitialProviderVolumes>
type Fixture = {
  owner: InitialProviderVolumeAuthorization
  labels: Record<string, string>
  // Set only after an absent exact name was observed and creation was attempted.
  attempted: boolean
  captured?: Captured
}
type Attachment = { name: string; volume: string; runId: string; id?: string }
type CasePhase = 'owner_setup' | 'prepare' | 'fixture_setup' | 'fixture_absence' | 'fixture_create' | 'fixture_capture'
  | 'changed_owner' | 'attachment_create' | 'attached' | 'unreserved_setup' | 'unreserved_cleanup'
  | 'unreserved_stop_calls' | 'unreserved_before_stop' | 'unreserved_after_stop' | 'unreserved_final_absence'
  | 'unproven_capture'
type State = {
  rig: ManagedRuntimeOwner
  fixtures: Fixture[]
  attachments: Attachment[]
  stopped: boolean
  caseProgress: { phase: CasePhase; observed?: boolean | number }
}
type CleanupFailure =
  | { phase: 'attachment_remove' | 'volume_capture' | 'volume_remove' | 'volume_observation' | 'cleanup'; kind: 'exception' }
  | { phase: 'owner_stop'; kind: 'reported_failure' | 'exception' }
  | { phase: 'volume_retention'; kind: 'unconfirmed' }
type OperationStatus = 'not_started' | 'succeeded' | 'failed'

function eventLine(name: string, fields: Record<string, unknown>): string {
  const severity = /failure|failed|recovery_required/.test(name) ? 'error' : 'info'
  return `${JSON.stringify({ severity, event: name, ...fields })}\n`
}

function event(name: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(eventLine(name, fields))
}

// Use the same ordered stream as ordinary events and wait until the identity
// has reached its destination before an operation can create the resource.
function recoveryIdentity(name: string, fields: Record<string, unknown>): Promise<void> {
  const data = eventLine(name, fields)
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    process.stdout.once('error', onError)
    try {
      process.stdout.write(data, error => {
        if (error) {
          // Writable streams emit their error after the write callback.
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

function caseProgress(state: State, phase: CasePhase, observed?: boolean | number): void {
  state.caseProgress = observed === undefined ? { phase } : { phase, observed }
}

// Do not include Docker stderr, process environments, or command strings in
// the structured evidence. The driver retains only independently reviewed,
// fixed-field observations and the ordinary test outcome.
function docker(operation: string, args: string[]): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    }).trim()
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null }
    event('real_volume.docker_failure', { operation, status: failure.status ?? null, signal: failure.signal ?? null })
    throw new Error(`fixture Docker operation failed: ${operation}`)
  }
}

function childOf(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** This is a second check, never a substitute for independent qualification. */
function requireQualifiedGuest(): { repo: string; daemonId: string } {
  if (process.env.FRESHELL_TASK4_GUEST_QUALIFIED !== '1') throw new Error('qualified guest receipt required')
  const expectedRepo = process.env.FRESHELL_TASK4_SOURCE_ROOT
  const taskRoot = process.env.FRESHELL_TASK4_PRIVATE_ROOT
  const socket = process.env.FRESHELL_TASK4_DOCKER_SOCKET
  const expectedDaemonId = process.env.FRESHELL_TASK4_DAEMON_ID
  const expectedCli = process.env.FRESHELL_TASK4_DOCKER_CLI
  if (!expectedRepo || !taskRoot || !socket || !expectedDaemonId || !expectedCli
    || !path.isAbsolute(socket) || !path.isAbsolute(expectedCli)) {
    throw new Error('qualified source, private root, Docker CLI, socket and daemon identity are required')
  }
  const repo = fs.realpathSync(path.resolve(import.meta.dirname, '../..'))
  if (fs.realpathSync(expectedRepo) !== repo || fs.realpathSync(process.cwd()) !== repo) {
    throw new Error('invoke from the qualified source worktree')
  }
  const privateRoot = fs.realpathSync(taskRoot)
  for (const key of ['HOME', 'TMPDIR', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    const value = process.env[key]
    if (!value || !childOf(privateRoot, fs.realpathSync(value))) throw new Error(`private ${key} is required`)
  }
  if (fs.readdirSync(process.env.DOCKER_CONFIG!).length !== 0) throw new Error('Docker config must start empty')
  if (process.env.DOCKER_HOST !== `unix://${socket}` || process.env.DOCKER_CONTEXT
    || process.env.DOCKER_CERT_PATH || process.env.DOCKER_TLS_VERIFY || !fs.statSync(socket).isSocket()) {
    throw new Error('exact qualified Unix daemon socket required')
  }
  const dockerInPath = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'docker'))
    .find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile() } catch { return false }
    })
  if (!dockerInPath || fs.realpathSync(dockerInPath) !== fs.realpathSync(expectedCli)) {
    throw new Error('qualified real Docker CLI must be first on PATH')
  }
  const daemonId = docker('daemon_id', ['info', '--format', '{{.ID}}'])
  const security = JSON.parse(docker('daemon_security', ['info', '--format', '{{json .SecurityOptions}}']))
  if (daemonId !== expectedDaemonId || !Array.isArray(security)
    || !security.some(value => typeof value === 'string' && /rootless/i.test(value))) {
    throw new Error('qualified rootless daemon identity changed')
  }
  event('real_volume.preflight', { daemonId, socket })
  return { repo, daemonId }
}

function volumeExists(name: string): boolean {
  const names = docker('volume_list', ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])
  return names.split('\n').includes(name)
}

function requireDaemon(expected: string): void {
  if (docker('daemon_identity', ['info', '--format', '{{.ID}}']) !== expected) {
    throw new Error('fixture daemon identity changed; retain ownership for recovery')
  }
}

function volumeExistsOnExpectedDaemon(name: string, daemonId: string): boolean {
  requireDaemon(daemonId)
  const exists = volumeExists(name)
  requireDaemon(daemonId)
  return exists
}

function inspectVolume(name: string): { Name: string; Driver: string; Options: unknown; Labels: Record<string, string> } {
  return JSON.parse(docker('volume_inspect', ['volume', 'inspect', name, '--format', '{{json .}}']))
}

function assertLabels(fixture: Fixture): void {
  const actual = inspectVolume(fixture.owner.providerVolumeName)
  assert.equal(actual.Name, fixture.owner.providerVolumeName)
  assert.equal(actual.Driver, 'local')
  assert.ok(actual.Options === null || (typeof actual.Options === 'object' && Object.keys(actual.Options as object).length === 0))
  assert.deepEqual(actual.Labels, fixture.labels)
}

async function createFixture(state: State, daemonId: string): Promise<Fixture> {
  caseProgress(state, 'fixture_setup')
  const installationId = `task4-${randomUUID()}`
  const soulId = `task4-${randomUUID()}`
  const providerVolumeName = `freshell-provider-${createHash('sha256')
    .update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}`
  const hostBinaryPath = state.rig.runtime.testHostBinary
  const owner: InitialProviderVolumeAuthorization = {
    installationId, soulId, providerVolumeName, imageRef: state.rig.runtime.imageRef,
    hostBinaryPath, binarySha256: createHash('sha256').update(fs.readFileSync(hostBinaryPath)).digest('hex'), daemonId,
  }
  state.rig.runtime.broker.authorizeInitialProviderVolume(owner)
  assert.ok(!state.rig.runtime.broker.initialProviderVolumeCreations().some(value => value.providerVolumeName === providerVolumeName))
  const labels = {
    'com.freshell.installation-id': installationId,
    'com.freshell.soul-id': soulId,
    'freshell.input.daemon': daemonId,
    'freshell.input.image': owner.imageRef,
    'freshell.input.binary-sha256': owner.binarySha256,
    'freshell.input.intent': '1',
    'freshell.input.reservation': randomUUID(),
    'freshell.input.incarnation': `task4-${randomUUID()}`,
  }
  const fixture: Fixture = { owner, labels, attempted: false }
  state.fixtures.push(fixture)
  caseProgress(state, 'fixture_absence')
  const exists = volumeExistsOnExpectedDaemon(providerVolumeName, daemonId)
  caseProgress(state, 'fixture_absence', exists)
  assert.equal(exists, false, 'never adopt a pre-existing volume')
  caseProgress(state, 'fixture_create')
  await recoveryIdentity('real_volume.volume_attempt', { daemonId, volume: providerVolumeName, labels, operation: 'create' })
  fixture.attempted = true
  const created = docker('volume_create', ['volume', 'create', '--driver', 'local',
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), providerVolumeName])
  assert.equal(created, providerVolumeName)
  assertLabels(fixture)
  caseProgress(state, 'fixture_capture')
  fixture.captured = captureInitialProviderVolumes([owner])
  assert.equal(fixture.captured.length, 1)
  event('real_volume.created_unreserved', { daemonId, volume: providerVolumeName, labels })
  return fixture
}

function removeCaptured(fixture: Fixture): void {
  assert.ok(fixture.captured)
  assert.deepEqual(cleanupInitialProviderVolumes(fixture.captured), [fixture.owner.providerVolumeName])
  assert.equal(volumeExistsOnExpectedDaemon(fixture.owner.providerVolumeName, fixture.owner.daemonId), false)
  fixture.attempted = false
}

function attachmentId(attachment: Attachment): string | undefined {
  const rows = docker('container_list', ['container', 'ls', '-a', '--no-trunc', '--filter', `name=^/${attachment.name}$`, '--format', '{{.ID}}'])
    .split('\n').filter(Boolean)
  assert.ok(rows.length <= 1)
  return rows[0]
}

function removeAttachment(attachment: Attachment): void {
  const id = attachmentId(attachment)
  if (!id) {
    assert.equal(attachment.id, undefined, 'recorded attachment unexpectedly absent before verified removal')
    return
  }
  if (attachment.id) assert.equal(id, attachment.id)
  const inspected = JSON.parse(docker('container_inspect', ['container', 'inspect', id, '--format', '{{json .}}']))
  assert.equal(inspected.Id, id)
  assert.equal(inspected.Config.Labels['com.freshell.runtime-test-run-id'], attachment.runId)
  assert.equal(inspected.State.Running, false)
  assert.ok(inspected.Mounts.some((mount: { Name?: string; Destination?: string }) =>
    mount.Name === attachment.volume && mount.Destination === '/task4-volume'))
  assert.equal(docker('container_remove', ['container', 'rm', id]), id)
  assert.equal(attachmentId(attachment), undefined)
  attachment.id = undefined
}

function newState(repo: string): State {
  const rig = new ManagedRuntimeOwner(() => { throw new Error('no web server is needed for volume checks') }, repo)
  const state: State = { rig, fixtures: [], attachments: [], stopped: false, caseProgress: { phase: 'owner_setup' } }
  event('real_volume.owner_created', { runId: rig.runtime.runId, testRoot: rig.runtime.testRoot, evidenceDir: rig.runtime.evidenceDir })
  return state
}

export async function settle(state: State): Promise<void> {
  const failures: CleanupFailure[] = []
  const errors: unknown[] = []
  for (const attachment of state.attachments) {
    try { removeAttachment(attachment) }
    catch (error) {
      failures.push({ phase: 'attachment_remove', kind: 'exception' })
      errors.push(error)
    }
  }
  // A capture from an earlier operation cannot authorize fallback removal.
  // The shared cleanup takes a fresh, cumulatively bounded capture before
  // stopping the real owner, and removes only that fresh capture afterward.
  const attempted = state.fixtures.filter(fixture => fixture.attempted)
  for (const fixture of attempted) fixture.captured = undefined
  if (!state.stopped) {
    let captureStatus: OperationStatus = 'not_started'
    let captureDurationMs: number | null = null
    let ownerStatus: OperationStatus = 'not_started'
    let ownerDurationMs: number | null = null
    const rig = {
      runtime: state.rig.runtime,
      stop: async () => {
        const started = Date.now()
        try {
          const result = await state.rig.stop()
          state.stopped = result.ok
          ownerStatus = result.ok ? 'succeeded' : 'failed'
          if (!result.ok) failures.push({ phase: 'owner_stop', kind: 'reported_failure' })
          return result
        } catch (error) {
          ownerStatus = 'failed'
          failures.push({ phase: 'owner_stop', kind: 'exception' })
          throw error
        } finally {
          ownerDurationMs = Math.max(0, Date.now() - started)
        }
      },
    }
    const dependencies = {
      ...managedCodexCleanupDependencies,
      captureVolumes: (...args: Parameters<typeof managedCodexCleanupDependencies.captureVolumes>) => {
        const started = Date.now()
        try {
          const [owners, budgetMs] = args
          if (owners.length) {
            const daemonId = owners[0].daemonId
            if (owners.some(owner => owner.daemonId !== daemonId)) throw new Error('fixture owners use different daemons')
            requireDaemon(daemonId)
          }
          const remaining = budgetMs - Math.max(0, Date.now() - started)
          if (remaining <= 0) throw new Error('fixture volume capture exceeded its time budget')
          const captured = managedCodexCleanupDependencies.captureVolumes(owners, remaining)
          captureStatus = 'succeeded'
          return captured
        } catch (error) {
          captureStatus = 'failed'
          failures.push({ phase: 'volume_capture', kind: 'exception' })
          throw error
        } finally {
          captureDurationMs = Math.max(0, Date.now() - started)
        }
      },
      removeVolumes: (...args: Parameters<typeof managedCodexCleanupDependencies.removeVolumes>) => {
        try { return managedCodexCleanupDependencies.removeVolumes(...args) }
        catch (error) {
          failures.push({ phase: 'volume_remove', kind: 'exception' })
          throw error
        }
      },
    }
    const previousFailures = failures.length
    try {
      await cleanupManagedCodexParity({ rig, owners: attempted.map(fixture => fixture.owner), wire: undefined,
        model: undefined, finalObservation: undefined, naming: undefined, restoreGrants: undefined,
        grantsDirectory: undefined, home: undefined }, dependencies)
    } catch (error) {
      errors.push(error)
      if (failures.length === previousFailures) failures.push({ phase: 'cleanup', kind: 'exception' })
    }
    event('real_volume.fallback_settled', { captureStatus, captureDurationMs, ownerStatus, ownerDurationMs,
      ownerStopped: state.stopped })
  }
  if (state.stopped) {
    for (const fixture of attempted) {
      try {
        if (!volumeExistsOnExpectedDaemon(fixture.owner.providerVolumeName, fixture.owner.daemonId)) fixture.attempted = false
      } catch (error) {
        failures.push({ phase: 'volume_observation', kind: 'exception' })
        errors.push(error)
      }
    }
  }
  if (failures.length || state.fixtures.some(value => value.attempted)) {
    if (!failures.length) {
      failures.push({ phase: 'volume_retention', kind: 'unconfirmed' })
      errors.push(new Error('exact fixture volume remains for reviewed recovery'))
    }
    event('real_volume.recovery_required', {
      daemonId: state.fixtures[0]?.owner.daemonId ?? null,
      volumes: state.fixtures.filter(value => value.attempted).map(value => value.owner.providerVolumeName),
      attachments: state.attachments.map(value => ({ name: value.name, id: value.id ?? null })),
      ownerStopped: state.stopped,
      failures,
    })
    throw new AggregateError(errors, 'exact fixture cleanup or ownership remains unconfirmed')
  }
}

async function runVolumeCase(state: State, body: () => Promise<void>): Promise<void> {
  let caseFailed = false
  let caseError: unknown
  let cleanupFailed = false
  let cleanupError: unknown
  try { await body() } catch (error) { caseFailed = true; caseError = error }
  try { await settle(state) } catch (error) { cleanupFailed = true; cleanupError = error }
  if (caseFailed) {
    event('real_volume.case_failed', { failures: [{ ...state.caseProgress,
      kind: caseError instanceof assert.AssertionError ? 'assertion' : 'operation' }], ownerStopped: state.stopped })
  }
  if (caseFailed && cleanupFailed) throw new AggregateError([caseError, cleanupError], 'real volume case and cleanup failed')
  if (caseFailed) throw caseError
  if (cleanupFailed) throw cleanupError
}

export async function ownershipAndUnreserved(repo: string, daemonId: string): Promise<void> {
  const state = newState(repo)
  await runVolumeCase(state, async () => {
    caseProgress(state, 'prepare')
    await state.rig.runtime.prepare()
    const changed = await createFixture(state, daemonId)
    caseProgress(state, 'changed_owner')
    const previous = changed.captured!
    // Replace only the proven, unattached task-owned volume. Docker volume
    // labels are immutable; the replacement is a distinct owned fixture.
    assertLabels(changed)
    assert.deepEqual(cleanupInitialProviderVolumes(previous), [changed.owner.providerVolumeName])
    assert.equal(volumeExistsOnExpectedDaemon(changed.owner.providerVolumeName, daemonId), false)
    changed.labels = { ...changed.labels, 'freshell.input.reservation': randomUUID(), 'freshell.input.incarnation': `task4-${randomUUID()}` }
    await recoveryIdentity('real_volume.volume_attempt', { daemonId, volume: changed.owner.providerVolumeName,
      labels: changed.labels, operation: 'replace' })
    const replacement = docker('volume_replace', ['volume', 'create', '--driver', 'local',
      ...Object.entries(changed.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), changed.owner.providerVolumeName])
    assert.equal(replacement, changed.owner.providerVolumeName)
    assertLabels(changed)
    event('real_volume.replaced', { volume: changed.owner.providerVolumeName, labels: changed.labels })
    assert.throws(() => cleanupInitialProviderVolumes(previous), /changed; retain it/)
    assert.equal(volumeExists(changed.owner.providerVolumeName), true)
    assertLabels(changed)
    changed.captured = captureInitialProviderVolumes([changed.owner])
    assert.equal(changed.captured.length, 1)
    removeCaptured(changed)
    event('real_volume.case_passed', { case: 'changed_owner', volume: changed.owner.providerVolumeName })

    const attached = await createFixture(state, daemonId)
    caseProgress(state, 'attachment_create')
    const attachment: Attachment = { name: `task4-attachment-${randomUUID()}`, volume: attached.owner.providerVolumeName, runId: state.rig.runtime.runId }
    state.attachments.push(attachment)
    assert.equal(attachmentId(attachment), undefined)
    await recoveryIdentity('real_volume.attachment_attempt', { daemonId, name: attachment.name, volume: attachment.volume,
      runId: attachment.runId, labels: { 'com.freshell.runtime-test-run-id': attachment.runId } })
    const id = docker('container_create', ['container', 'create', '--name', attachment.name,
      '--label', `com.freshell.runtime-test-run-id=${attachment.runId}`,
      '--mount', `type=volume,source=${attachment.volume},target=/task4-volume`, state.rig.runtime.imageRef, 'sh', '-c', 'true'])
    assert.match(id, /^[a-f0-9]{64}$/)
    attachment.id = id
    await recoveryIdentity('real_volume.attachment_created', { daemonId, name: attachment.name, volume: attachment.volume,
      runId: attachment.runId, containerId: id })
    caseProgress(state, 'attached')
    assert.equal(attachmentId(attachment), id)
    const holders = docker('volume_holders', ['container', 'ls', '-a', '--no-trunc', '--filter', `volume=${attachment.volume}`, '--format', '{{.ID}}'])
    assert.ok(holders.split('\n').includes(id))
    assert.throws(() => cleanupInitialProviderVolumes(attached.captured!), /attached or changed; retain it/)
    assert.equal(volumeExists(attachment.volume), true)
    event('real_volume.attachment_refused', { containerId: id, volume: attachment.volume })
    removeAttachment(attachment)
    removeCaptured(attached)
    event('real_volume.case_passed', { case: 'attached', volume: attachment.volume })

    const unreserved = await createFixture(state, daemonId)
    caseProgress(state, 'unreserved_setup')
    let beforeStop = false
    let afterStop = false
    let stopCalls = 0
    const rig = {
      runtime: state.rig.runtime,
      stop: async () => {
        stopCalls++
        beforeStop = volumeExists(unreserved.owner.providerVolumeName)
        const result = await state.rig.stop()
        state.stopped = result.ok
        afterStop = volumeExists(unreserved.owner.providerVolumeName)
        return result
      },
    }
    assert.equal(state.rig.runtime.broker.initialProviderVolumeCreations().length, 0)
    assert.equal(state.rig.runtime.broker.receipts().length, 0)
    caseProgress(state, 'unreserved_cleanup')
    await cleanupManagedCodexParity({ rig, owners: [unreserved.owner], wire: undefined, model: undefined,
      finalObservation: undefined, naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: undefined })
    caseProgress(state, 'unreserved_stop_calls', Math.min(stopCalls, 2))
    assert.equal(stopCalls, 1)
    caseProgress(state, 'unreserved_before_stop', beforeStop)
    assert.equal(beforeStop, true)
    caseProgress(state, 'unreserved_after_stop', afterStop)
    assert.equal(afterStop, true)
    caseProgress(state, 'unreserved_final_absence')
    const finalExists = volumeExistsOnExpectedDaemon(unreserved.owner.providerVolumeName, daemonId)
    caseProgress(state, 'unreserved_final_absence', finalExists)
    assert.equal(finalExists, false)
    unreserved.attempted = false
    event('real_volume.case_passed', { case: 'unreserved_outer_removal', volume: unreserved.owner.providerVolumeName,
      stopCalls, beforeStop, afterStop, finalExists: false, reservations: 0, receipts: 0 })
  })
}

async function unprovenCapture(repo: string, daemonId: string): Promise<void> {
  const state = newState(repo)
  await runVolumeCase(state, async () => {
    caseProgress(state, 'prepare')
    await state.rig.runtime.prepare()
    const fixture = await createFixture(state, daemonId)
    caseProgress(state, 'unproven_capture')
    // Preserve the valid capture before the actual owner removes its binary.
    const capture = fixture.captured!
    let stopCalls = 0
    const rig = {
      runtime: state.rig.runtime,
      stop: async () => {
        stopCalls++
        const result = await state.rig.stop()
        state.stopped = result.ok
        return result
      },
    }
    let failure: unknown
    try {
      await cleanupManagedCodexParity({ rig, owners: [{ ...fixture.owner, daemonId: `changed-${randomUUID()}` }],
        wire: undefined, model: undefined, finalObservation: undefined, naming: undefined, restoreGrants: undefined,
        grantsDirectory: undefined, home: undefined })
    } catch (error) { failure = error }
    assert.ok(failure instanceof AggregateError)
    assert.ok(failure.errors.some((error: unknown) => error instanceof Error && /artifact or daemon changed; retain it/.test(error.message)))
    assert.equal(stopCalls, 1)
    assert.equal(state.stopped, true)
    assert.equal(volumeExists(fixture.owner.providerVolumeName), true)
    assertLabels(fixture)
    event('real_volume.capture_refused', { volume: fixture.owner.providerVolumeName,
      reason: 'artifact_or_daemon_changed', stopCalls, ownerStopped: state.stopped, retained: true })
    fixture.captured = capture
    removeCaptured(fixture)
    event('real_volume.case_passed', { case: 'unproven_capture_owner_stop', volume: fixture.owner.providerVolumeName, stopCalls })
  })
}

let executablePhase: 'preflight' | 'ownership_and_unreserved' | 'unproven_capture' = 'preflight'

async function main(): Promise<void> {
  const { repo, daemonId } = requireQualifiedGuest()
  executablePhase = 'ownership_and_unreserved'
  await ownershipAndUnreserved(repo, daemonId)
  executablePhase = 'unproven_capture'
  await unprovenCapture(repo, daemonId)
  event('real_volume.completed', { passedCases: 4, daemonId })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // No raw Docker stderr, daemon response, command, or environment in metadata.
    event('real_volume.failed', { phase: executablePhase,
      errorKind: error instanceof assert.AssertionError ? 'assertion' : 'operation' })
    process.exitCode = 1
  })
}
