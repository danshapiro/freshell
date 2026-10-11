import assert from 'node:assert/strict'
import { ErrorCode, type ErrorMessage } from '../../shared/ws-protocol.js'

type ManagedCreateOwner = {
  web: { capturedOutput(): { stdout: string; stderr: string } }
  runtime: { containerLogs(id: string): string; writeIncident(name: string, value: unknown): void }
  supervisor: { containerId: string }
}

const failureReasons = [
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
] as const

const activationStages = ['capability_pending', 'ensure_runtime_directory', 'ensure_host_actor_directory',
  'revalidate_initial_provider_source', 'create_stopped_runtime', 'commit_backend_identity',
  'load_owned_handle', 'authenticate_running_host', 'read_running_host_status', 'adopt_running_worker',
  'start_session_host', 'authenticate_started_host', 'commit_execution_grant', 'enable_long_lived_runtime',
  'record_native_identity', 'commit_running_state', 'commit_provider_inputs', 'load_running_view']

export function assertManagedTerminalCreated(owner: ManagedCreateOwner,
  response: ErrorMessage | { type: 'terminal.created' }) {
  if (response.type === 'error') {
    // Persist only fixed classifications. Provider config, credentials and
    // conversation text can occur in error/log payloads and stay out of it.
    const reason = failureReasons.find(value => response.message.includes(value)) ?? 'UNKNOWN'
    const code = ErrorCode.safeParse(response.code)
    const web = owner.web.capturedOutput()
    let supervisor: Record<string, string> | 'UNKNOWN' = 'UNKNOWN'
    try {
      for (const line of owner.runtime.containerLogs(owner.supervisor.containerId).split('\n')) {
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
    } catch { /* An absent owned supervisor leaves its observation unknown. */ }
    owner.runtime.writeIncident('managed-environment-create-failure', {
      severity: 'error', event: 'managed_environment.create_failed', code: code.success ? code.data : 'UNKNOWN', reason,
      server: { source: 'owned-server-typed-reply',
        capturedOutputAvailable: Boolean(web.stdout || web.stderr) }, supervisor,
    })
  }
  assert.equal(response.type, 'terminal.created')
}
