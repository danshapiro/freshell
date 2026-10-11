import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ErrorCode, type ErrorMessage } from '../../shared/ws-protocol.js'
import { dockerSocketPath } from './runtime-sandbox.js'
import { providerParityFailureDiagnostics } from '../../test/helpers/provider-parity-environment.js'

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
  web: { capturedOutput(): { stdout: string; stderr: string } }
  runtime: { containerLogs(id: string): string; writeIncident(name: string, value: unknown): void;
    broker?: { receiptIds(): Set<string> } }
  supervisor: { containerId: string; runtimeRoot?: string }
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
    const reason = failureReasons.find(value => response.message.includes(value)) ?? inputReason
      ?? (filesystemLabel && osError !== undefined ? `${filesystemLabel} filesystem error` : 'UNKNOWN')
    const code = ErrorCode.safeParse(response.code)
    const web = owner.web.capturedOutput()
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
      server: { source: 'owned-server-typed-reply',
        capturedOutputAvailable: Boolean(web.stdout || web.stderr) }, supervisor, sessionHost,
    })
  }
  assert.equal(response.type, 'terminal.created')
}
