import type { SessionBindingReason } from '../terminal-stream/registry-events.js'

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export class CodexLaunchConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexLaunchConfigError'
  }
}

export function normalizeCodexSandboxSetting(sandbox: string | undefined): CodexSandboxMode | undefined {
  if (!sandbox) return undefined
  if (sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access') {
    return sandbox
  }
  throw new CodexLaunchConfigError(
    `Invalid Codex sandbox setting "${sandbox}". Expected read-only, workspace-write, or danger-full-access.`,
  )
}

export function getCodexSessionBindingReason(
  mode: string,
  requestedResumeSessionId?: string,
): Extract<SessionBindingReason, 'start' | 'resume'> | undefined {
  if (mode !== 'codex') return undefined
  return requestedResumeSessionId ? 'resume' : 'start'
}
