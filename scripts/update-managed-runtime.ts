import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type ManagedUpdateMode = 'client' | 'all' | 'durable-only'
export const WEB_UNIT = 'freshell-rust.service'
export const SUPERVISOR_UNIT = 'freshell-supervisor.service'
export const UPDATE_UNIT_PREFIX = 'freshell-update-managed-runtime-'
export const UPDATE_LOCK_NAME = 'freshell-update-managed-runtime.lock'
export const DEFAULT_UPDATE_REMINDER =
  'The supervisor and managed coding sessions were not restarted. Reset-capable updates require the exact word APPROVED.'
export const RESET_UPDATE_REMINDER =
  'This reset-capable update will stop managed coding sessions and attempt to reopen saved conversations after the runtime update.'
const OPERATOR_SHELL_GUIDANCE =
  'Run this command from a host shell. Freshell-managed panes run inside soul containers and do not own the host systemd user manager or deployment checkout.'
const GRAPH_REFUSAL =
  'The loaded systemd unit relationships could make a web action start, restart, or stop the durable supervisor. Deploy the ordering-only After= unit change and run systemctl --user daemon-reload before retrying.'
const MANUAL_RECOVERY =
  'The update did not finish cleanly. Preserve registry, provider/history, runtime, and workspace data, then use the selected owner’s forward-recovery runbook. Reopen any saved conversations manually if needed.'
const SHUTDOWN_GATE_RECOVERY =
  'Host-agent admission may still be closed. Do not restart or reopen it while the old web process may be alive; verify that process and maintenance status, then use forward recovery.'
const TEMPORARY_GATE_RECOVERY =
  'The temporary host-agent admission lease may still be active. Verify release or expiry before retrying the update.'
const CODING_PROVIDERS = new Set(['claude', 'kilroy', 'codex', 'opencode', 'amplifier'])
const ACTIVE_LAUNCH_STATES = new Set(['prepared', 'created', 'starting', 'running', 'stopping'])
const GRAPH_PROPERTIES = [
  'Requires', 'Wants', 'Requisite', 'PartOf', 'BindsTo', 'Upholds', 'PropagatesStopTo',
  'ConsistsOf', 'BoundBy', 'UpheldBy', 'StopPropagatedFrom',
]
const PATH_FIELDS: Array<keyof ManagedRuntimeOwner> = [
  'checkoutRoot', 'webExecutable', 'supervisorExecutable', 'adminCli', 'sessionHostBinary',
  'clientDirectory', 'dockerSocket', 'controlSocket', 'controlSecretFile', 'registryRoot',
  'callbackSocket', 'runtimeRoot', 'imageEnvironmentFile', 'databasePath', 'environmentFile',
]

export interface RuntimeView {
  soulId: string
  incarnationId: string
  launchState: string
  cleanupState: string
  intentRevision: number
  desiredState: string
  provider?: string | null
  nativeSessionId?: string | null
  terminalResumeSessionId?: string | null
  freshAgentSessionId?: string | null
  [key: string]: unknown
}

export interface NoRuntimeInventoryRecord {
  soulId: string
  desiredState: string
  intentRevision: number
  outcome: 'verified_empty' | 'unresolved'
}

export type InventorySnapshot = RuntimeView[] | {
  views: RuntimeView[]
  noRuntime?: NoRuntimeInventoryRecord[]
}

export type StopResult =
  | { outcome: 'verified_empty'; view: RuntimeView }
  | { outcome: 'blocked_ownership' | 'backend_unavailable' | 'termination_unconfirmed'; view?: RuntimeView; message?: string }

export interface ManagedCodingSoulResetTarget {
  soulId: string
  expectedIntentRevision: number
  provider: string
  addressedView: RuntimeView
}

export interface ReopenCandidate {
  soulId: string
  expectedIntentRevision: number
  provider: string
  conversation:
    | { kind: 'fresh_agent'; sessionId: string }
    | { kind: 'terminal'; nativeSessionId: string; resumeSessionId?: string }
}

export type ReopenResult =
  | { outcome: 'reopened'; candidate: ReopenCandidate; message?: string }
  | { outcome: 'pending'; candidate: ReopenCandidate; message?: string }
  | { outcome: 'failed'; candidate: ReopenCandidate; message?: string }
  | { outcome: 'unavailable'; soulId: string; provider: string; message: string }

export interface ManagedRuntimeOwner {
  checkoutRoot: string
  webUnit: string
  supervisorUnit: string
  webExecutable: string
  supervisorExecutable: string
  adminCli: string
  sessionHostBinary: string
  clientDirectory: string
  dockerSocket: string
  controlSocket: string
  callbackSocket: string
  controlSecretFile: string
  registryRoot: string
  runtimeRoot: string
  providerRoot?: string
  providerRoots?: string[]
  workspaceRoot?: string
  workspaceRoots?: string[]
  imageEnvironmentFile: string
  environmentFile: string
  imageReference: string
  databasePath: string
  callbackAddress: string
  dockerDaemonId?: string
  webMainPid?: number
  supervisorMainPid?: number
}

export interface StagedArtifacts {
  stagingRoot?: string
  webExecutable?: string
  clientDirectory?: string
  supervisorExecutable?: string
  adminCli?: string
  sessionHostBinary?: string
  imageId?: string
}

export interface FileIdentity {
  path: string
  device: number
  inode: number
}

export interface UpdatePaths {
  checkoutRoot: string
  home: string
  runtimeDirectory: string
  node: string
  tsxLoader: string
  updaterScript: string
  env: string
  flock: string
  systemdRun: string
  systemctl: string
  pnpm: string
  cargo: string
  docker: string
  sqlite: string
  toolPath: string
  pnpmHome?: string
  cargoHome?: string
  rustupHome?: string
  cargoTargetDirectory?: string
}

export interface SystemdUnitGraph {
  units: Record<string, Partial<Record<(typeof GRAPH_PROPERTIES)[number], string[]>>>
}

export interface TransientServiceRequest {
  id: string
  unit: string
  workingDirectory: string
  args: string[]
  environment: Record<string, string>
  mode: ManagedUpdateMode
  logPath: string
  approvalFile?: string
}

export interface LockedWorkerRequest {
  lockPath: string
  command: string[]
  environment: Record<string, string>
}

export interface ManagedRuntimeUpdateDependencies {
  paths: UpdatePaths
  approval: {
    readLine(): Promise<string>
    create(content: string, mode: number): Promise<string>
    consume(filePath: string): Promise<boolean>
    remove(filePath: string): Promise<void>
  }
  handoff: {
    submit(request: TransientServiceRequest): Promise<number>
    runLockedWorker(request: LockedWorkerRequest): Promise<number>
  }
  owner: {
    resolve(mode: ManagedUpdateMode): Promise<ManagedRuntimeOwner>
    inspectGraph(owner: ManagedRuntimeOwner): Promise<SystemdUnitGraph>
    loadPersistentResourceManifest(owner: ManagedRuntimeOwner, mode: ManagedUpdateMode): Promise<void>
  }
  artifacts: {
    build(owner: ManagedRuntimeOwner, mode: ManagedUpdateMode): Promise<StagedArtifacts>
    serverBuildInfo(executable: string): Promise<unknown>
  }
  filesystem: {
    webExecutableIdentity(path: string): Promise<{ live: FileIdentity | null; selected: FileIdentity | null }>
    installExecutable(source: string, target: string): Promise<void>
    swapClientDirectory(source: string, target: string): Promise<void>
    installImageReference(environmentFile: string, imageId: string): Promise<void>
  }
  services: {
    stop(unit: string): Promise<void>
    start(unit: string): Promise<void>
    restart(unit: string): Promise<void>
    isActive(unit: string): Promise<boolean>
    state(unit: string): Promise<string>
    waitSupervisorReady(
      owner: ManagedRuntimeOwner,
      expectedImageReference: string,
      previousIdentity: SupervisorIdentity,
    ): Promise<SupervisorIdentity>
    waitWebReady(owner: ManagedRuntimeOwner): Promise<void>
    waitWebStopped(owner: ManagedRuntimeOwner): Promise<void>
    waitCallbackReady(owner: ManagedRuntimeOwner): Promise<void>
  }
  admin: {
    candidateSchemaVersion(supervisorExecutable: string): Promise<number>
    currentSchemaVersion(databasePath: string): Promise<number>
    health(owner: ManagedRuntimeOwner): Promise<{ state: 'ok'; installationId: string; controlEpoch: number }>
    inventory(owner: ManagedRuntimeOwner): Promise<RuntimeView[]>
    maintenanceInventory(supervisorExecutable: string, databasePath: string): Promise<NoRuntimeInventoryRecord[]>
    stop(soulId: string, expectedIntentRevision: number, owner: ManagedRuntimeOwner): Promise<StopResult>
    reopen(candidate: ReopenCandidate, owner: ManagedRuntimeOwner): Promise<{ outcome: 'reopened' | 'pending' | 'failed'; message?: string }>
  }
  runtimeApi: {
    readAuthToken(owner: ManagedRuntimeOwner): Promise<string>
    request(
      owner: ManagedRuntimeOwner,
      token: string,
      method: 'GET' | 'POST',
      endpoint: string,
      body?: unknown,
    ): Promise<{ status: number; body: unknown }>
  }
  docker: {
    buildImage(owner: ManagedRuntimeOwner, dockerSocket: string): Promise<string>
    verifyDaemon(owner: ManagedRuntimeOwner, dockerSocket: string): Promise<void>
  }
  logger: {
    event(event: Record<string, unknown>): Promise<void>
    operator(line: string): Promise<void>
  }
  now(): Date
  randomSuffix(): string
}

class UpdateRefusal extends Error {}
class UpdateFailure extends Error {}

class ClientDirectoryActivationFailure extends UpdateFailure {
  constructor(message: string, readonly priorDirectoryRestored: boolean) {
    super(message)
  }
}

interface WorkerExecutionState {
  mode: ManagedUpdateMode
  phase: string
  owner?: ManagedRuntimeOwner
  stagedArtifacts?: StagedArtifacts
  webStopAttempted: boolean
  supervisorShutdownComplete: boolean
  supervisorShutdownAttempted: boolean
  supervisorStateAfterStopFailure?: string
  filesInstalled: boolean
  resetTargets: ManagedCodingSoulResetTarget[]
  attemptedStops: string[]
  verifiedEmptyStops: string[]
  stoppedIntentRevisions: Map<string, number>
  preUpdateSupervisorIdentity?: SupervisorIdentity
  postUpdateSupervisorIdentity?: SupervisorIdentity
  maintenanceLease?: MaintenanceLease
  postStartOwnership?: PostStartOwnershipSummary
  shutdownGateState: 'open' | 'temporary' | 'latched' | 'unknown'
  shutdownCommitAttempted: boolean
  webProcessExitConfirmed: boolean
  webRestoreBlocked?: 'client_directory_restore_failed' | 'client_directory_activation_failed' | 'mixed_client_server_versions'
}

interface SupervisorIdentity {
  installationId: string
  controlEpoch: number
}

interface MaintenanceLease {
  ownerId: string
  leaseId: string
}

type NonDurableOwnership = 'host-managed' | 'unknown'

interface PostStartPaneOwnership {
  client_id: string
  tab_id: string
  pane_id: string
  kind: string
  ownership: NonDurableOwnership
  running_status: 'running' | 'unknown'
  provider?: string
  terminal_id?: string
  session_id?: string
}

interface PostStartProcessOwnership {
  kind: string
  ownership: NonDurableOwnership
  running_status: 'running' | 'unknown'
  provider?: string
  terminal_id?: string
  session_id?: string
}

interface PostStartOwnershipSummary {
  observed_after_replacement_startup: true
  outside_durable_soul_ownership: true
  protected_or_migrated_by_updater: false
  covered_by_prior_maintenance_lease: false
  panes: PostStartPaneOwnership[]
  unattached_processes: PostStartProcessOwnership[]
}

interface ReadinessReport {
  identity: SupervisorIdentity
  readiness: Record<string, unknown>
  paneOwnership: Record<string, unknown>
}

function createWorkerExecutionState(mode: ManagedUpdateMode): WorkerExecutionState {
  return {
    mode,
    phase: 'approval',
    webStopAttempted: false,
    supervisorShutdownComplete: false,
    supervisorShutdownAttempted: false,
    filesInstalled: false,
    resetTargets: [],
    attemptedStops: [],
    verifiedEmptyStops: [],
    stoppedIntentRevisions: new Map(),
    shutdownGateState: 'open',
    shutdownCommitAttempted: false,
    webProcessExitConfirmed: false,
  }
}

export function parseManagedUpdateMode(args: string[]): ManagedUpdateMode | null {
  if (args.length === 0) return 'client'
  if (args.length !== 1) return null
  if (args[0] === '--all') return 'all'
  if (args[0] === '--durable-only') return 'durable-only'
  return null
}

export async function runManagedRuntimeUpdate(
  args: string[],
  dependencies: ManagedRuntimeUpdateDependencies,
): Promise<number> {
  const mode = parseManagedUpdateMode(args)
  if (!mode) return 2

  await dependencies.logger.operator(OPERATOR_SHELL_GUIDANCE)
  const approval = await obtainResetApproval(mode, dependencies)
  if (!approval.accepted) return 2

  try {
    const request = createTransientServiceRequest(mode, approval.file, dependencies)
    await printTransientServiceDetails(request, dependencies)
    return await submitTransientService(request, dependencies)
  } catch {
    await dependencies.logger.operator('The transient updater service could not be started.')
    return 1
  } finally {
    if (approval.file) await dependencies.approval.remove(approval.file).catch(() => undefined)
  }
}

async function obtainResetApproval(
  mode: ManagedUpdateMode,
  dependencies: ManagedRuntimeUpdateDependencies,
): Promise<{ accepted: true; file?: string } | { accepted: false }> {
  if (mode === 'client') return { accepted: true }
  await dependencies.logger.operator(`${RESET_UPDATE_REMINDER} Enter exactly APPROVED to continue.`)
  let approvalLine: string
  try {
    approvalLine = await dependencies.approval.readLine()
  } catch {
    await dependencies.logger.operator('Reset-capable update cancelled: approval input could not be read.')
    return { accepted: false }
  }
  if (approvalLine !== 'APPROVED') {
    await dependencies.logger.operator('Reset-capable update cancelled: enter exactly APPROVED to continue.')
    return { accepted: false }
  }
  try {
    const file = await dependencies.approval.create(`${approvalLine}\n`, 0o600)
    return { accepted: true, file }
  } catch {
    await dependencies.logger.operator('Reset-capable update cancelled: the one-use approval file could not be created.')
    return { accepted: false }
  }
}

function createTransientServiceRequest(
  mode: ManagedUpdateMode,
  approvalFile: string | undefined,
  dependencies: ManagedRuntimeUpdateDependencies,
): TransientServiceRequest {
  const id = makeUpdateId(dependencies.now(), dependencies.randomSuffix())
  const unit = `${UPDATE_UNIT_PREFIX}${id}.service`
  const logPath = path.join(dependencies.paths.home, '.freshell', 'logs', `managed-runtime-update-${id}.jsonl`)
  const environment = minimalEnvironment(dependencies.paths)
  const args = [
    '--user', `--unit=${unit}`, `--working-directory=${dependencies.paths.checkoutRoot}`, '--wait', '--',
    dependencies.paths.env, '-i', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    dependencies.paths.node, '--import', dependencies.paths.tsxLoader, dependencies.paths.updaterScript,
    '--bootstrap', '--mode', mode, '--unit-name', unit, '--run-id', id,
    ...(approvalFile ? ['--approval-file', approvalFile] : []),
  ]
  return { id, unit, workingDirectory: dependencies.paths.checkoutRoot, args, environment, mode, logPath, approvalFile }
}

async function printTransientServiceDetails(
  request: TransientServiceRequest,
  dependencies: ManagedRuntimeUpdateDependencies,
): Promise<void> {
  await dependencies.logger.operator(`Update unit: ${request.unit}`)
  await dependencies.logger.operator(`Status: systemctl --user status ${request.unit}`)
  await dependencies.logger.operator(`Journal: journalctl --user -u ${request.unit}`)
  await dependencies.logger.operator(`Durable log: ${request.logPath}`)
  await dependencies.logger.operator(request.mode === 'client' ? DEFAULT_UPDATE_REMINDER : RESET_UPDATE_REMINDER)
}

async function submitTransientService(
  request: TransientServiceRequest,
  dependencies: ManagedRuntimeUpdateDependencies,
): Promise<number> {
  return dependencies.handoff.submit(request)
}

export async function runManagedUpdateBootstrap(
  options: { mode: ManagedUpdateMode; unitName: string; runId: string; approvalFile?: string },
  dependencies: ManagedRuntimeUpdateDependencies,
): Promise<number> {
  const logPath = path.join(dependencies.paths.home, '.freshell', 'logs', `managed-runtime-update-${options.runId}.jsonl`)
  const lockPath = path.join(dependencies.paths.runtimeDirectory, UPDATE_LOCK_NAME)
  const environment = {
    ...minimalEnvironment(dependencies.paths),
    FRESHELL_UPDATE_LOG_PATH: logPath,
  }
  const command = [
    dependencies.paths.node, '--import', dependencies.paths.tsxLoader, dependencies.paths.updaterScript,
    '--worker', '--mode', options.mode, '--unit-name', options.unitName, '--run-id', options.runId,
    ...(options.approvalFile ? ['--approval-file', options.approvalFile] : []),
  ]
  let status: number
  try {
    status = await dependencies.handoff.runLockedWorker({ lockPath, command, environment })
  } catch {
    await dependencies.logger.event({
      event: 'update.bootstrap_failed', severity: 'error', mode: options.mode,
      phase: 'lock', error_code: 'update_lock_failed',
    })
    if (options.approvalFile) await dependencies.approval.remove(options.approvalFile).catch(() => undefined)
    return 1
  }
  if (status === 75) {
    await dependencies.logger.event({
      event: 'update.lock_contention', severity: 'error', mode: options.mode,
      phase: 'lock', error_code: 'update_lock_busy',
    })
  }
  if (options.approvalFile) await dependencies.approval.remove(options.approvalFile).catch(() => undefined)
  return status
}

export async function runManagedRuntimeWorker(
  mode: ManagedUpdateMode,
  dependencies: ManagedRuntimeUpdateDependencies,
  approvalFile?: string,
): Promise<number> {
  const execution = createWorkerExecutionState(mode)
  const resetMode = mode !== 'client'
  let authToken: string | undefined

  try {
    if (resetMode) {
      let approvalConsumed = false
      if (approvalFile) {
        try { approvalConsumed = await dependencies.approval.consume(approvalFile) }
        catch { approvalConsumed = false }
      }
      if (!approvalConsumed) {
        await record(dependencies, mode, 'approval', 'update.approval_refused', 'error', { error_code: 'approval_invalid' })
        return 2
      }
    }

    execution.phase = 'owner'
    const owner = await resolveManagedRuntimeOwner(dependencies, mode)
    execution.owner = owner
    validateOwner(owner, dependencies.paths.checkoutRoot)
    await record(dependencies, mode, execution.phase, 'update.owner_verified', 'info')

    execution.phase = 'graph'
    await assertWebActionsSafe(dependencies, owner, mode, execution.phase)

    execution.phase = 'live_readiness'
    authToken = await dependencies.runtimeApi.readAuthToken(owner)
    const initialReadiness = await readAuthenticatedReadiness(dependencies, owner, authToken, 'pre-update')
    assertReadinessForSafeShutdown(initialReadiness)
    execution.preUpdateSupervisorIdentity = initialReadiness.identity
    await record(dependencies, mode, execution.phase, 'update.live_ownership_verified', 'info')

    execution.phase = 'owner_resources'
    await dependencies.owner.loadPersistentResourceManifest(owner, mode)

    execution.phase = 'build'
    const artifacts = await dependencies.artifacts.build(owner, mode)
    execution.stagedArtifacts = artifacts
    validateStagedArtifacts(mode, artifacts)
    if (resetMode) {
      let candidateVersion: number
      let currentVersion: number
      try {
        candidateVersion = await dependencies.admin.candidateSchemaVersion(artifacts.supervisorExecutable!)
        currentVersion = await dependencies.admin.currentSchemaVersion(owner.databasePath)
      } catch (error) {
        if (error instanceof UpdateRefusal) throw error
        throw new UpdateRefusal('The candidate or installed managed registry schema could not be verified without changing service state.')
      }
      if (!Number.isInteger(candidateVersion) || candidateVersion !== currentVersion) {
        throw new UpdateRefusal(`Managed registry schema differs between candidate ${candidateVersion} and installation ${currentVersion}; use the existing verified-backup/upgrade procedure.`)
      }
      if (!isDigest(artifacts.imageId)) {
        throw new UpdateFailure('The managed workload image did not produce a verified immutable image ID.')
      }
    }

    execution.phase = 'candidate_build_info'
    const webCandidate = mode === 'durable-only' ? owner.webExecutable : artifacts.webExecutable!
    let buildInfo: unknown
    try {
      buildInfo = await dependencies.artifacts.serverBuildInfo(webCandidate)
    } catch {
      throw new UpdateRefusal('The selected web server candidate could not prove it was built with managed-runtime-v1.')
    }
    if (!isRecord(buildInfo) || buildInfo.managedRuntimeV1 !== true) {
      throw new UpdateRefusal('The selected web server candidate was not built with managed-runtime-v1.')
    }

    if (mode === 'durable-only') {
      execution.phase = 'web_binary_identity'
      const identity = await dependencies.filesystem.webExecutableIdentity(owner.webExecutable)
      if (!sameFileIdentity(identity.live, identity.selected)) {
        throw new UpdateRefusal('The running web executable does not match the selected on-disk executable by resolved path, device, and inode; no service was stopped.')
      }
    }

    execution.phase = 'maintenance_quiesce'
    const quiesce = await acquireMaintenanceLease(dependencies, owner, authToken, execution)
    assertSameIdentity(
      quiesce.readiness.identity,
      execution.preUpdateSupervisorIdentity,
      'The supervisor changed before host-agent shutdown was committed.',
    )

    execution.phase = 'graph_final'
    await assertWebActionsSafe(dependencies, owner, mode, execution.phase)

    execution.phase = 'maintenance_commit_stop'
    await commitMaintenanceLease(dependencies, owner, authToken, quiesce.lease, execution)

    return mode === 'client'
      ? await runClientUpdate(dependencies, owner, artifacts, execution, authToken, initialReadiness.identity)
      : await runResetUpdate(mode, dependencies, owner, artifacts, execution, execution.stoppedIntentRevisions, authToken)
  } catch (error) {
    if (execution.shutdownCommitAttempted && execution.shutdownGateState !== 'latched') {
      await reconcileAmbiguousCommit(dependencies, execution, authToken)
    } else if (execution.maintenanceLease && execution.shutdownGateState !== 'latched') {
      await releaseTemporaryLease(dependencies, execution, authToken)
    }
    return handleWorkerFailure(mode, dependencies, execution, error)
  } finally {
    await cleanupStagingArtifacts(execution.stagedArtifacts)
  }
}

async function resolveManagedRuntimeOwner(
  dependencies: ManagedRuntimeUpdateDependencies,
  mode: ManagedUpdateMode,
): Promise<ManagedRuntimeOwner> {
  try {
    return await dependencies.owner.resolve(mode)
  } catch (error) {
    if (error instanceof UpdateRefusal) throw error
    throw new UpdateRefusal('The selected managed-runtime owner could not be verified unambiguously.')
  }
}

const MAINTENANCE_LEASE_DURATION_MS = 60_000
const MAINTENANCE_DRAIN_TIMEOUT_MS = 10_000

async function readAuthenticatedReadiness(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  token: string,
  context: 'pre-update' | 'post-update',
): Promise<ReadinessReport> {
  const before = await directSupervisorIdentity(dependencies, owner)
  const response = await runtimeApiRequest(dependencies, owner, token, 'GET', '/api/runtime/readiness')
  const after = await directSupervisorIdentity(dependencies, owner)
  if (response.status !== 200) {
    if (context === 'pre-update') {
      throw new UpdateRefusal(
        'Authenticated /api/runtime/readiness is unavailable; the server may be legacy or missing the managed-runtime feature. No build or service changes have been made. Without this endpoint the updater cannot safely inventory open panes or bootstrap the install. Keep existing work running, save or port host-agent sessions, then use a separate deliberate approved recovery and verify readiness before describing agents as protected.',
      )
    }
    throw new UpdateRefusal('Authenticated live runtime readiness is unavailable after the update; inspect the current web service and supervisor state before recovery.')
  }
  const report = parseReadinessReport(response.body)
  assertSameIdentity(after, before, 'The supervisor changed while live runtime readiness was being checked.')
  assertSameIdentity(report.identity, before, 'Live runtime readiness did not match the selected supervisor control socket.')
  assertRuntimeReadiness(report)
  return report
}

async function acquireMaintenanceLease(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  token: string,
  execution: WorkerExecutionState,
): Promise<{ lease: MaintenanceLease; readiness: ReadinessReport }> {
  const ownerId = `updater-${makeUpdateId(dependencies.now(), dependencies.randomSuffix())}`
  const before = await directSupervisorIdentity(dependencies, owner)
  let response: { status: number; body: unknown }
  try {
    response = await runtimeApiRequest(dependencies, owner, token, 'POST', '/api/runtime/maintenance/quiesce', {
      ownerId,
      leaseDurationMs: MAINTENANCE_LEASE_DURATION_MS,
      drainTimeoutMs: MAINTENANCE_DRAIN_TIMEOUT_MS,
    })
  } catch {
    execution.shutdownGateState = 'unknown'
    await waitForUnreportedLeaseToExpire(dependencies, owner, token, ownerId, execution)
    throw new UpdateRefusal('The host-agent quiesce lease result was ambiguous; no service stop was submitted.')
  }
  const body = isRecord(response.body) ? response.body : {}
  const lease = parseLease(body.lease)
  if (lease && lease.ownerId === ownerId) {
    execution.maintenanceLease = lease
    execution.shutdownGateState = 'temporary'
  }
  const after = await directSupervisorIdentity(dependencies, owner)
  assertSameIdentity(after, before, 'The supervisor changed while host-agent admission was being quiesced.')

  if (!lease || lease.ownerId !== ownerId) {
    await waitForUnreportedLeaseToExpire(dependencies, owner, token, ownerId, execution)
    throw new UpdateRefusal('The host-agent quiesce response did not include this updater’s live lease.')
  }
  if (response.status !== 200 || body.drained !== true || body.readyToStop !== true) {
    if (isRecord(body.readiness)) {
      throw readinessBlockerRefusal(body.readiness, 'The final host-agent census blocks shutdown.')
    }
    throw new UpdateRefusal('Host-agent admission could not be quiesced and drained safely; no service stop was submitted.')
  }
  const readiness = parseReadinessReport(body.readiness)
  assertSameIdentity(readiness.identity, before, 'The final host-agent census did not match the selected supervisor.')
  assertReadinessForSafeShutdown(readiness)
  const admission = isRecord(body.admission) ? body.admission : {}
  if (admission.phase !== 'quiesced' || admission.activePermits !== 0) {
    throw new UpdateRefusal('The host-agent quiesce lease did not confirm that admission was closed and in-flight work drained.')
  }
  return { lease, readiness }
}

async function commitMaintenanceLease(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  token: string,
  lease: MaintenanceLease,
  execution: WorkerExecutionState,
): Promise<void> {
  const before = await directSupervisorIdentity(dependencies, owner)
  execution.shutdownCommitAttempted = true
  execution.shutdownGateState = 'unknown'
  let response: { status: number; body: unknown }
  try {
    response = await runtimeApiRequest(dependencies, owner, token, 'POST', '/api/runtime/maintenance/commit-stop', lease)
  } catch {
    throw new UpdateFailure('Host-agent shutdown commitment could not be confirmed; the updater did not stop the web service.')
  }
  const body = isRecord(response.body) ? response.body : {}
  if (response.status === 200 && body.committed === true) {
    execution.shutdownGateState = 'latched'
  } else if ([400, 401, 404, 409, 503].includes(response.status)
    || (response.status === 200 && body.committed === false)) {
    execution.shutdownCommitAttempted = false
    execution.shutdownGateState = 'temporary'
  } else {
    execution.shutdownGateState = 'temporary'
  }
  const after = await directSupervisorIdentity(dependencies, owner)
  assertSameIdentity(after, before, 'The supervisor changed while shutdown commitment was being checked.')
  if (response.status !== 200 || body.committed !== true) {
    if (isRecord(body.readiness)) {
      throw readinessBlockerRefusal(body.readiness, 'The final commit-stop census blocks shutdown.')
    }
    throw new UpdateRefusal('The host-agent shutdown lease was not committed; no service stop was submitted.')
  }
  const readiness = parseReadinessReport(body.readiness)
  assertSameIdentity(readiness.identity, before, 'The committed shutdown census did not match the selected supervisor.')
  assertReadinessForSafeShutdown(readiness)
  const admission = isRecord(body.admission) ? body.admission : {}
  if (admission.phase !== 'shutdown-latched') {
    throw new UpdateFailure('The shutdown lease response did not confirm that host-agent admission is latched closed.')
  }
  execution.maintenanceLease = lease
}

async function directSupervisorIdentity(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
): Promise<SupervisorIdentity> {
  try {
    const health = await dependencies.admin.health(owner)
    if (health.state !== 'ok') throw new Error('not healthy')
    return parseSupervisorIdentity(health)
  } catch {
    throw new UpdateRefusal('The selected supervisor control socket did not provide a usable Health identity.')
  }
}

async function runtimeApiRequest(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  token: string,
  method: 'GET' | 'POST',
  endpoint: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    return await dependencies.runtimeApi.request(owner, token, method, endpoint, body)
  } catch {
    throw new UpdateRefusal(`Authenticated runtime API request ${endpoint} failed.`)
  }
}

function parseReadinessReport(value: unknown): ReadinessReport {
  if (!isRecord(value) || !isRecord(value.readiness) || !isRecord(value.paneOwnership)) {
    throw new UpdateRefusal('Runtime readiness omitted supervisor identity, runtime scan state, or pane/process ownership.')
  }
  const identity = parseSupervisorIdentity(value)
  const paneOwnership = value.paneOwnership
  if (paneOwnership.complete !== true || !Array.isArray(paneOwnership.panes)
    || !Array.isArray(paneOwnership.unattachedProcesses) || typeof paneOwnership.readyToStop !== 'boolean') {
    throw new UpdateRefusal('Runtime readiness did not include a complete pane and process ownership census.')
  }
  for (const pane of paneOwnership.panes) {
    if (!isRecord(pane) || !nonEmpty(pane.clientId) || !nonEmpty(pane.tabId)
      || !nonEmpty(pane.paneId) || !nonEmpty(pane.kind) || !isPaneOwnership(pane.ownership)) {
      throw new UpdateRefusal('Runtime readiness contained an invalid pane ownership record.')
    }
  }
  for (const process of paneOwnership.unattachedProcesses) {
    if (!isRecord(process) || !nonEmpty(process.kind) || !nonEmpty(process.source)
      || !nonEmpty(process.reason) || !isPaneOwnership(process.ownership)) {
      throw new UpdateRefusal('Runtime readiness contained an invalid unattached-process ownership record.')
    }
  }
  return { identity, readiness: value.readiness, paneOwnership }
}

function parseSupervisorIdentity(value: unknown): SupervisorIdentity {
  if (!isRecord(value) || !nonEmpty(value.installationId)
    || !Number.isSafeInteger(value.controlEpoch) || Number(value.controlEpoch) < 0) {
    throw new UpdateRefusal('Supervisor Health or runtime readiness omitted a valid installationId/controlEpoch identity.')
  }
  return { installationId: value.installationId, controlEpoch: Number(value.controlEpoch) }
}

function parseLease(value: unknown): MaintenanceLease | undefined {
  if (!isRecord(value) || !nonEmpty(value.ownerId) || !nonEmpty(value.leaseId)) return undefined
  return { ownerId: value.ownerId, leaseId: value.leaseId }
}

function isPaneOwnership(value: unknown): value is 'durable' | 'host-managed' | 'unknown' {
  return value === 'durable' || value === 'host-managed' || value === 'unknown'
}

function assertSameIdentity(actual: SupervisorIdentity, expected: SupervisorIdentity | undefined, message: string): void {
  if (!expected || actual.installationId !== expected.installationId || actual.controlEpoch !== expected.controlEpoch) {
    throw new UpdateRefusal(message)
  }
}

function assertSupervisorRestarted(
  previous: SupervisorIdentity,
  current: SupervisorIdentity,
  message: string,
): void {
  if (current.installationId !== previous.installationId || current.controlEpoch <= previous.controlEpoch) {
    throw new UpdateFailure(message)
  }
}

export async function waitForSupervisorReadiness<T>(
  check: (remainingMs: () => number) => Promise<T | undefined>,
  options: {
    timeoutMs?: number
    intervalMs?: number
    timeoutMessage?: string | (() => string)
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = Math.max(1, options.intervalMs ?? 250)
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const result = await check(() => Math.max(1, deadline - Date.now()))
    if (result !== undefined) return result
    const afterCheckMs = deadline - Date.now()
    if (afterCheckMs <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, afterCheckMs)))
  }
  const message = options.timeoutMessage
    ?? 'The restarted managed-runtime supervisor did not become ready with its verified process and authenticated Health identity before the timeout.'
  throw new UpdateFailure(typeof message === 'function' ? message() : message)
}

function assertReadinessForSafeShutdown(report: ReadinessReport): void {
  assertRuntimeReadiness(report)
  const panes = report.paneOwnership.panes as unknown[]
  const unattached = report.paneOwnership.unattachedProcesses as unknown[]
  const blocked: string[] = []
  for (const pane of panes) {
    if (!isRecord(pane)) throw new UpdateRefusal('The pane ownership census contains an invalid pane record.')
    const ownership = pane.ownership
    if (ownership !== 'durable') {
      const paneId = safeIdentifier(pane.paneId)
      const kind = safeIdentifier(pane.kind)
      const classification = ownership === 'host-managed' ? 'host-managed' : 'unknown'
      blocked.push(`pane ${paneId} (${kind}, ${classification})`)
    }
  }
  for (const process of unattached) {
    if (!isRecord(process)) throw new UpdateRefusal('The process ownership census contains an invalid process record.')
    const kind = safeIdentifier(process.kind)
    const provider = safeIdentifier(process.provider)
    const terminalId = safeIdentifier(process.terminalId)
    const classification = process.ownership === 'host-managed' ? 'host-managed' : 'unknown'
    blocked.push(`unattached ${kind} ${provider} ${terminalId} (${classification})`)
  }
  if (blocked.length > 0) {
    throw new UpdateRefusal(`Host-managed, unknown, or unattached coding work prevents shutdown: ${blocked.join('; ')}`)
  }
  if (report.paneOwnership.readyToStop !== true) {
    throw new UpdateRefusal('Runtime readiness did not confirm that the current pane and process census is safe to stop.')
  }
}

function assertRuntimeReadiness(report: ReadinessReport): void {
  const blockedSubsystems = report.readiness.blockedSubsystems
  if (report.readiness.initialScanState !== 'complete' || !Array.isArray(blockedSubsystems) || blockedSubsystems.length > 0) {
    throw new UpdateRefusal('The managed runtime initial scan is incomplete or has blocked subsystems.')
  }
}

function readinessBlockerRefusal(value: unknown, fallback: string): UpdateRefusal {
  try {
    const report = parseReadinessReport(value)
    assertReadinessForSafeShutdown(report)
  } catch (error) {
    if (error instanceof UpdateRefusal) return error
  }
  return new UpdateRefusal(fallback)
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'unknown'
  const safe = value.trim().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80)
  return safe || 'unknown'
}

function optionalSafeIdentifier(value: unknown): string | undefined {
  return nonEmpty(value) ? safeIdentifier(value) : undefined
}

function summarizePostStartOwnership(report: ReadinessReport): PostStartOwnershipSummary | undefined {
  const panes: PostStartPaneOwnership[] = []
  for (const value of report.paneOwnership.panes as unknown[]) {
    if (!isRecord(value) || (value.ownership !== 'host-managed' && value.ownership !== 'unknown')) continue
    const provider = optionalSafeIdentifier(value.provider)
    const terminalId = optionalSafeIdentifier(value.terminalId)
    const sessionId = optionalSafeIdentifier(value.sessionId)
    panes.push({
      client_id: safeIdentifier(value.clientId),
      tab_id: safeIdentifier(value.tabId),
      pane_id: safeIdentifier(value.paneId),
      kind: safeIdentifier(value.kind),
      ownership: value.ownership,
      running_status: value.ownership === 'host-managed' ? 'running' : 'unknown',
      ...(provider ? { provider } : {}),
      ...(terminalId ? { terminal_id: terminalId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    })
  }

  const unattachedProcesses: PostStartProcessOwnership[] = []
  for (const value of report.paneOwnership.unattachedProcesses as unknown[]) {
    if (!isRecord(value) || (value.ownership !== 'host-managed' && value.ownership !== 'unknown')) continue
    const provider = optionalSafeIdentifier(value.provider)
    const terminalId = optionalSafeIdentifier(value.terminalId)
    const sessionId = optionalSafeIdentifier(value.sessionId)
    unattachedProcesses.push({
      kind: safeIdentifier(value.kind),
      ownership: value.ownership,
      running_status: value.ownership === 'host-managed' ? 'running' : 'unknown',
      ...(provider ? { provider } : {}),
      ...(terminalId ? { terminal_id: terminalId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    })
  }
  if (panes.length === 0 && unattachedProcesses.length === 0) return undefined
  return {
    observed_after_replacement_startup: true,
    outside_durable_soul_ownership: true,
    protected_or_migrated_by_updater: false,
    covered_by_prior_maintenance_lease: false,
    panes,
    unattached_processes: unattachedProcesses,
  }
}

function postStartOwnershipEventFields(summary?: PostStartOwnershipSummary): Record<string, unknown> {
  return summary ? { post_start_ownership: summary } : {}
}

async function reportPostStartOwnership(
  dependencies: ManagedRuntimeUpdateDependencies,
  summary?: PostStartOwnershipSummary,
): Promise<void> {
  if (!summary) return
  const rows = [
    ...summary.panes.map((pane) => `pane ${JSON.stringify(pane)}`),
    ...summary.unattached_processes.map((process) => `unattached process ${JSON.stringify(process)}`),
  ]
  const ownerships = [
    ...summary.panes.map((pane) => pane.ownership),
    ...summary.unattached_processes.map((process) => process.ownership),
  ]
  const ownershipStatuses = [
    ...(ownerships.includes('host-managed') ? ['Host-managed rows remain running.'] : []),
    ...(ownerships.includes('unknown') ? ['Running status for unknown rows is unconfirmed.'] : []),
  ].join(' ')
  await dependencies.logger.operator(
    'Post-start ownership notice: host-managed or unknown work was observed after replacement startup. '
    + 'These rows are outside durable-soul ownership and were not protected or migrated by this updater. '
    + (ownershipStatuses ? `${ownershipStatuses} ` : '')
    + 'They were not covered by the prior maintenance lease. '
    + rows.join('; '),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function releaseTemporaryLease(
  dependencies: ManagedRuntimeUpdateDependencies,
  execution: WorkerExecutionState,
  token: string | undefined,
): Promise<void> {
  const lease = execution.maintenanceLease
  const owner = execution.owner
  if (!lease || !owner || !token || execution.shutdownGateState === 'latched') return
  try {
    const response = await runtimeApiRequest(dependencies, owner, token, 'POST', '/api/runtime/maintenance/release', lease)
    const body = isRecord(response.body) ? response.body : {}
    const admission = isRecord(body.admission) ? body.admission : {}
    if (response.status === 200 && admission.phase === 'open') {
      execution.maintenanceLease = undefined
      execution.shutdownGateState = 'open'
      return
    }
  } catch { /* the temporary lease expires; a failed release never authorizes stop */ }
  execution.shutdownGateState = execution.shutdownGateState === 'unknown' ? 'unknown' : 'temporary'
  await record(dependencies, execution.mode, execution.phase, 'update.maintenance_lease_release_failed', 'error', {
    error_code: 'maintenance_lease_release_failed',
  })
}

async function reconcileAmbiguousCommit(
  dependencies: ManagedRuntimeUpdateDependencies,
  execution: WorkerExecutionState,
  token: string | undefined,
): Promise<void> {
  const owner = execution.owner
  const lease = execution.maintenanceLease
  if (!owner || !token) {
    execution.shutdownGateState = 'unknown'
    return
  }
  try {
    const status = await runtimeApiRequest(dependencies, owner, token, 'GET', '/api/runtime/maintenance/status')
    const body = isRecord(status.body) ? status.body : {}
    if (status.status !== 200) throw new Error('status unavailable')
    if (body.phase === 'shutdown-latched') {
      execution.shutdownGateState = 'latched'
      return
    }
    if (body.phase === 'quiesced' && lease && body.leaseOwner === lease.ownerId) {
      execution.shutdownGateState = 'temporary'
      await releaseTemporaryLease(dependencies, execution, token)
      return
    }
    if (body.phase === 'open') {
      execution.shutdownGateState = 'open'
      execution.maintenanceLease = undefined
      return
    }
  } catch { /* preserve a possible latch if the commit outcome cannot be recovered */ }
  execution.shutdownGateState = 'unknown'
}

async function waitForUnreportedLeaseToExpire(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  token: string,
  ownerId: string,
  execution: WorkerExecutionState,
): Promise<void> {
  execution.shutdownGateState = 'unknown'
  const deadline = Date.now() + MAINTENANCE_LEASE_DURATION_MS + 2_000
  while (Date.now() < deadline) {
    let status: { status: number; body: unknown }
    try {
      status = await runtimeApiRequest(dependencies, owner, token, 'GET', '/api/runtime/maintenance/status')
    } catch {
      return
    }
    const body = isRecord(status.body) ? status.body : {}
    if (status.status === 200 && body.phase === 'open') {
      execution.shutdownGateState = 'open'
      return
    }
    if (status.status === 200 && body.phase === 'shutdown-latched') {
      execution.shutdownGateState = 'latched'
      return
    }
    if (status.status === 200 && body.phase === 'quiesced' && body.leaseOwner === ownerId) {
      execution.shutdownGateState = 'temporary'
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    return
  }
  execution.shutdownGateState = 'unknown'
}

async function runClientUpdate(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  artifacts: StagedArtifacts,
  execution: WorkerExecutionState,
  authToken: string,
  expectedIdentity: SupervisorIdentity,
): Promise<number> {
  execution.phase = 'stop_web'
  execution.webStopAttempted = true
  await dependencies.services.stop(owner.webUnit)
  await dependencies.services.waitWebStopped(owner)
  markOldWebProcessExited(execution)
  await record(dependencies, 'client', execution.phase, 'update.web_stopped', 'info')

  execution.phase = 'install_web'
  execution.filesInstalled = true
  await dependencies.filesystem.installExecutable(artifacts.webExecutable!, owner.webExecutable)
  try {
    await dependencies.filesystem.swapClientDirectory(artifacts.clientDirectory!, owner.clientDirectory)
  } catch (error) {
    execution.webRestoreBlocked = error instanceof ClientDirectoryActivationFailure
      ? error.priorDirectoryRestored ? 'mixed_client_server_versions' : 'client_directory_restore_failed'
      : 'client_directory_activation_failed'
    const detail = describeClientDirectoryActivationFailure(error)
    throw new UpdateFailure(
      `${detail} The new server binary remains installed. The web service will remain stopped until the client and server artifacts are reconciled; manual recovery is required.`,
    )
  }

  execution.phase = 'start_web'
  await dependencies.services.start(owner.webUnit)
  execution.phase = 'web_readiness'
  await dependencies.services.waitWebReady(owner)
  await dependencies.services.waitCallbackReady(owner)
  const readiness = await readAuthenticatedReadiness(dependencies, owner, authToken, 'post-update')
  assertSameIdentity(readiness.identity, expectedIdentity, 'Default web-only update changed the durable supervisor identity.')
  execution.postUpdateSupervisorIdentity = readiness.identity
  execution.postStartOwnership = summarizePostStartOwnership(readiness)
  await record(dependencies, 'client', 'complete', 'update.completed', 'info', {
    reminder: DEFAULT_UPDATE_REMINDER,
    ...postStartOwnershipEventFields(execution.postStartOwnership),
  })
  await reportPostStartOwnership(dependencies, execution.postStartOwnership)
  await dependencies.logger.operator(DEFAULT_UPDATE_REMINDER)
  return 0
}

async function runResetUpdate(
  mode: Exclude<ManagedUpdateMode, 'client'>,
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  artifacts: StagedArtifacts,
  execution: WorkerExecutionState,
  stoppedIntentRevisions: Map<string, number>,
  authToken: string,
): Promise<number> {
  execution.phase = 'stop_web'
  execution.webStopAttempted = true
  await dependencies.services.stop(owner.webUnit)
  await dependencies.services.waitWebStopped(owner)
  markOldWebProcessExited(execution)
  await record(dependencies, mode, execution.phase, 'update.web_stopped', 'info')

  execution.phase = 'inventory'
  const views = await dependencies.admin.inventory(owner)
  const noRuntime = await dependencies.admin.maintenanceInventory(artifacts.supervisorExecutable!, owner.databasePath)
  const inventory: InventorySnapshot = { views, noRuntime }
  const groups = groupInventory(inventory)
  validateNoRuntimeSnapshot(noRuntime, groups)
  validatePreviouslyStoppedSouls(groups, inventory)
  execution.resetTargets = selectResetTargets(groups)
  await record(dependencies, mode, execution.phase, 'update.inventory_captured', 'info', {
    reset_target_count: execution.resetTargets.length,
  })

  await stopManagedCodingSouls(mode, dependencies, owner, execution, stoppedIntentRevisions)
  await replaceDurableRuntime(mode, dependencies, owner, artifacts, execution)
  await startUpdatedRuntime(mode, dependencies, owner, artifacts, execution, authToken)
  return reopenSavedConversations(mode, dependencies, owner, inventory, groups, execution, stoppedIntentRevisions)
}

async function stopManagedCodingSouls(
  mode: Exclude<ManagedUpdateMode, 'client'>,
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  execution: WorkerExecutionState,
  stoppedIntentRevisions: Map<string, number>,
): Promise<void> {
  execution.phase = 'stop_souls'
  for (const target of execution.resetTargets) {
    execution.attemptedStops.push(target.soulId)
    const result = await dependencies.admin.stop(target.soulId, target.expectedIntentRevision, owner)
    if (result.outcome !== 'verified_empty') {
      await record(dependencies, mode, execution.phase, 'update.stop_failed', 'error', {
        soul_id: target.soulId, outcome: result.outcome,
        attempted_prefix: execution.attemptedStops, verified_empty_stopped: execution.verifiedEmptyStops,
      })
      throw new UpdateFailure(`Stop for ${target.soulId} returned ${result.outcome}.`)
    }
    const stoppedView = result.view
    if (!stoppedView || stoppedView.soulId !== target.soulId || stoppedView.desiredState !== 'stopped'
      || stoppedView.incarnationId !== target.addressedView.incarnationId
      || stoppedView.launchState !== 'stopped' || stoppedView.cleanupState !== 'verified_empty'
      || !Number.isSafeInteger(stoppedView.intentRevision)
      || stoppedView.intentRevision <= target.expectedIntentRevision) {
      throw new UpdateFailure(`Stop for ${target.soulId} reported VerifiedEmpty without the addressed incarnation, stopped view, and advanced intent revision.`)
    }
    execution.verifiedEmptyStops.push(target.soulId)
    stoppedIntentRevisions.set(target.soulId, stoppedView.intentRevision)
    await record(dependencies, mode, execution.phase, 'update.stop_verified_empty', 'info', { soul_id: target.soulId })
  }
  await record(dependencies, mode, execution.phase, 'update.stop_batch_complete', 'info', {
    attempted_prefix: execution.attemptedStops, verified_empty_stopped: execution.verifiedEmptyStops,
  })
}

async function replaceDurableRuntime(
  mode: Exclude<ManagedUpdateMode, 'client'>,
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  artifacts: StagedArtifacts,
  execution: WorkerExecutionState,
): Promise<void> {
  execution.phase = 'stop_supervisor'
  execution.supervisorShutdownAttempted = true
  try {
    await dependencies.services.stop(owner.supervisorUnit)
  } catch (error) {
    let unitState = 'unknown'
    try { unitState = await dependencies.services.state(owner.supervisorUnit) } catch { /* report unknown state */ }
    execution.supervisorStateAfterStopFailure = unitState
    execution.supervisorShutdownComplete = unitState !== 'active'
    await record(dependencies, mode, execution.phase, 'update.supervisor_stop_failed', 'error', {
      error_code: 'supervisor_stop_failed', unit_state: unitState, partial_state: true,
      manual_recovery: MANUAL_RECOVERY,
    })
    throw error
  }
  execution.supervisorShutdownComplete = true
  await record(dependencies, mode, execution.phase, 'update.supervisor_stopped', 'info')

  execution.phase = 'install_durable'
  execution.filesInstalled = true
  await dependencies.filesystem.installExecutable(artifacts.supervisorExecutable!, owner.supervisorExecutable)
  await dependencies.filesystem.installExecutable(artifacts.adminCli!, owner.adminCli)
  await dependencies.filesystem.installExecutable(artifacts.sessionHostBinary!, owner.sessionHostBinary)
  await dependencies.filesystem.installImageReference(owner.imageEnvironmentFile, artifacts.imageId!)
  if (mode === 'all') {
    await dependencies.filesystem.installExecutable(artifacts.webExecutable!, owner.webExecutable)
    try {
      await dependencies.filesystem.swapClientDirectory(artifacts.clientDirectory!, owner.clientDirectory)
    } catch (error) {
      const detail = describeClientDirectoryActivationFailure(error)
      throw new UpdateFailure(
        `${detail} The new managed-runtime binaries, workload image reference, and web server binary remain installed. The supervisor and web services remain stopped until the client and server artifacts are reconciled; manual recovery is required.`,
      )
    }
  }
}

async function startUpdatedRuntime(
  mode: Exclude<ManagedUpdateMode, 'client'>,
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  artifacts: StagedArtifacts,
  execution: WorkerExecutionState,
  authToken: string,
): Promise<void> {
  execution.phase = 'start_supervisor'
  await dependencies.services.start(owner.supervisorUnit)
  const previousIdentity = execution.preUpdateSupervisorIdentity
  if (!previousIdentity) throw new UpdateFailure('The pre-update supervisor identity was not retained for restart verification.')
  const supervisorIdentity = await dependencies.services.waitSupervisorReady(owner, artifacts.imageId!, previousIdentity)
  assertSupervisorRestarted(
    previousIdentity, supervisorIdentity,
    'The systemd supervisor did not advance to a new control epoch after restart.',
  )
  execution.postUpdateSupervisorIdentity = supervisorIdentity

  execution.phase = 'start_web'
  await dependencies.services.start(owner.webUnit)
  await dependencies.services.waitWebReady(owner)
  await dependencies.services.waitCallbackReady(owner)
  const readiness = await readAuthenticatedReadiness(dependencies, owner, authToken, 'post-update')
  assertSameIdentity(readiness.identity, supervisorIdentity, 'Updated web readiness did not match the deliberately restarted supervisor.')
  execution.postUpdateSupervisorIdentity = readiness.identity
  execution.postStartOwnership = summarizePostStartOwnership(readiness)
}

async function reopenSavedConversations(
  mode: Exclude<ManagedUpdateMode, 'client'>,
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  inventory: InventorySnapshot,
  groups: Map<string, RuntimeView[]>,
  execution: WorkerExecutionState,
  stoppedIntentRevisions: Map<string, number>,
): Promise<number> {
  execution.phase = 'reopen'
  const refs = collectReopenWork(inventory, groups, execution.resetTargets, stoppedIntentRevisions)
  await record(dependencies, mode, execution.phase, 'update.reopen_inventory_summary', 'info', {
    no_reference_count: refs.noReferenceCount,
    ineligible_reference_count: refs.ineligibleReferenceCount,
    unavailable_count: refs.unavailable.length,
    eligible_count: refs.candidates.length,
  })
  const reopenResults: ReopenResult[] = []
  for (const item of refs.unavailable) {
    reopenResults.push({
      outcome: 'unavailable', soulId: item.soulId, provider: item.provider,
      message: 'Saved resumable context has no required native session identity.',
    })
    await record(dependencies, mode, execution.phase, 'update.reopen_result', 'error', {
      soul_id: item.soulId, provider: item.provider, outcome: 'unavailable',
      reason: 'missing_native_session_identity',
    })
  }
  for (const candidate of refs.candidates) {
    let result: { outcome: 'reopened' | 'pending' | 'failed'; message?: string }
    try {
      result = await dependencies.admin.reopen(candidate, owner)
    } catch {
      result = { outcome: 'failed', message: 'Supervisor Reopen request failed.' }
    }
    reopenResults.push({ ...result, candidate })
    await record(dependencies, mode, execution.phase, 'update.reopen_result', result.outcome === 'reopened' ? 'info' : 'error', {
      soul_id: candidate.soulId, outcome: result.outcome,
    })
  }
  if (reopenResults.some(result => result.outcome !== 'reopened')) {
    await record(dependencies, mode, 'complete', 'update.completed_with_reopen_failures', 'error', {
      reopened: reopenResults.filter(result => result.outcome === 'reopened').length,
      pending: reopenResults.filter(result => result.outcome === 'pending').length,
      unavailable: reopenResults.filter(result => result.outcome === 'unavailable').length,
      failed: reopenResults.filter(result => result.outcome === 'failed').length,
      manual_recovery: MANUAL_RECOVERY,
      ...postStartOwnershipEventFields(execution.postStartOwnership),
    })
    await reportPostStartOwnership(dependencies, execution.postStartOwnership)
    await dependencies.logger.operator(MANUAL_RECOVERY)
    return 1
  }
  await record(dependencies, mode, 'complete', 'update.completed', 'info', {
    reset_target_count: execution.resetTargets.length,
    reopened_count: reopenResults.length,
    ...postStartOwnershipEventFields(execution.postStartOwnership),
  })
  await reportPostStartOwnership(dependencies, execution.postStartOwnership)
  return 0
}

async function handleWorkerFailure(
  mode: ManagedUpdateMode,
  dependencies: ManagedRuntimeUpdateDependencies,
  execution: WorkerExecutionState,
  error: unknown,
): Promise<number> {
  const refusal = error instanceof UpdateRefusal
  const gateMayRemainClosed = !execution.webProcessExitConfirmed
    && ['temporary', 'latched', 'unknown'].includes(execution.shutdownGateState)
  const gateRecovery = execution.shutdownGateState === 'temporary' ? TEMPORARY_GATE_RECOVERY : SHUTDOWN_GATE_RECOVERY
  const partialState = execution.filesInstalled
    || (mode !== 'client' && (execution.supervisorShutdownAttempted || execution.supervisorShutdownComplete))
    || gateMayRemainClosed
  if (execution.webStopAttempted && execution.webProcessExitConfirmed
    && !execution.supervisorShutdownComplete && execution.owner) {
    const restoration = execution.webRestoreBlocked
      ? { restored: false, unitState: 'not-started', errorCode: execution.webRestoreBlocked }
      : await restoreWebAfterAbort(dependencies, execution.owner, mode)
    await record(dependencies, mode, execution.phase, 'update.web_restore_after_abort', restoration.restored ? 'info' : 'error', {
      restored: restoration.restored, original_error_code: refusal ? 'preflight_refused_after_web_stop' : 'update_failed',
      unit_state: restoration.unitState,
      ...(restoration.errorCode ? { restoration_error_code: restoration.errorCode } : {}),
    })
  }
  await record(dependencies, mode, execution.phase, 'update.failed', 'error', {
    error_code: refusal ? 'preflight_refused' : 'update_failed',
    attempted_prefix: execution.attemptedStops,
    verified_empty_stopped: execution.verifiedEmptyStops,
    maintenance_gate_state: execution.shutdownGateState,
    ...(execution.supervisorStateAfterStopFailure ? { supervisor_unit_state: execution.supervisorStateAfterStopFailure } : {}),
    ...(partialState ? {
      partial_state: true,
      manual_recovery: gateMayRemainClosed ? gateRecovery : MANUAL_RECOVERY,
    } : {}),
  })
  const safeMessage = error instanceof Error ? error.message : 'Unknown updater failure.'
  await dependencies.logger.operator(safeMessage)
  if (partialState) {
    await dependencies.logger.operator(gateMayRemainClosed ? gateRecovery : MANUAL_RECOVERY)
  }
  return refusal && !execution.webStopAttempted && !execution.filesInstalled && !gateMayRemainClosed ? 2 : 1
}

function markOldWebProcessExited(execution: WorkerExecutionState): void {
  execution.webProcessExitConfirmed = true
  execution.shutdownGateState = 'open'
  execution.shutdownCommitAttempted = false
  execution.maintenanceLease = undefined
}

async function cleanupStagingArtifacts(artifacts?: StagedArtifacts): Promise<void> {
  if (artifacts?.stagingRoot) await fsp.rm(artifacts.stagingRoot, { recursive: true, force: true }).catch(() => undefined)
}

export function webActionCanReachSupervisor(graph: SystemdUnitGraph, webUnit: string, supervisorUnit: string): boolean {
  const startEdges = new Map<string, string[]>()
  const stopEdges = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, from: string, to: string) => {
    const values = map.get(from) ?? []
    values.push(to)
    map.set(from, values)
  }
  for (const [unit, properties] of Object.entries(graph.units)) {
    for (const property of ['Requires', 'Wants', 'Requisite', 'BindsTo', 'Upholds'] as const) {
      for (const target of properties[property] ?? []) add(startEdges, unit, target)
    }
    for (const target of properties.PartOf ?? []) add(stopEdges, target, unit)
    for (const target of properties.BindsTo ?? []) add(stopEdges, target, unit)
    for (const target of properties.PropagatesStopTo ?? []) add(stopEdges, unit, target)
    for (const target of properties.ConsistsOf ?? []) add(stopEdges, unit, target)
    for (const target of properties.BoundBy ?? []) add(stopEdges, unit, target)
    for (const target of properties.StopPropagatedFrom ?? []) add(stopEdges, target, unit)
    for (const target of properties.UpheldBy ?? []) add(startEdges, target, unit)
  }
  return reachable(startEdges, webUnit, supervisorUnit) || reachable(stopEdges, webUnit, supervisorUnit)
}

export function buildReopenCandidates(
  snapshot: InventorySnapshot,
  targets: ManagedCodingSoulResetTarget[],
  stoppedIntentRevisions: Map<string, number>,
): { candidates: ReopenCandidate[]; unavailable: Array<{ soulId: string; provider: string }>; noReferenceCount: number; ineligibleReferenceCount: number } {
  const groups = groupInventory(snapshot)
  return collectReopenWork(snapshot, groups, targets, stoppedIntentRevisions)
}

export async function runManagedUpdateCli(argv: string[], dependencies: ManagedRuntimeUpdateDependencies): Promise<number> {
  if (argv[0] === '--bootstrap' || argv[0] === '--worker') return 2
  return runManagedRuntimeUpdate(argv, dependencies)
}

export function parseInternalArgs(args: string[]):
  | { kind: 'bootstrap' | 'worker'; mode: ManagedUpdateMode; unitName: string; runId: string; approvalFile?: string }
  | null {
  const kind = args[0] === '--bootstrap' ? 'bootstrap' : args[0] === '--worker' ? 'worker' : null
  if (!kind) return null
  let mode: ManagedUpdateMode | undefined
  let unitName: string | undefined
  let runId: string | undefined
  let approvalFile: string | undefined
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (typeof value !== 'string') return null
    if (key === '--mode' && ['client', 'all', 'durable-only'].includes(value)) mode = value as ManagedUpdateMode
    else if (key === '--unit-name') unitName = value
    else if (key === '--run-id') runId = value
    else if (key === '--approval-file') approvalFile = value
    else return null
  }
  if (!mode || !unitName || !runId) return null
  if (unitName !== `${UPDATE_UNIT_PREFIX}${runId}.service`) return null
  if (!/^\d{8}T\d{9}Z-[A-Za-z0-9]{6,20}$/.test(runId)) return null
  if (mode === 'client' && approvalFile) return null
  if (mode !== 'client' && !approvalFile) return null
  return { kind, mode, unitName, runId, ...(approvalFile ? { approvalFile } : {}) }
}

export function createProductionDependencies(logPath?: string): ManagedRuntimeUpdateDependencies {
  const checkoutRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const home = path.resolve(os.homedir())
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR
  if (!runtimeDirectory || !path.isAbsolute(runtimeDirectory)) {
    throw new Error('XDG_RUNTIME_DIR must identify the current user runtime directory.')
  }
  const node = fs.realpathSync(process.execPath)
  const pnpm = resolveCommand('pnpm')
  const cargo = resolveCommand('cargo', { preserveSymlink: true })
  const docker = resolveCommand('docker')
  const sqlite = resolveCommand('sqlite3')
  const flock = resolveCommand('flock')
  const systemdRun = resolveCommand('systemd-run')
  const systemctl = resolveCommand('systemctl')
  const env = resolveCommand('env')
  const require = createRequire(import.meta.url)
  const tsxLoader = fs.realpathSync(require.resolve('tsx'))
  const updaterScript = fs.realpathSync(fileURLToPath(import.meta.url))
  const pathEntries = [...new Set([
    path.dirname(node), path.dirname(pnpm), path.dirname(cargo), path.dirname(docker),
    path.dirname(sqlite), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
  ])]
  const cargoHome = path.resolve(process.env.CARGO_HOME || path.join(home, '.cargo'))
  const rustupHome = path.resolve(process.env.RUSTUP_HOME || path.join(home, '.rustup'))
  const pnpmHome = path.resolve(process.env.PNPM_HOME || path.dirname(pnpm))
  const paths: UpdatePaths = {
    checkoutRoot, home, runtimeDirectory: path.resolve(runtimeDirectory), node, tsxLoader,
    updaterScript, env, flock, systemdRun, systemctl, pnpm, cargo, docker, sqlite,
    toolPath: pathEntries.join(path.delimiter), pnpmHome, cargoHome, rustupHome,
    cargoTargetDirectory: path.join(home, '.cache', 'freshell', 'managed-runtime-update', 'cargo-target'),
  }
  return createProductionDependencyAdapters(paths, logPath)
}

export function createProductionDependencyAdapters(
  paths: UpdatePaths,
  knownLogPath?: string,
  readinessOptions: { supervisorReadinessTimeoutMs?: number; supervisorReadinessPollIntervalMs?: number } = {},
): ManagedRuntimeUpdateDependencies {
  const logger = createJsonLogger(knownLogPath)
  const run = (command: string, args: string[], options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: string
    timeoutMs?: number
  } = {}) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? minimalEnvironment(paths),
      input: options.input,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const }),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code ?? 'spawn_error'
      if (code === 'ETIMEDOUT') throw new UpdateFailure(`${path.basename(command)} timed out after ${options.timeoutMs ?? 'the configured'} ms.`)
      throw new UpdateFailure(`${path.basename(command)} could not run (${code}).`)
    }
    if (result.status !== 0) throw new UpdateFailure(`${path.basename(command)} failed with status ${result.status ?? 'unknown'}.`)
    return result.stdout.trim()
  }
  const systemdShow = (unit: string, property: string, timeoutMs?: number) => commandForProperty(paths, unit, property, timeoutMs)
  const dockerAdapter: ManagedRuntimeUpdateDependencies['docker'] = {
    async verifyDaemon(owner, socket) {
      const daemonId = run(paths.docker, ['--host', `unix://${socket}`, 'info', '--format', '{{.ID}}'])
      if (!daemonId || (owner.dockerDaemonId && daemonId !== owner.dockerDaemonId)) {
        throw new UpdateRefusal('The selected Docker socket does not identify the managed runtime owner’s daemon.')
      }
    },
    async buildImage(owner, socket) {
      const tag = `freshell-managed-runtime:update-${randomHex(12)}`
      run(paths.docker, ['--host', `unix://${socket}`, 'image', 'build', '--tag', tag,
        '--file', path.join(paths.checkoutRoot, 'docker/runtime/Dockerfile'), paths.checkoutRoot], { cwd: paths.checkoutRoot })
      const imageId = run(paths.docker, ['--host', `unix://${socket}`, 'image', 'inspect', '--format', '{{.Id}}', tag])
      if (!isDigest(imageId)) throw new UpdateFailure('Docker did not return an immutable managed workload image ID.')
      return imageId
    },
  }

  return {
    paths,
    approval: {
      readLine: readExactApprovalLine,
      async create(content, mode) {
        const name = `freshell-update-approval-${process.pid}-${randomHex(8)}`
        const target = path.join(paths.runtimeDirectory, name)
        const handle = await fsp.open(target, 'wx', mode)
        try { await handle.writeFile(content, 'utf8'); await handle.chmod(mode) } finally { await handle.close() }
        return target
      },
      async consume(filePath) {
        let raw: string
        try { raw = await fsp.readFile(filePath, 'utf8') } catch { return false }
        try { await fsp.unlink(filePath) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
        return raw === 'APPROVED\n'
      },
      async remove(filePath) { await fsp.unlink(filePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
    },
    handoff: {
      async submit(request) {
        const result = spawnSync(paths.systemdRun, request.args, {
          cwd: request.workingDirectory, env: request.environment, stdio: 'inherit',
        })
        if (result.error) throw result.error
        return result.status ?? 1
      },
      async runLockedWorker(request) {
        const result = spawnSync(paths.flock, ['-n', '-E', '75', request.lockPath, ...request.command], {
          env: request.environment, stdio: 'inherit',
        })
        if (result.error) throw result.error
        return result.status ?? 1
      },
    },
    owner: {
      async resolve(mode) {
        const web = readSystemdUnit(paths, systemdShow, WEB_UNIT)
        const supervisor = readSystemdUnit(paths, systemdShow, SUPERVISOR_UNIT)
        const selected = deriveOwner(paths, web, supervisor)
        await verifyOwnerFiles(selected, mode)
        return selected
      },
      async inspectGraph(selected) { return inspectEffectiveUnitGraph(paths, systemdShow, selected) },
      async loadPersistentResourceManifest(selected, mode) {
        await loadPersistentResourceManifest(paths, selected, dockerAdapter, run)
        await verifyOwnerFiles(selected, mode)
      },
    },
    artifacts: {
      async build(selected, mode) { return buildSelectedArtifacts(paths, selected, mode, run, dockerAdapter) },
      async serverBuildInfo(executable) {
        return parseBuildInfoOutput(run(executable, ['--build-info']))
      },
    },
    filesystem: {
      async webExecutableIdentity(selectedPath) {
        const web = readSystemdUnit(paths, systemdShow, WEB_UNIT)
        if (!web.mainPid) return { live: null, selected: null }
        return {
          live: await fileIdentity(`/proc/${web.mainPid}/exe`),
          selected: await fileIdentity(selectedPath),
        }
      },
      async installExecutable(source, target) { await replaceFileOnDestination(source, target) },
      async swapClientDirectory(source, target) { await swapDirectoryOnDestination(source, target) },
      async installImageReference(environmentFile, imageId) { await replaceImageReference(environmentFile, imageId) },
    },
    services: {
      async stop(unit) { run(paths.systemctl, ['--user', 'stop', unit]) },
      async start(unit) { run(paths.systemctl, ['--user', 'start', unit]) },
      async restart(unit) { run(paths.systemctl, ['--user', 'restart', unit]) },
      async isActive(unit) { return systemdShow(unit, 'ActiveState') === 'active' },
      async state(unit) { return systemdShow(unit, 'ActiveState') },
      async waitSupervisorReady(selected, expectedImageReference, previousIdentity) {
        let lastIssue = 'systemd has not reported an active supervisor'
        return waitForSupervisorReadiness(async remainingMs => {
          let activeState: string
          try {
            activeState = systemdShow(SUPERVISOR_UNIT, 'ActiveState', remainingMs())
          } catch (error) {
            lastIssue = error instanceof Error ? error.message : 'systemd ActiveState could not be read'
            return undefined
          }
          if (activeState === 'activating' || activeState === 'reloading' || activeState === 'deactivating') {
            lastIssue = `systemd reports ${activeState}`
            return undefined
          }
          if (activeState !== 'active') {
            throw new UpdateFailure(`The restarted managed-runtime supervisor is not active (systemd state ${activeState}).`)
          }
          let mainPid: number
          try {
            mainPid = Number(systemdShow(SUPERVISOR_UNIT, 'MainPID', remainingMs()))
          } catch (error) {
            lastIssue = error instanceof Error ? error.message : 'systemd MainPID could not be read'
            return undefined
          }
          if (!Number.isSafeInteger(mainPid) || mainPid <= 0 || mainPid === selected.supervisorMainPid) {
            lastIssue = 'systemd has not reported a new supervisor MainPID'
            return undefined
          }
          try {
            await assertRunningSupervisorProcess(mainPid, selected, expectedImageReference)
          } catch (error) {
            lastIssue = error instanceof Error ? error.message : 'the new supervisor process is not yet verified'
            return undefined
          }
          const socket = await fsp.stat(selected.controlSocket).catch(() => null)
          if (!socket?.isSocket()) {
            lastIssue = 'the supervisor control socket is not ready'
            return undefined
          }
          try {
            const output = run(selected.adminCli, [
              '--socket', selected.controlSocket, '--secret-file', selected.controlSecretFile, 'health',
            ], { timeoutMs: remainingMs() })
            const health = parseJsonOutput(output)
            if (health.state !== 'ok') {
              lastIssue = 'authenticated supervisor Health is not ready'
              return undefined
            }
            const identity = parseSupervisorIdentity(health)
            if (identity.installationId !== previousIdentity.installationId) {
              lastIssue = 'authenticated supervisor Health identifies a different installation'
              return undefined
            }
            if (identity.controlEpoch <= previousIdentity.controlEpoch) {
              lastIssue = 'authenticated supervisor Health has not advanced to the new control epoch'
              return undefined
            }
            return identity
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'the Health request failed'
            lastIssue = /timed out/i.test(detail)
              ? `authenticated Health request timed out (${detail})`
              : `authenticated Health request failed (${detail})`
            return undefined
          }
        }, {
          timeoutMs: readinessOptions.supervisorReadinessTimeoutMs,
          intervalMs: readinessOptions.supervisorReadinessPollIntervalMs,
          timeoutMessage: () => `The restarted managed-runtime supervisor did not become ready with its verified process and authenticated Health identity before the timeout: ${lastIssue}.`,
        })
      },
      async waitWebReady(selected) { await waitHttpReady(selected.callbackAddress) },
      async waitWebStopped(selected) {
        await waitUntil(async () => {
          const state = systemdShow(WEB_UNIT, 'ActiveState')
          if (state === 'active' || state === 'activating' || state === 'deactivating' || state === 'reloading') return false
          if (!selected.webMainPid) return true
          try {
            const executable = (await fsp.readlink(`/proc/${selected.webMainPid}/exe`)).replace(/ \(deleted\)$/, '')
            return path.resolve(executable) !== selected.webExecutable
          } catch { return true }
        })
      },
      async waitCallbackReady(selected) {
        await waitUntil(() => probeUnixSocket(selected.callbackSocket))
      },
    },
    admin: {
      async candidateSchemaVersion(executable) {
        const output = run(executable, ['schema-version'])
        const version = Number(output)
        if (!Number.isSafeInteger(version) || version < 1) throw new UpdateFailure('Candidate supervisor returned an invalid schema version.')
        return version
      },
      async currentSchemaVersion(databasePath) {
        const output = run(paths.sqlite, ['-readonly', '-batch', '-noheader', databasePath,
          'SELECT schema_version FROM installation WHERE singleton=1;'])
        const version = Number(output)
        if (!Number.isSafeInteger(version) || version < 1) throw new UpdateRefusal('The current managed registry schema version could not be read without writes.')
        return version
      },
      async health(selected) {
        const output = run(selected.adminCli, ['--socket', selected.controlSocket, '--secret-file', selected.controlSecretFile, 'health'])
        const value = parseJsonOutput(output)
        if (value.state !== 'ok') throw new UpdateFailure('Supervisor control-socket health check failed.')
        const identity = parseSupervisorIdentity(value)
        return { state: 'ok', ...identity }
      },
      async inventory(selected) {
        const output = run(selected.adminCli, ['--socket', selected.controlSocket, '--secret-file', selected.controlSecretFile, 'inventory'])
        const value = parseJsonOutput(output)
        if (!Array.isArray(value.views)) throw new UpdateFailure('Supervisor Inventory returned an invalid response.')
        return value.views as RuntimeView[]
      },
      async maintenanceInventory(supervisorExecutable, databasePath) {
        const output = run(supervisorExecutable, ['maintenance-inventory', databasePath], { cwd: paths.checkoutRoot })
        return parseCandidateMaintenanceInventory(output)
      },
      async stop(soulId, expectedIntentRevision, selected) {
        const output = runAllowFailure(selected.adminCli, paths, [
          '--socket', selected.controlSocket, '--secret-file', selected.controlSecretFile,
          'stop', soulId, '--expected-revision', String(expectedIntentRevision),
        ])
        const value = parseJsonOutput(output.stdout)
        const outcome = ({
          verified_empty: 'verified_empty', blocked_ownership: 'blocked_ownership',
          backend_unavailable: 'backend_unavailable', termination_unconfirmed: 'termination_unconfirmed',
        } as Record<string, StopResult['outcome']>)[String(value.state)]
        if (!outcome) throw new UpdateFailure('Supervisor Stop returned an invalid typed result.')
        return { outcome, ...(value.view ? { view: value.view as RuntimeView } : {}) } as StopResult
      },
      async reopen(candidate, selected) {
        const output = runAllowFailure(selected.adminCli, paths, [
          '--socket', selected.controlSocket, '--secret-file', selected.controlSecretFile,
          'reopen', candidate.soulId, '--expected-revision', String(candidate.expectedIntentRevision),
        ])
        const value = parseJsonOutput(output.stdout)
        const outcome = value.outcome
        if (!['reopened', 'pending', 'failed'].includes(String(outcome))) throw new UpdateFailure('Supervisor Reopen returned an invalid typed result.')
        return { outcome: outcome as 'reopened' | 'pending' | 'failed', ...(typeof value.message === 'string' ? { message: value.message } : {}) }
      },
    },
    runtimeApi: {
      async readAuthToken(selected) {
        const web = readSystemdUnit(paths, systemdShow, WEB_UNIT)
        if (web.loadState !== 'loaded' || web.workingDirectory !== selected.checkoutRoot
          || web.executable !== selected.webExecutable || !web.mainPid) {
          throw new UpdateRefusal('The selected live web process could not be verified before reading its runtime token.')
        }
        await validateProcessOwner(web.mainPid, selected.webExecutable, selected.checkoutRoot)
        const processEnvironment = await readProcessEnvironment(web.mainPid)
        const processToken = processEnvironment.AUTH_TOKEN
        const token = processToken !== undefined
          ? processToken
          : readEnvironmentValue(await fsp.readFile(selected.environmentFile, 'utf8'), 'AUTH_TOKEN')
        if (!nonEmpty(token)) throw new UpdateRefusal('The selected web server has no usable AUTH_TOKEN in its verified process environment or checkout .env.')
        return token
      },
      async request(selected, token, method, endpoint, body) {
        const response = await fetch(new URL(endpoint, selected.callbackAddress), {
          method,
          headers: {
            'x-auth-token': token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
        })
        let responseBody: unknown
        try { responseBody = JSON.parse(await response.text()) } catch { responseBody = undefined }
        return { status: response.status, body: responseBody }
      },
    },
    docker: dockerAdapter,
    logger,
    now: () => new Date(),
    randomSuffix: () => randomHex(6),
  }
}

export function deriveOwner(paths: UpdatePaths, web: ParsedUnit, supervisor: ParsedUnit): ManagedRuntimeOwner {
  if (web.loadState !== 'loaded' || supervisor.loadState !== 'loaded') throw new UpdateRefusal('Both selected systemd units must be loaded.')
  if (supervisor.activeState !== 'active' || supervisor.mainPid === null) {
    throw new UpdateRefusal('The selected systemd supervisor must be active and have a MainPID.')
  }
  if (web.activeState !== 'active' || web.mainPid === null) {
    throw new UpdateRefusal('The selected web unit must be active and have a MainPID.')
  }
  const checkoutRoot = paths.checkoutRoot
  if (web.workingDirectory !== checkoutRoot || supervisor.workingDirectory !== checkoutRoot) {
    throw new UpdateRefusal('The selected unit working directories do not identify this deployment checkout.')
  }
  if (web.executable !== path.join(checkoutRoot, 'target/release/freshell-server')
    || supervisor.executable !== path.join(checkoutRoot, 'target/release/freshell-supervisor')) {
    throw new UpdateRefusal('The selected systemd executables do not belong to this deployment checkout.')
  }
  const imageEnv = supervisor.environmentFiles.find(file => file.endsWith('managed-runtime.env'))
  if (!imageEnv || supervisor.environmentFiles.length !== 1) throw new UpdateRefusal('The supervisor image environment file is missing or ambiguous.')
  const envContents = fs.readFileSync(imageEnv, 'utf8')
  const imageReference = readEnvironmentValue(envContents, 'FRESHELL_RUNTIME_IMAGE')
  if (!isDigest(imageReference)) throw new UpdateRefusal('The managed workload image reference is missing or is not an immutable sha256 image ID.')
  const supervisorArgs = supervisor.argv.slice(1)
  const webArgs = web.argv.slice(1)
  const getRequired = (args: string[], name: string) => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1]) throw new UpdateRefusal(`The selected unit is missing its ${name} owner path.`)
    return args[index + 1]!
  }
  const webEnvironment = web.environment
  const controlSocket = webEnvironment.FRESHELL_RUNTIME_CONTROL_SOCKET
  const controlSecretFile = webEnvironment.FRESHELL_RUNTIME_CONTROL_SECRET_FILE
  if (!controlSocket || !controlSecretFile || webEnvironment.FRESHELL_MANAGED_RUNTIME_V1 !== '1') {
    throw new UpdateRefusal('The selected web unit does not expose the managed-runtime control owner configuration.')
  }
  const supSocket = getRequired(supervisorArgs, '--control-socket')
  const supSecret = getRequired(supervisorArgs, '--control-secret-file')
  if (controlSocket !== supSocket || controlSecretFile !== supSecret) {
    throw new UpdateRefusal('The web and supervisor units disagree about the exact control socket or secret-file path.')
  }
  const dockerSocket = getRequired(supervisorArgs, '--docker-socket')
  if (!path.isAbsolute(dockerSocket)) throw new UpdateRefusal('The managed runtime Docker socket path is not absolute.')
  const registryRoot = getRequired(supervisorArgs, '--registry-root')
  const runtimeRoot = getRequired(supervisorArgs, '--runtime-root')
  const sessionHostBinary = getRequired(supervisorArgs, '--host-binary')
  const supervisorImage = getRequired(supervisorArgs, '--image-ref')
  if (supervisorImage !== imageReference && supervisorImage !== '${FRESHELL_RUNTIME_IMAGE}') {
    throw new UpdateRefusal('The supervisor command and managed-runtime environment file disagree about the workload image.')
  }
  const port = webEnvironment.PORT ?? '3001'
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new UpdateRefusal('The selected web unit has an invalid readiness port.')
  return {
    checkoutRoot, webUnit: WEB_UNIT, supervisorUnit: SUPERVISOR_UNIT,
    webExecutable: web.executable, supervisorExecutable: supervisor.executable,
    adminCli: path.join(checkoutRoot, 'target/release/freshell-supervisor-admin'),
    sessionHostBinary, clientDirectory: path.join(checkoutRoot, 'dist/client'),
    dockerSocket, controlSocket, controlSecretFile, registryRoot, runtimeRoot,
    callbackSocket: path.join(path.dirname(controlSocket), 'mcp.sock'),
    providerRoots: [], workspaceRoots: [],
    imageEnvironmentFile: imageEnv,
    environmentFile: path.join(checkoutRoot, '.env'), imageReference,
    databasePath: path.join(registryRoot, 'runtime.sqlite3'),
    callbackAddress: `http://127.0.0.1:${port}`,
    webMainPid: web.mainPid ?? undefined, supervisorMainPid: supervisor.mainPid ?? undefined,
  }
}

export interface ParsedUnit {
  loadState: string
  activeState: string
  mainPid: number | null
  workingDirectory: string
  executable: string
  argv: string[]
  environment: Record<string, string>
  environmentFiles: string[]
}

function readSystemdUnit(paths: UpdatePaths, show: (unit: string, property: string) => string, unit: string): ParsedUnit {
  const loadState = show(unit, 'LoadState')
  const activeState = show(unit, 'ActiveState')
  const rawPid = Number(show(unit, 'MainPID'))
  const workingDirectory = show(unit, 'WorkingDirectory')
  const [executable, argv] = parseExecStart(show(unit, 'ExecStart'))
  const environment = parseEnvironment(show(unit, 'Environment'))
  const environmentFilesRaw = show(unit, 'EnvironmentFiles').trim()
  const environmentFiles = [...environmentFilesRaw.matchAll(/([^\s]+)\s+\(ignore_errors=(?:yes|no)\)/g)]
    .map(match => match[1]!)
  if (environmentFilesRaw && environmentFiles.length === 0) throw new UpdateRefusal(`The ${unit} EnvironmentFiles property could not be parsed unambiguously.`)
  if (!path.isAbsolute(workingDirectory) || !path.isAbsolute(executable) || argv[0] !== executable) {
    throw new UpdateRefusal(`The loaded ${unit} command or working directory could not be resolved unambiguously.`)
  }
  return { loadState, activeState, mainPid: Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null, workingDirectory, executable, argv, environment, environmentFiles }
}

function parseExecStart(value: string): [string, string[]] {
  const pathMatch = /(?:^|\s)path=([^;\s]+)\s*;/.exec(value)
  const argvMatch = /(?:^|\s)argv\[\]=([^;]+)\s*;/.exec(value)
  if (!pathMatch || !argvMatch) throw new UpdateRefusal('A selected unit ExecStart could not be parsed safely.')
  const argvText = argvMatch[1]!.trim()
  if (/["']/.test(argvText)) throw new UpdateRefusal('A selected unit ExecStart contains quoting that prevents unambiguous owner parsing.')
  const argv = argvText.split(/\s+/).map(value => value.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))))
  return [pathMatch[1]!, argv]
}

function parseEnvironment(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const item of value.split(/\s+/)) {
    const separator = item.indexOf('=')
    if (separator > 0) env[item.slice(0, separator)] = item.slice(separator + 1)
  }
  return env
}

async function loadPersistentResourceManifest(
  paths: UpdatePaths,
  owner: ManagedRuntimeOwner,
  docker: ManagedRuntimeUpdateDependencies['docker'],
  run: (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string,
): Promise<void> {
  let daemonIds: string[]
  let volumeNames: string[]
  let workspaceRoots: string[]
  try {
    daemonIds = outputLines(run(paths.sqlite, ['-readonly', '-batch', '-noheader', owner.databasePath,
      'SELECT DISTINCT docker_daemon_id FROM incarnations WHERE docker_daemon_id IS NOT NULL;']))
    volumeNames = outputLines(run(paths.sqlite, ['-readonly', '-batch', '-noheader', owner.databasePath,
      "SELECT DISTINCT provider_volume_name FROM souls WHERE provider_volume_name!='';"]))
    workspaceRoots = outputLines(run(paths.sqlite, ['-readonly', '-batch', '-noheader', owner.databasePath,
      "SELECT json_extract(terminal_spec,'$.workspacePath') FROM incarnations WHERE terminal_spec IS NOT NULL UNION SELECT json_extract(fresh_agent_spec,'$.workspacePath') FROM incarnations WHERE fresh_agent_spec IS NOT NULL UNION SELECT json_extract(resume_spec,'$.workspacePath') FROM souls WHERE resume_spec IS NOT NULL;"]))
  } catch {
    throw new UpdateRefusal('Persistent runtime resources could not be enumerated from the selected registry using read-only SQLite queries.')
  }
  if (daemonIds.length > 1) throw new UpdateRefusal('The managed registry records more than one Docker daemon owner.')
  owner.dockerDaemonId = daemonIds[0]
  try { await docker.verifyDaemon(owner, owner.dockerSocket) } catch {
    throw new UpdateRefusal('The selected Docker socket could not be matched to the managed registry owner.')
  }
  const providerRoots: string[] = []
  try {
    for (const volumeName of [...new Set(volumeNames)]) {
      const mountpoint = run(paths.docker, ['--host', `unix://${owner.dockerSocket}`, 'volume', 'inspect', '--format', '{{.Mountpoint}}', volumeName])
      if (!path.isAbsolute(mountpoint)) throw new Error('volume mountpoint is not absolute')
      providerRoots.push(mountpoint)
    }
  } catch {
    throw new UpdateRefusal('A provider/history volume could not be resolved through the selected Docker daemon.')
  }
  if (workspaceRoots.some(value => !path.isAbsolute(value))) throw new UpdateRefusal('The managed registry contains a non-absolute workspace root.')
  owner.providerRoots = [...new Set(providerRoots)]
  owner.workspaceRoots = [...new Set(workspaceRoots)]
}

function outputLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))]
}

async function inspectEffectiveUnitGraph(
  paths: UpdatePaths,
  show: (unit: string, property: string) => string,
  owner: ManagedRuntimeOwner,
): Promise<SystemdUnitGraph> {
  const units: SystemdUnitGraph['units'] = {}
  const pending = [owner.webUnit, owner.supervisorUnit]
  while (pending.length) {
    const unit = pending.shift()!
    if (units[unit]) continue
    const properties: SystemdUnitGraph['units'][string] = {}
    for (const property of GRAPH_PROPERTIES) {
      const values = show(unit, property).trim().split(/\s+/).filter(Boolean)
      properties[property] = values
      for (const related of values) if (!units[related]) pending.push(related)
    }
    units[unit] = properties
    if (Object.keys(units).length > 256) throw new UpdateRefusal('The loaded systemd unit relationship graph is too large to verify safely.')
  }
  return { units }
}

async function verifyOwnerFiles(owner: ManagedRuntimeOwner, mode: ManagedUpdateMode): Promise<void> {
  validateOwner(owner, owner.checkoutRoot)
  if (owner.webUnit !== WEB_UNIT || owner.supervisorUnit !== SUPERVISOR_UNIT) throw new UpdateRefusal('The selected unit pair is not the supported Freshell systemd owner.')
  for (const field of PATH_FIELDS) {
    const value = owner[field]
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new UpdateRefusal(`The owner manifest has an unresolved ${String(field)} path.`)
  }
  const pathsToCheck = [owner.checkoutRoot, owner.webExecutable, owner.supervisorExecutable, owner.adminCli,
    owner.sessionHostBinary, owner.clientDirectory, owner.dockerSocket, owner.controlSocket,
    owner.controlSecretFile, owner.callbackSocket, owner.registryRoot, owner.runtimeRoot, owner.imageEnvironmentFile,
    owner.environmentFile, owner.databasePath, ...(owner.providerRoots ?? []), ...(owner.workspaceRoots ?? []),
    ...(owner.providerRoot ? [owner.providerRoot] : []), ...(owner.workspaceRoot ? [owner.workspaceRoot] : [])]
  for (const candidate of pathsToCheck) {
    if (!path.isAbsolute(candidate)) throw new UpdateRefusal('The owner resource manifest contains a non-absolute path.')
  }
  const [checkout, webPath, supervisorPath, hostPath, clientPath, envFile, imageEnv, registry, runtime] = await Promise.all([
    fsp.realpath(owner.checkoutRoot), fsp.realpath(owner.webExecutable), fsp.realpath(owner.supervisorExecutable),
    fsp.realpath(owner.sessionHostBinary), fsp.realpath(owner.clientDirectory), fsp.realpath(owner.environmentFile),
    fsp.realpath(owner.imageEnvironmentFile), fsp.realpath(owner.registryRoot), fsp.realpath(owner.runtimeRoot),
  ])
  if (checkout !== owner.checkoutRoot || webPath !== owner.webExecutable || supervisorPath !== owner.supervisorExecutable
    || hostPath !== owner.sessionHostBinary || clientPath !== owner.clientDirectory || envFile !== owner.environmentFile
    || imageEnv !== owner.imageEnvironmentFile || registry !== owner.registryRoot || runtime !== owner.runtimeRoot) {
    throw new UpdateRefusal('A selected executable, client directory, environment file, or persistent root resolves through an alias.')
  }
  const [webStat, supervisorStat, hostStat, clientStat, envStat, imageEnvStat, registryStat, runtimeStat, socketStat, controlStat, secretStat, callbackStat] = await Promise.all([
    fsp.stat(owner.webExecutable), fsp.stat(owner.supervisorExecutable), fsp.stat(owner.sessionHostBinary),
    fsp.stat(owner.clientDirectory), fsp.stat(owner.environmentFile), fsp.stat(owner.imageEnvironmentFile),
    fsp.stat(owner.registryRoot), fsp.stat(owner.runtimeRoot), fsp.stat(owner.dockerSocket),
    fsp.stat(owner.controlSocket), fsp.stat(owner.controlSecretFile), fsp.stat(owner.callbackSocket),
  ])
  if (!webStat.isFile() || !supervisorStat.isFile() || !hostStat.isFile() || !clientStat.isDirectory()
    || !envStat.isFile() || !imageEnvStat.isFile() || !registryStat.isDirectory() || !runtimeStat.isDirectory()
    || !socketStat.isSocket() || !controlStat.isSocket() || !secretStat.isFile() || !callbackStat.isSocket()) {
    throw new UpdateRefusal('One or more selected owner paths have the wrong filesystem type or are missing.')
  }
  if (process.getuid && secretStat.uid !== process.getuid()) throw new UpdateRefusal('The supervisor control secret file is not owned by this user.')
  if ((secretStat.mode & 0o077) !== 0) throw new UpdateRefusal('The supervisor control secret file is not private to this user.')
  if (process.getuid && socketStat.uid !== process.getuid()) throw new UpdateRefusal('The selected Docker socket is not owned by this user.')
  if (process.getuid && callbackStat.uid !== process.getuid()) throw new UpdateRefusal('The managed MCP callback socket is not owned by this user.')
  const persistentDirectories = [...(owner.providerRoots ?? []), ...(owner.workspaceRoots ?? [])]
  for (const directory of persistentDirectories) {
    let resolved: string
    let stat: fs.Stats
    try { [resolved, stat] = await Promise.all([fsp.realpath(directory), fsp.stat(directory)]) } catch {
      throw new UpdateRefusal('A selected provider/history or workspace root could not be verified.')
    }
    if (resolved !== directory || !stat.isDirectory()) throw new UpdateRefusal('A selected provider/history or workspace root has an ambiguous owner path.')
  }
  const databaseRealPath = await fsp.realpath(owner.databasePath).catch(() => null)
  if (databaseRealPath !== path.join(owner.registryRoot, 'runtime.sqlite3')) {
    throw new UpdateRefusal('The managed registry database is not the expected file under the selected registry root.')
  }
  if (mode === 'durable-only' && owner.webMainPid === undefined) throw new UpdateRefusal('The web unit MainPID could not be identified.')
  await validateProcessOwner(owner.webMainPid, owner.webExecutable, owner.checkoutRoot)
  if (owner.supervisorMainPid === undefined) throw new UpdateRefusal('The selected systemd supervisor MainPID could not be identified.')
  await assertRunningSupervisorProcess(owner.supervisorMainPid, owner, owner.imageReference)
}

async function validateProcessOwner(pid: number | undefined, executable: string, checkoutRoot: string): Promise<void> {
  if (pid === undefined || pid === null) return
  let actualExecutable: string
  let workingDirectory: string
  try { actualExecutable = await fsp.readlink(`/proc/${pid}/exe`) }
  catch { throw new UpdateRefusal('A selected systemd MainPID executable could not be verified.') }
  try { workingDirectory = await fsp.realpath(`/proc/${pid}/cwd`) }
  catch { throw new UpdateRefusal('A selected systemd MainPID working directory could not be verified.') }
  actualExecutable = actualExecutable.replace(/ \(deleted\)$/, '')
  if (path.resolve(actualExecutable) !== executable || workingDirectory !== checkoutRoot) {
    throw new UpdateRefusal('A selected systemd MainPID belongs to a different executable or checkout.')
  }
  let liveExecutable: fs.Stats
  let selectedExecutable: fs.Stats
  try {
    [liveExecutable, selectedExecutable] = await Promise.all([
      fsp.stat(`/proc/${pid}/exe`),
      fsp.stat(executable),
    ])
  } catch {
    throw new UpdateRefusal('A selected systemd MainPID executable could not be compared with the installed file.')
  }
  if (liveExecutable.dev !== selectedExecutable.dev || liveExecutable.ino !== selectedExecutable.ino) {
    throw new UpdateRefusal('A selected systemd MainPID is running a different executable image from the installed file.')
  }
}

export async function assertRunningSupervisorProcess(
  pid: number,
  owner: ManagedRuntimeOwner,
  expectedImageReference: string,
): Promise<void> {
  if (!isDigest(expectedImageReference)) throw new UpdateRefusal('The expected supervisor workload image is not an immutable digest.')
  await validateProcessOwner(pid, owner.supervisorExecutable, owner.checkoutRoot)
  const argv = await readProcessArguments(pid)
  const imageIndex = argv.indexOf('--image-ref')
  if (imageIndex < 0 || argv[imageIndex + 1] !== expectedImageReference) {
    throw new UpdateRefusal('The live supervisor process image reference does not match the verified managed-runtime image.')
  }
}

async function readProcessArguments(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new UpdateRefusal('A selected supervisor process ID is invalid.')
  let contents: Buffer
  try { contents = await fsp.readFile(`/proc/${pid}/cmdline`) }
  catch { throw new UpdateRefusal('The selected supervisor process arguments could not be read.') }
  return contents.toString('utf8').split('\0').filter(argument => argument.length > 0)
}

function validateOwner(owner: ManagedRuntimeOwner, expectedCheckout: string): void {
  if (path.resolve(owner.checkoutRoot) !== path.resolve(expectedCheckout)) throw new UpdateRefusal('The selected owner checkout does not match the updater checkout.')
  if (owner.webUnit !== WEB_UNIT || owner.supervisorUnit !== SUPERVISOR_UNIT) throw new UpdateRefusal('The selected owner unit pair is ambiguous or unsupported.')
  if (!isDigest(owner.imageReference)) throw new UpdateRefusal('The selected workload image reference is not immutable.')
  for (const field of PATH_FIELDS) {
    const value = owner[field]
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new UpdateRefusal(`The selected owner ${String(field)} path is not absolute.`)
  }
  const expected = {
    webExecutable: path.join(owner.checkoutRoot, 'target/release/freshell-server'),
    supervisorExecutable: path.join(owner.checkoutRoot, 'target/release/freshell-supervisor'),
    adminCli: path.join(owner.checkoutRoot, 'target/release/freshell-supervisor-admin'),
    sessionHostBinary: path.join(owner.checkoutRoot, 'target/release/freshell-session-host'),
    clientDirectory: path.join(owner.checkoutRoot, 'dist/client'),
    environmentFile: path.join(owner.checkoutRoot, '.env'),
  }
  for (const [field, expectedPath] of Object.entries(expected)) {
    if (owner[field as keyof ManagedRuntimeOwner] !== expectedPath) throw new UpdateRefusal(`The selected ${field} path does not match the deployment checkout.`)
  }
}

function validateStagedArtifacts(mode: ManagedUpdateMode, artifacts: StagedArtifacts): void {
  if (mode !== 'durable-only' && (!artifacts.webExecutable || !artifacts.clientDirectory)) {
    throw new UpdateFailure('The web server and client assets were not staged.')
  }
  if (mode !== 'client' && (!artifacts.supervisorExecutable || !artifacts.adminCli || !artifacts.sessionHostBinary || !artifacts.imageId)) {
    throw new UpdateFailure('The durable runtime artifacts were not staged.')
  }
}

function sameFileIdentity(live: FileIdentity | null, selected: FileIdentity | null): boolean {
  return !!live && !!selected && live.path === selected.path && live.device === selected.device && live.inode === selected.inode
}

async function assertWebActionsSafe(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  mode: ManagedUpdateMode,
  phase: string,
): Promise<void> {
  let graph: SystemdUnitGraph
  try {
    graph = await dependencies.owner.inspectGraph(owner)
  } catch {
    throw new UpdateRefusal('Effective systemd unit relationships could not be inspected safely.')
  }
  if (webActionCanReachSupervisor(graph, owner.webUnit, owner.supervisorUnit)) {
    await record(dependencies, mode, phase, 'update.systemd_graph_refused', 'error', { error_code: 'web_action_reaches_supervisor' })
    throw new UpdateRefusal(GRAPH_REFUSAL)
  }
}

function groupInventory(snapshot: InventorySnapshot): Map<string, RuntimeView[]> {
  const views = Array.isArray(snapshot) ? snapshot : snapshot.views
  const groups = new Map<string, RuntimeView[]>()
  for (const view of views) {
    const rows = groups.get(view.soulId) ?? []
    rows.push(view)
    groups.set(view.soulId, rows)
  }
  for (const [soulId, rows] of groups) {
    const desired = new Set(rows.map(row => row.desiredState))
    const revisions = new Set(rows.map(row => row.intentRevision))
    if (desired.size !== 1 || revisions.size !== 1) throw new UpdateFailure(`Inventory contains conflicting authoritative state for ${soulId}.`)
  }
  return groups
}

function addressedIncarnation(rows: RuntimeView[]): RuntimeView | undefined {
  const active = rows.filter(view => ACTIVE_LAUNCH_STATES.has(view.launchState))
  return active.length ? active[active.length - 1] : rows[rows.length - 1]
}

function validatePreviouslyStoppedSouls(groups: Map<string, RuntimeView[]>, snapshot: InventorySnapshot): void {
  for (const [soulId, rows] of groups) {
    const current = addressedIncarnation(rows)
    if (!current) throw new UpdateFailure(`No incarnation is addressable for ${soulId}.`)
    if (current.desiredState === 'stopped' && current.cleanupState !== 'verified_empty') {
      throw new UpdateFailure(`The addressed incarnation for already-stopped soul ${soulId} is not VerifiedEmpty; it was not retried or polled.`)
    }
  }
  const records = Array.isArray(snapshot) ? [] : snapshot.noRuntime ?? []
  for (const item of records) {
    if (item.outcome !== 'verified_empty') {
      throw new UpdateFailure(`No-runtime soul ${item.soulId} is unresolved; refusing to stop or replace the managed runtime.`)
    }
    if (item.desiredState !== 'stopped') {
      throw new UpdateFailure(`No-runtime soul ${item.soulId} is not desired-stopped and cannot be safely reset without an addressable incarnation.`)
    }
  }
}

function validateNoRuntimeSnapshot(
  records: NoRuntimeInventoryRecord[],
  groups: Map<string, RuntimeView[]>,
): void {
  if (!Array.isArray(records)) throw new UpdateFailure('Candidate maintenance Inventory did not include an explicit no-runtime result.')
  const seen = new Set<string>()
  for (const record of records) {
    if (!nonEmpty(record.soulId) || !['running', 'stopped'].includes(record.desiredState)
      || !Number.isSafeInteger(record.intentRevision) || record.intentRevision < 0
      || !['verified_empty', 'unresolved'].includes(record.outcome)) {
      throw new UpdateFailure('Candidate maintenance Inventory returned an invalid no-runtime record.')
    }
    if (seen.has(record.soulId)) throw new UpdateFailure(`Candidate maintenance Inventory duplicated soul ${record.soulId}.`)
    seen.add(record.soulId)
    const liveViews = groups.get(record.soulId)
    if (liveViews) {
      const addressed = addressedIncarnation(liveViews)
      throw new UpdateFailure(
        `Candidate maintenance Inventory conflicts with live Inventory for ${record.soulId} `
        + `(registry revision ${record.intentRevision}; live revision ${addressed?.intentRevision ?? 'unknown'}; `
        + `live incarnation ${addressed?.incarnationId ?? 'unaddressable'}).`,
      )
    }
  }
}

function selectResetTargets(groups: Map<string, RuntimeView[]>): ManagedCodingSoulResetTarget[] {
  const targets: ManagedCodingSoulResetTarget[] = []
  for (const rows of groups.values()) {
    const current = addressedIncarnation(rows)
    if (!current || current.desiredState !== 'running' || !current.provider || !CODING_PROVIDERS.has(current.provider)) continue
    targets.push({ soulId: current.soulId, expectedIntentRevision: current.intentRevision, provider: current.provider, addressedView: current })
  }
  return targets
}

function collectReopenWork(
  snapshot: InventorySnapshot,
  groups: Map<string, RuntimeView[]>,
  targets: ManagedCodingSoulResetTarget[],
  stoppedIntentRevisions: Map<string, number>,
): { candidates: ReopenCandidate[]; unavailable: Array<{ soulId: string; provider: string }>; noReferenceCount: number; ineligibleReferenceCount: number } {
  const targetBySoul = new Map(targets.map(target => [target.soulId, target]))
  const candidates: ReopenCandidate[] = []
  const unavailable: Array<{ soulId: string; provider: string }> = []
  let noReferenceCount = 0
  let ineligibleReferenceCount = 0
  for (const [soulId, rows] of groups) {
    const target = targetBySoul.get(soulId)
    const current = target?.addressedView ?? addressedIncarnation(rows)
    if (!current || !current.provider || !CODING_PROVIDERS.has(current.provider)) continue
    const reference = referenceForView(current)
    if (reference.kind === 'none') {
      if (targetBySoul.has(soulId)) noReferenceCount += 1
      continue
    }
    const stoppedIntentRevision = stoppedIntentRevisions.get(soulId)
    if (!target || stoppedIntentRevision === undefined) {
      ineligibleReferenceCount += 1
      continue
    }
    if (reference.kind === 'missing_native') {
      unavailable.push({ soulId, provider: current.provider })
      continue
    }
    candidates.push({
      soulId, expectedIntentRevision: stoppedIntentRevision, provider: target.provider,
      conversation: reference.conversation,
    })
  }
  const noRuntime = Array.isArray(snapshot) ? [] : snapshot.noRuntime ?? []
  for (const item of noRuntime) {
    if (item.desiredState === 'running' && targetBySoul.has(item.soulId) && stoppedIntentRevisions.has(item.soulId)) {
      noReferenceCount += 1
    }
  }
  return { candidates, unavailable, noReferenceCount, ineligibleReferenceCount }
}

function referenceForView(view: RuntimeView):
  | { kind: 'none' }
  | { kind: 'missing_native' }
  | { kind: 'reference'; conversation: ReopenCandidate['conversation'] } {
  if (nonEmpty(view.freshAgentSessionId)) {
    return { kind: 'reference', conversation: { kind: 'fresh_agent', sessionId: view.freshAgentSessionId } }
  }
  if (nonEmpty(view.nativeSessionId)) {
    return {
      kind: 'reference',
      conversation: {
        kind: 'terminal', nativeSessionId: view.nativeSessionId,
        ...(nonEmpty(view.terminalResumeSessionId) ? { resumeSessionId: view.terminalResumeSessionId } : {}),
      },
    }
  }
  if (nonEmpty(view.terminalResumeSessionId)) return { kind: 'missing_native' }
  return { kind: 'none' }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

async function restoreWebAfterAbort(
  dependencies: ManagedRuntimeUpdateDependencies,
  owner: ManagedRuntimeOwner,
  mode: ManagedUpdateMode,
): Promise<{ restored: boolean; unitState: string; errorCode?: string }> {
  let active = false
  try { active = await dependencies.services.isActive(owner.supervisorUnit) } catch { /* report state below */ }
  if (!active) return { restored: false, unitState: 'supervisor-not-healthy', errorCode: 'supervisor_not_healthy' }
  try {
    const health = await dependencies.admin.health(owner)
    if (health.state !== 'ok') return { restored: false, unitState: 'supervisor-not-healthy', errorCode: 'supervisor_not_healthy' }
  } catch {
    return { restored: false, unitState: 'supervisor-not-healthy', errorCode: 'supervisor_not_healthy' }
  }
  try {
    await assertWebActionsSafe(dependencies, owner, mode, 'restore_web')
    await dependencies.services.start(owner.webUnit)
    await dependencies.services.waitWebReady(owner)
    await dependencies.services.waitCallbackReady(owner)
    return { restored: true, unitState: 'active' }
  } catch {
    let unitState = 'unknown'
    try { unitState = (await dependencies.services.isActive(owner.webUnit)) ? 'active' : 'inactive' } catch { /* keep unknown */ }
    return { restored: false, unitState, errorCode: 'web_restore_failed' }
  }
}

async function record(
  dependencies: ManagedRuntimeUpdateDependencies,
  mode: ManagedUpdateMode,
  phase: string,
  event: string,
  severity: 'info' | 'error',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await dependencies.logger.event({ event, severity, mode, phase, ...extra })
}

function reachable(edges: Map<string, string[]>, from: string, target: string): boolean {
  const pending = [from]
  const seen = new Set<string>()
  while (pending.length) {
    const current = pending.shift()!
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    pending.push(...(edges.get(current) ?? []))
  }
  return false
}

function makeUpdateId(date: Date, suffix: string): string {
  if (!/^[a-zA-Z0-9]{6,20}$/.test(suffix)) throw new Error('The update ID suffix is invalid.')
  const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})/, '$1')
  return `${timestamp}-${suffix}`
}

function minimalEnvironment(paths: UpdatePaths): Record<string, string> {
  const env: Record<string, string> = {
    HOME: paths.home,
    XDG_RUNTIME_DIR: paths.runtimeDirectory,
    PATH: paths.toolPath,
  }
  if (paths.pnpmHome) env.PNPM_HOME = paths.pnpmHome
  if (paths.cargoHome) env.CARGO_HOME = paths.cargoHome
  if (paths.rustupHome) env.RUSTUP_HOME = paths.rustupHome
  if (paths.cargoTargetDirectory) env.CARGO_TARGET_DIR = paths.cargoTargetDirectory
  return env
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function resolveCommand(name: string, options: { preserveSymlink?: boolean } = {}): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.resolve(directory, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return options.preserveSymlink ? candidate : fs.realpathSync(candidate)
    } catch { /* try next path entry */ }
  }
  throw new Error(`Required updater command ${name} was not found.`)
}

function randomHex(bytes: number): string {
  return [...cryptoRandomBytes(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function cryptoRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

export function createJsonLogger(knownLogPath?: string): ManagedRuntimeUpdateDependencies['logger'] {
  const getLogPath = () => knownLogPath ?? process.env.FRESHELL_UPDATE_LOG_PATH
  return {
    async event(event) {
      const line = JSON.stringify(event)
      const target = getLogPath()
      if (target) {
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await fsp.appendFile(target, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      }
      process.stdout.write(`${line}\n`)
    },
    async operator(line) { process.stdout.write(`${line}\n`) },
  }
}

export async function readExactApprovalLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const finish = (value: string) => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      process.stdin.pause()
      process.stdin.destroy()
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      finish(buffer.slice(0, newline))
    }
    const onEnd = () => finish(buffer)
    const onError = (error: Error) => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.pause()
      process.stdin.destroy()
      reject(error)
    }
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
  })
}

export async function buildSelectedArtifacts(
  paths: UpdatePaths,
  owner: ManagedRuntimeOwner,
  mode: ManagedUpdateMode,
  run: (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string,
  docker: ManagedRuntimeUpdateDependencies['docker'],
): Promise<StagedArtifacts> {
  const cargoTarget = paths.cargoTargetDirectory
  if (!cargoTarget) throw new UpdateFailure('An isolated Cargo target directory was not configured.')
  await fsp.mkdir(cargoTarget, { recursive: true, mode: 0o700 })
  const stageParent = path.join(paths.home, '.cache', 'freshell')
  await fsp.mkdir(stageParent, { recursive: true, mode: 0o700 })
  const stageRoot = await fsp.mkdtemp(path.join(stageParent, 'managed-runtime-update-'))
  const buildEnv = { ...minimalEnvironment(paths), CARGO_TARGET_DIR: cargoTarget }
  const artifacts: StagedArtifacts = { stagingRoot: stageRoot }
  try {
    if (mode !== 'durable-only') {
      const clientDirectory = path.join(stageRoot, 'client')
      run(paths.pnpm, ['exec', 'vite', 'build', '--config', path.join(paths.checkoutRoot, 'config/vite/vite.config.ts'),
        '--outDir', clientDirectory, '--emptyOutDir'], { cwd: paths.checkoutRoot, env: buildEnv })
      run(paths.cargo, ['build', '--release', '-p', 'freshell-server', '--features', 'managed-runtime-v1', '--locked'], {
        cwd: paths.checkoutRoot, env: buildEnv,
      })
      artifacts.webExecutable = await copyToStage(path.join(cargoTarget, 'release/freshell-server'), path.join(stageRoot, 'freshell-server'))
      artifacts.clientDirectory = clientDirectory
    }
    if (mode !== 'client') {
      run(paths.cargo, ['build', '--release', '-p', 'freshell-supervisor', '-p', 'freshell-session-host',
        '--locked'], { cwd: paths.checkoutRoot, env: buildEnv })
      run(paths.cargo, ['build', '--release', '-p', 'freshell-runtime-client', '--bin', 'freshell-supervisor-admin', '--locked'], {
        cwd: paths.checkoutRoot, env: buildEnv,
      })
      artifacts.supervisorExecutable = await copyToStage(path.join(cargoTarget, 'release/freshell-supervisor'), path.join(stageRoot, 'freshell-supervisor'))
      artifacts.adminCli = await copyToStage(path.join(cargoTarget, 'release/freshell-supervisor-admin'), path.join(stageRoot, 'freshell-supervisor-admin'))
      artifacts.sessionHostBinary = await copyToStage(path.join(cargoTarget, 'release/freshell-session-host'), path.join(stageRoot, 'freshell-session-host'))
      artifacts.imageId = await docker.buildImage(owner, owner.dockerSocket)
    }
    return artifacts
  } catch (error) {
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function copyToStage(source: string, target: string): Promise<string> {
  await fsp.copyFile(source, target)
  const stat = await fsp.stat(source)
  await fsp.chmod(target, stat.mode & 0o777)
  return target
}

function runAllowFailure(command: string, paths: UpdatePaths, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: minimalEnvironment(paths) })
  if (result.error) throw new UpdateFailure(`${path.basename(command)} could not run (${(result.error as NodeJS.ErrnoException).code ?? 'spawn_error'}).`)
  return { status: result.status, stdout: result.stdout.trim() }
}

function parseJsonOutput(output: string): Record<string, unknown> {
  try {
    const value = JSON.parse(output) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* produce a fixed safe failure below */ }
  throw new UpdateFailure('The supervisor admin CLI returned invalid JSON.')
}

function parseBuildInfoOutput(output: string): Record<string, unknown> {
  try {
    const value = JSON.parse(output) as unknown
    if (isRecord(value)) return value
  } catch { /* use the fixed safe error below */ }
  throw new UpdateRefusal('The selected web server returned invalid build-info JSON.')
}

function parseCandidateMaintenanceInventory(output: string): NoRuntimeInventoryRecord[] {
  const value = parseJsonOutput(output)
  if (!Array.isArray(value.noRuntime)) {
    throw new UpdateFailure('Candidate maintenance Inventory omitted the explicit no-runtime result.')
  }
  return value.noRuntime.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UpdateFailure('Candidate maintenance Inventory returned an invalid no-runtime record.')
    }
    const record = entry as Record<string, unknown>
    if (!nonEmpty(record.soulId) || !['running', 'stopped'].includes(String(record.desiredState))
      || !Number.isSafeInteger(record.intentRevision) || Number(record.intentRevision) < 0
      || !['verified_empty', 'unresolved'].includes(String(record.status))) {
      throw new UpdateFailure('Candidate maintenance Inventory returned an invalid no-runtime record.')
    }
    return {
      soulId: record.soulId,
      desiredState: String(record.desiredState),
      intentRevision: Number(record.intentRevision),
      outcome: record.status as NoRuntimeInventoryRecord['outcome'],
    }
  })
}

async function fileIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const [resolved, stat] = await Promise.all([fsp.realpath(filePath), fsp.stat(filePath)])
    return { path: resolved, device: stat.dev, inode: stat.ino }
  } catch { return null }
}

async function replaceFileOnDestination(source: string, target: string): Promise<void> {
  const directory = path.dirname(target)
  const sibling = path.join(directory, `.${path.basename(target)}.update-${process.pid}-${randomHex(6)}`)
  await fsp.copyFile(source, sibling)
  const sourceStat = await fsp.stat(source)
  await fsp.chmod(sibling, sourceStat.mode & 0o777)
  await fsp.rename(sibling, target)
}

function describeClientDirectoryActivationFailure(error: unknown): string {
  if (error instanceof ClientDirectoryActivationFailure) return error.message
  const detail = error instanceof Error ? error.message : 'an unknown filesystem error occurred'
  return `Client directory activation failed: ${detail}. The client directory state could not be verified.`
}

export async function swapDirectoryOnDestination(
  source: string,
  target: string,
  rename: typeof fsp.rename = fsp.rename,
): Promise<void> {
  const parent = path.dirname(target)
  const id = `${process.pid}-${randomHex(6)}`
  const replacement = path.join(parent, `.${path.basename(target)}.new-${id}`)
  const old = path.join(parent, `.${path.basename(target)}.old-${id}`)
  await fsp.cp(source, replacement, { recursive: true, errorOnExist: true, force: false })
  await rename(target, old)
  try {
    await rename(replacement, target)
  } catch {
    let rollbackError: unknown
    try {
      await rename(old, target)
    } catch (restoreError) {
      rollbackError = restoreError
    }
    await fsp.rm(replacement, { recursive: true, force: true }).catch(() => undefined)
    if (rollbackError) {
      throw new ClientDirectoryActivationFailure(
        `Client directory activation failed and the prior client directory could not be restored; it remains at ${old}.`,
        false,
      )
    }
    throw new ClientDirectoryActivationFailure(
      'Client directory activation failed; the prior client directory was restored.',
      true,
    )
  }
  await fsp.rm(old, { recursive: true, force: true })
}

async function replaceImageReference(environmentFile: string, imageId: string): Promise<void> {
  if (!isDigest(imageId)) throw new UpdateFailure('Refusing to install a non-immutable workload image reference.')
  const original = await fsp.readFile(environmentFile, 'utf8')
  const lines = original.split(/(?<=\n)/)
  const matches = lines.map((line, index) => /^\s*FRESHELL_RUNTIME_IMAGE\s*=/.test(line) ? index : -1).filter(index => index >= 0)
  if (matches.length !== 1) throw new UpdateRefusal('The selected workload environment file must contain exactly one FRESHELL_RUNTIME_IMAGE assignment.')
  const index = matches[0]!
  const newline = lines[index]!.endsWith('\n') ? '\n' : ''
  lines[index] = `FRESHELL_RUNTIME_IMAGE=${imageId}${newline}`
  const temp = `${environmentFile}.update-${process.pid}-${randomHex(6)}`
  const stat = await fsp.stat(environmentFile)
  await fsp.writeFile(temp, lines.join(''), { encoding: 'utf8', mode: stat.mode & 0o777, flag: 'wx' })
  await fsp.rename(temp, environmentFile)
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 30_000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new UpdateFailure('A selected service did not become ready before the timeout.')
}

async function waitHttpReady(address: string): Promise<void> {
  await waitUntil(() => httpReady(address))
}

async function httpReady(address: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/health', address), { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch { return false }
}

async function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: socketPath })
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1_000, () => finish(false))
  })
}

function readEnvironmentValue(contents: string, name: string): string | null {
  const matches = contents.split(/\r?\n/).filter(line => line.trim().startsWith(`${name}=`))
  if (matches.length !== 1) return null
  let value = matches[0]!.slice(name.length + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  return value
}

async function readProcessEnvironment(pid: number): Promise<Record<string, string>> {
  let contents: Buffer
  try { contents = await fsp.readFile(`/proc/${pid}/environ`) }
  catch { throw new UpdateRefusal('The verified live web process environment could not be read.') }
  const values = new Map<string, string>()
  for (const entry of contents.toString('utf8').split('\0')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const name = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    if (name === 'AUTH_TOKEN' && values.has(name) && values.get(name) !== value) {
      throw new UpdateRefusal('The verified live web process has ambiguous AUTH_TOKEN values.')
    }
    values.set(name, value)
  }
  return Object.fromEntries(values)
}

function commandForProperty(paths: UpdatePaths, unit: string, property: string, timeoutMs?: number): string {
  const result = spawnSync(paths.systemctl, ['--user', 'show', `--property=${property}`, '--value', unit], {
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' as const }),
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, env: minimalEnvironment(paths),
  })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new UpdateFailure(`systemctl timed out reading ${property} for ${unit} after ${timeoutMs ?? 'the configured'} ms.`)
  }
  if (result.error || result.status !== 0) throw new UpdateRefusal(`Effective systemd property ${property} could not be read for ${unit}.`)
  return result.stdout.trim()
}

async function main(): Promise<void> {
  if (!isScriptEntrypoint()) return
  const argv = process.argv.slice(2)
  const internal = parseInternalArgs(argv)
  if (argv[0] === '--bootstrap' || argv[0] === '--worker') {
    if (!internal || !processRunsInTransientUnit(internal.unitName)) { process.exitCode = 2; return }
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR
    if (!runtimeDirectory || !path.isAbsolute(runtimeDirectory)) { process.exitCode = 2; return }
    if (internal.kind === 'worker') {
      const expectedLogPath = path.join(os.homedir(), '.freshell', 'logs', `managed-runtime-update-${internal.runId}.jsonl`)
      const lockPath = path.join(runtimeDirectory, UPDATE_LOCK_NAME)
      if (process.env.FRESHELL_UPDATE_LOG_PATH !== expectedLogPath || !processHoldsLockFile(lockPath)) {
        process.exitCode = 2
        return
      }
    }
  } else if (!parseManagedUpdateMode(argv)) {
    process.exitCode = 2
    return
  }
  let deps: ManagedRuntimeUpdateDependencies
  const logPath = internal?.kind === 'bootstrap'
    ? path.join(os.homedir(), '.freshell', 'logs', `managed-runtime-update-${internal.runId}.jsonl`)
    : process.env.FRESHELL_UPDATE_LOG_PATH
  try { deps = createProductionDependencies(logPath) } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Updater initialization failed.'}\n`)
    process.exitCode = 2
    return
  }
  const result = internal
    ? internal.kind === 'bootstrap'
      ? await runManagedUpdateBootstrap(internal, deps)
      : await runManagedRuntimeWorker(internal.mode, deps, internal.approvalFile)
    : await runManagedUpdateCli(argv, deps)
  process.exitCode = result
}

function processRunsInTransientUnit(unitName: string): boolean {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8').split(/\r?\n/).some(line => {
      const hierarchyPath = line.split(':', 3)[2]
      return !!hierarchyPath && hierarchyPath.split('/').includes(unitName)
    })
  } catch { return false }
}

function processHoldsLockFile(lockPath: string): boolean {
  try {
    return fs.readdirSync('/proc/self/fd').some(descriptor => {
      try { return path.resolve(fs.readlinkSync(`/proc/self/fd/${descriptor}`)) === path.resolve(lockPath) }
      catch { return false }
    })
  } catch { return false }
}

function isScriptEntrypoint(): boolean {
  const argvPath = process.argv[1]
  return !!argvPath && pathToFileURL(path.resolve(argvPath)).href === import.meta.url
}

void main()
