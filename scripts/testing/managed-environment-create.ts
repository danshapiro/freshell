import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ErrorCode, type ErrorMessage } from '../../shared/ws-protocol.js'
import { dockerSocketPath } from './runtime-sandbox.js'
import { providerParityFailureDiagnostics } from '../../test/helpers/provider-parity-environment.js'
import type { ManagedRuntimeBrowserRig } from '../../test/e2e-browser/helpers/managed-runtime.js'
import type { ManagedEnvironmentFixture } from './e2e-external-target.js'

export type ManagedEnvironmentAttempt = ManagedEnvironmentFixture & {
  scenario: string
  attempt: number
  createRequestId?: string
}

export type ManagedEnvironmentCompletion = ManagedEnvironmentAttempt & {
  status: string
  willRetry: boolean
}

export async function serviceManagedEnvironmentCases(
  fixture: ManagedEnvironmentFixture,
  operations: (scenario: 'healthy' | 'missing-reference' | 'startup-before-identity') => Parameters<typeof serviceManagedEnvironmentScenario>[2],
  joinBrowser: () => Promise<void>,
) {
  const cases = ['healthy', 'missing-reference', 'startup-before-identity'] as const
  const results = await Promise.allSettled(cases.map(async scenario =>
    serviceManagedEnvironmentScenario(fixture, scenario, operations(scenario))))
  // A failed service cannot tear down the target while another case or the
  // actual configured Cloud worker still owns its attempt.
  let joinFailure: unknown
  try { await joinBrowser() } catch (error) { joinFailure = error }
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  if (joinFailure !== undefined) throw joinFailure
}

export async function serviceManagedEnvironmentScenario(
  fixture: ManagedEnvironmentFixture, scenario: string,
  operations: {
    nextAttempt(attempt: number): Promise<{ request?: ManagedEnvironmentAttempt; completion?: ManagedEnvironmentCompletion }>
    authorize(requestId: string): void
    publishAuthorization(request: ManagedEnvironmentAttempt): Promise<void>
    onAuthorized(request: ManagedEnvironmentAttempt): Promise<void>
    waitForCompletion(request: ManagedEnvironmentAttempt): Promise<ManagedEnvironmentCompletion>
  },
) {
  const matchAttempt = (value: ManagedEnvironmentAttempt, attempt: number) => {
    for (const key of ['candidateSha', 'runId', 'remoteWorkspacePath', 'expectedNonce'] as const) assert.equal(value[key], fixture[key])
    assert.equal(value.scenario, scenario)
    assert.equal(value.attempt, attempt)
  }
  // The existing Cloud project permits two retries. A completion keeps this
  // fixture alive; it never supplies provider or terminal authority.
  for (let attempt = 0; attempt <= 2; attempt++) {
    const next = await operations.nextAttempt(attempt)
    let completion = next.completion
    if (next.request) {
      const request = next.request
      matchAttempt(request, attempt)
      assert.equal(typeof request.createRequestId, 'string')
      assert(request.createRequestId!.length > 0)
      operations.authorize(request.createRequestId!)
      await operations.publishAuthorization(request)
      await operations.onAuthorized(request)
      completion = await operations.waitForCompletion(request)
      assert.equal(completion.createRequestId, request.createRequestId)
    } else {
      assert(completion, 'Cloud attempt has neither request nor completion')
      assert.equal(completion.createRequestId, undefined, 'Pre-picker completion cannot invent a request')
      assert.notEqual(completion.status, 'passed', 'A successful case must have its real request')
    }
    matchAttempt(completion, attempt)
    assert(['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(completion.status))
    assert.equal(typeof completion.willRetry, 'boolean')
    if (!completion.willRetry) return
    assert.notEqual(completion.status, 'passed')
    assert(attempt < 2, 'Cloud attempt exceeded the existing retry count')
  }
}

export async function observeManagedEnvironmentNativeIdentity(
  owner: Pick<ManagedRuntimeBrowserRig, 'inventory' | 'runtime' | 'supervisor'>,
  terminalId: string, nativeSessionId: string,
) {
  const current = (await owner.inventory()).find(row => row.terminalId === terminalId
    && row.launchState === 'running')
  if (!current) return
  // Native identity is published by the existing authenticated output reader;
  // inventory alone only returns the stored registry snapshot.
  await owner.runtime.adminOk(owner.supervisor,
    owner.runtime.terminalReadOutputBody(current.soulId, 0, 64 * 1024))
  return (await owner.inventory()).find(row => row.terminalId === terminalId
    && row.nativeSessionId === nativeSessionId && row.launchState === 'running')
}

export async function readManagedEnvironmentDaemonId(): Promise<string> {
  const dockerHost = process.env.DOCKER_HOST
  assert(!dockerHost || dockerHost.startsWith('unix://'), 'Managed target requires the existing local Unix Docker endpoint')
  const socketPath = dockerSocketPath()
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/v1.47/info', timeout: 30_000 }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error('Daemon metadata exceeded its bound')); else chunks.push(chunk) })
      response.once('end', () => {
        try { assert.equal(response.statusCode, 200); const value = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(typeof value.ID, 'string'); resolve(value.ID) }
        catch (error) { reject(error) }
      })
    })
    request.once('timeout', () => request.destroy(new Error('Daemon metadata timed out')))
    request.once('error', reject)
  })
}

type ManagedCreateOwner = {
  web: { capturedOutput(): { stdout: string; stderr: string }; info: { logsDir: string } }
  runtime: { containerLogs(id: string): string; writeIncident(name: string, value: unknown): void;
    broker?: { receiptIds(): Set<string> } }
  supervisor: { containerId: string; runtimeRoot?: string }
}

const safeLogLevels = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'])

export function summarizeProviderPreparationFailure(
  value: ErrorMessage['providerPreparationFailure'],
): Pick<NonNullable<ErrorMessage['providerPreparationFailure']>, 'code' | 'stage' | 'operation' | 'cause'> | undefined {
  if (!value) return undefined
  return { code: value.code, stage: value.stage, operation: value.operation, cause: value.cause }
}

const runtimeErrorCodes = [
  'InvalidRequest', 'ProviderInputsChanged', 'ProtocolVersionMismatch', 'UnauthorizedRole', 'FrameTooLarge',
  'RequestIdConflict', 'RegistryBusy', 'RegistryFailure', 'StaleControlEpoch', 'StaleIntentRevision',
  'LossCertificationBlocked', 'IncidentPersistenceFailed', 'NoticeNotFound', 'MigrationBlocked', 'RepairBlocked',
  'UnknownSoul', 'UnknownIncarnation', 'OwnershipMismatch', 'BackendUnavailable', 'TerminationUnconfirmed',
  'HostUnreachable', 'HostAuthenticationFailed', 'StaleExecutionGrant', 'InvalidRuntimeLimits', 'BlockedResource',
  'CommandAmbiguous', 'OutputCursorExpired', 'UnsupportedWorkload', 'UnsupportedOperation',
  'OperationImplementationUnavailable', 'FaultInjected', 'RecoveryBlocked', 'RecoveryImplementationUnavailable',
  'RecoveryWrongIdentity', 'RecoveryRetryBudget', 'RecoveryInProgress', 'RecoveryStopUnconfirmed',
] as const

export function summarizeRuntimeErrorCode(message: string): typeof runtimeErrorCodes[number] | undefined {
  const prefix = 'runtime supervisor rejected request: '
  const index = message.indexOf(prefix)
  if (index < 0) return undefined
  const rejection = message.slice(index + prefix.length)
  return runtimeErrorCodes.find(code => rejection.startsWith(`${code}:`))
}

export function summarizeRuntimeErrorClass(message: string):
  'supervisor_io' | 'supervisor_protocol' | 'supervisor_rejected' | 'supervisor_unexpected_reply' | undefined {
  if (message.includes('runtime supervisor I/O failed: ')) return 'supervisor_io'
  if (message.includes('runtime supervisor protocol failed: ')) return 'supervisor_protocol'
  if (message.includes('runtime supervisor rejected request: ')) return 'supervisor_rejected'
  if (message.includes('runtime supervisor returned an unexpected result')) return 'supervisor_unexpected_reply'
  return undefined
}

export function summarizeRustServerLogEvents(raw: string): Array<{
  level: string
  event?: string
  target?: string
  fields: string[]
}> {
  const boundedTail = raw.slice(-512 * 1024)
  const summary: Array<{ level: string; event?: string; target?: string; fields: string[] }> = []
  for (const line of boundedTail.split('\n').slice(-256)) {
    if (line.length > 64 * 1024) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const event = typeof record.event === 'string' && /^[a-z][a-z0-9_.:-]{0,127}$/.test(record.event)
      ? record.event : undefined
    const target = typeof record.target === 'string' && /^[a-zA-Z0-9_:.$-]{1,160}$/.test(record.target)
      ? record.target : undefined
    if ((typeof record.event === 'string' && event === undefined) || (!event && !target)
      || typeof record.level !== 'string' || !safeLogLevels.has(record.level)) continue
    const sensitiveFieldName = /token|secret|auth|prompt|content|payload|message|text|config|password|credential|key|path|url|body/i
    const fields = Object.keys(record)
      .filter(key => !['ts', 'level', 'target', 'app_version', 'server_pid', 'event', 'msg'].includes(key)
        && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && !sensitiveFieldName.test(key))
      .sort()
      .slice(0, 24)
    summary.push({ level: record.level, ...(event ? { event } : {}), ...(target ? { target } : {}), fields })
  }
  return summary.slice(-32)
}

const maxRustServerLogTailBytes = 512 * 1024

function readRustServerLogEvents(logPath: string): ReturnType<typeof summarizeRustServerLogEvents> {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(logPath, 'r')
    const metadata = fs.fstatSync(descriptor)
    if (!metadata.isFile()) return []
    const byteLength = Math.min(metadata.size, maxRustServerLogTailBytes)
    const buffer = Buffer.allocUnsafe(byteLength)
    const position = metadata.size - byteLength
    let bytesRead = 0
    while (bytesRead < byteLength) {
      const count = fs.readSync(descriptor, buffer, bytesRead, byteLength - bytesRead, position + bytesRead)
      if (count === 0) break
      bytesRead += count
    }
    return summarizeRustServerLogEvents(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch {
    return []
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* A diagnostic descriptor may already be closed. */ }
    }
  }
}

const failureReasons = [
  'OneCLI grant is unavailable',
  'prepared private source unreadable',
  'initial provider source lost its current prepared reservation',
  'runtime image must be pinned by sha256 id/digest',
  'provider volume name is not installation-scoped',
  'initial auth reservation does not match the prepared runtime',
  'initial auth reserved runtime artifact changed or unreadable',
  'workspace path must already be canonical',
  'cwd path must already be canonical',
  'terminal cwd must be inside the approved workspace',
  'provider bootstrap file must be a canonical regular file',
  'provider secret reference must be a canonical regular file',
  'provider OneCLI grant must be private',
  'referenced provider user root is unavailable',
  'prepared provider stage is unavailable',
  'managed MCP grant must be a canonical regular file',
  'managed MCP grant must be private',
  'prepared input file is unavailable',
  'prepared input file must be physical and stage-owned',
  'prepared input manifest changed; reprepare before mount construction',
  'selected prepared resource is unavailable',
  'prepared resource is not a physical staged unit',
  'selected workspace input mountpoint is unavailable',
  'selected workspace input topology changed; reprepare before launch',
  'managed provider launch context is unsafe or mismatched',
  'managed provider grant profile, destination or capacity is invalid',
  'prepared provider file indexes do not match approved configuration grants; reprepare before launch',
  'prepared config template is unavailable',
  'prepared config template read failed',
  'prepared input manifest is unavailable',
  'prepared input manifest read failed',
  'selected prepared resource metadata failed',
  'prepared input file metadata failed',
  'selected workspace input mountpoint metadata failed',
  'git common dir must already be canonical',
  'provider user root escaped its approved source root',
  'managed provider root must be canonical',
  'invalid managed MCP grant id',
  'host binary is not a regular file',
  'runtime dir is not a directory',
] as const

const activationStages = ['capability_pending', 'ensure_runtime_directory', 'ensure_host_actor_directory',
  'revalidate_initial_provider_source', 'create_stopped_runtime', 'commit_backend_identity',
  'load_owned_handle', 'authenticate_running_host', 'read_running_host_status', 'adopt_running_worker',
  'start_session_host', 'authenticate_started_host', 'commit_execution_grant', 'enable_long_lived_runtime',
  'deliver_execution_grant',
  'record_native_identity', 'commit_running_state', 'commit_provider_inputs', 'load_running_view']

export function assertManagedTerminalCreated(owner: ManagedCreateOwner,
  response: ErrorMessage | { type: 'terminal.created' }) {
  if (response.type === 'error') {
    // Persist only fixed classifications. Provider config, credentials and
    // conversation text can occur in error/log payloads and stay out of it.
    const inputFields = ['control byte limit', 'initial auth reservation', 'generation', 'manifest', 'resource entries',
      'mount destination', 'logical destination', 'effective destination', 'configuration source', 'resource source',
      'indexed file publication', 'indexed source ID', 'ancestor destination']
    const inputReason = inputFields.map(field => `prepared provider inputs ${field}`)
      .find(value => response.message.includes(`${value}: invalid, conflicting or over-bound metadata`))
    const filesystemLabels = ['host binary', 'runtime dir', 'workspace', 'cwd', 'git common dir',
      'provider bootstrap file', 'provider secret reference']
    const filesystemLabel = filesystemLabels.find(value => response.message.includes(`${value}:`))
    const errno = response.message.match(/\(os error (\d{1,4})\)/)
    const osError = errno ? Number(errno[1]) : undefined
    const runtimeErrorCode = summarizeRuntimeErrorCode(response.message)
    const runtimeErrorClass = summarizeRuntimeErrorClass(response.message)
    const reason = failureReasons.find(value => response.message.includes(value)) ?? inputReason
      ?? (filesystemLabel && osError !== undefined ? `${filesystemLabel} filesystem error` : 'UNKNOWN')
    const code = ErrorCode.safeParse(response.code)
    const web = owner.web.capturedOutput()
    const serverLogEvents = readRustServerLogEvents(path.join(owner.web.info.logsDir, 'rust-server.jsonl'))
    let supervisor: Record<string, string> | 'UNKNOWN' = 'UNKNOWN'
    let sessionHost: Record<string, unknown> | 'UNKNOWN' = 'UNKNOWN'
    try {
      let lifecycle = ''
      if (owner.supervisor.runtimeRoot) {
        // This is the supervisor's exact owned lifecycle path, also collected
        // by RuntimeHarness cleanup. It is not written to Docker stdout.
        const file = path.join(path.dirname(owner.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl')
        try {
          if (fs.statSync(file).size <= 2 * 1024 * 1024) lifecycle = fs.readFileSync(file, 'utf8').slice(-20_000)
        } catch { /* Missing owning-file evidence remains unknown. */ }
      }
      // Host identities come from this supervisor's owned lifecycle file.
      // A matching broker receipt is required before reading that host's logs.
      const startedHosts = new Map<string, string>()
      let failedIncarnation: string | undefined
      for (const line of lifecycle.split('\n')) {
        try {
          const entry = JSON.parse(line)
          const data = entry.data
          if (typeof data?.incarnationId !== 'string') continue
          if (entry.event === 'supervisor.host_started'
            && typeof data.containerId === 'string' && /^[a-f0-9]{64}$/.test(data.containerId)) {
            startedHosts.set(data.incarnationId, data.containerId)
          } else if (entry.event === 'supervisor.activation_failed') {
            failedIncarnation = data.incarnationId
          }
        } catch { /* Invalid owning-file evidence cannot select a host. */ }
      }
      const logs = `${owner.runtime.containerLogs(owner.supervisor.containerId)}\n${lifecycle}`
      for (const line of logs.split('\n')) {
        try {
          const entry = JSON.parse(line)
          if (entry.event !== 'supervisor.activation_failed') continue
          const data = entry.data
          supervisor = { event: 'supervisor.activation_failed',
            stage: activationStages.includes(data?.stage) ? data.stage : 'UNKNOWN',
            errorCode: ['BACKEND_UNAVAILABLE', 'OWNERSHIP_MISMATCH', 'INVALID_REQUEST', 'REGISTRY_FAILURE',
              'HOST_UNREACHABLE'].includes(data?.errorCode) ? data.errorCode : 'UNKNOWN' }
        } catch { /* Non-JSON owning-process output is not retained. */ }
      }
      const hostId = failedIncarnation && startedHosts.get(failedIncarnation)
      if (hostId && owner.runtime.broker?.receiptIds().has(hostId)) {
        sessionHost = { containerId: hostId,
          ...providerParityFailureDiagnostics(owner.runtime.containerLogs(hostId)) }
      }
    } catch { /* An absent owned supervisor leaves its observation unknown. */ }
    owner.runtime.writeIncident('managed-environment-create-failure', {
      severity: 'error', event: 'managed_environment.create_failed', code: code.success ? code.data : 'UNKNOWN', reason, ...(osError === undefined ? {} : { osError }),
      serverLogEvents,
      ...(runtimeErrorCode ? { runtimeErrorCode } : {}),
      ...(runtimeErrorClass ? { runtimeErrorClass } : {}),
      ...(response.providerPreparationFailure
        ? { providerPreparationFailure: summarizeProviderPreparationFailure(response.providerPreparationFailure) }
        : {}),
      server: { source: 'owned-server-typed-reply',
        capturedOutputAvailable: Boolean(web.stdout || web.stderr) }, supervisor, sessionHost,
    })
  }
  assert.equal(response.type, 'terminal.created')
}
