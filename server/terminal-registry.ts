import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import type { LiveWebSocket } from './ws-handler.js'
import * as pty from 'node-pty'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog, startPerfTimer } from './perf-logger.js'
import type { ServerSettings } from '../shared/settings.js'
import type { SessionLocator } from '../shared/ws-protocol.js'
import {
  CODEX_DURABILITY_SCHEMA_VERSION,
  type CodexCandidateSource,
  type CodexDurabilityRef,
  type CodexDurabilityStoreRecord,
} from '../shared/codex-durability.js'
import { convertWindowsPathToWslPath, isReachableDirectorySync } from './path-utils.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
import type { LoopbackServerEndpoint } from './local-port.js'
import { makeSessionKey, parseSessionKey, type CodingCliProviderName } from './coding-cli/types.js'
import { SessionBindingAuthority, type BindResult } from './session-binding-authority.js'
import type {
  CodexTurnCompletedEvent,
  CodexTurnStartedEvent,
  SessionBindingReason,
  SessionUnbindReason,
  TerminalInputRawEvent,
  TerminalOutputRawEvent,
  TerminalSessionBoundEvent,
  TerminalSessionUnboundEvent,
} from './terminal-stream/registry-events.js'
import { getOpencodeEnvOverrides, resolveOpencodeLaunchModel } from './opencode-launch.js'
import { generateMcpInjection, cleanupMcpConfig } from './mcp/config-writer.js'
import { CODEX_MANAGED_REMOTE_CONFIG_ARGS } from './coding-cli/codex-managed-config.js'
import type { CodexLaunchPlan, CodexLaunchSidecar } from './coding-cli/codex-app-server/launch-planner.js'
import { isCodexSidecarTeardownError } from './coding-cli/codex-app-server/launch-planner.js'
import {
  CodexDurabilityStore,
  type CodexDurabilityRestoreLocator,
} from './coding-cli/codex-app-server/durability-store.js'
import { proofCodexRollout } from './coding-cli/codex-app-server/durability-proof.js'
import type { CodexRemoteProxyCandidate } from './coding-cli/codex-app-server/remote-proxy.js'
import type { CodexTurnEvent } from './coding-cli/codex-app-server/client.js'
import { collectShutdownFailures, throwShutdownFailures } from './shutdown-join.js'
import { recordSessionLifecycleEvent } from './session-observability.js'

const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
const DEFAULT_MAX_SCROLLBACK_CHARS = Number(process.env.MAX_SCROLLBACK_CHARS || 512 * 1024)
const MIN_SCROLLBACK_CHARS = 64 * 1024
const MAX_SCROLLBACK_CHARS = 4 * 1024 * 1024
const APPROX_CHARS_PER_LINE = 300
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS || 50)
const DEFAULT_MAX_PENDING_SNAPSHOT_CHARS = 512 * 1024
const OUTPUT_FLUSH_MS = Number(process.env.OUTPUT_FLUSH_MS || process.env.MOBILE_OUTPUT_FLUSH_MS || 40)
const MAX_OUTPUT_BUFFER_CHARS = Number(process.env.MAX_OUTPUT_BUFFER_CHARS || process.env.MAX_MOBILE_OUTPUT_BUFFER_CHARS || 256 * 1024)
const MAX_OUTPUT_FRAME_CHARS = Math.max(1, Number(process.env.MAX_OUTPUT_FRAME_CHARS || 8192))
const CODEX_CLEAN_EXIT_RECENT_INPUT_GRACE_MS = Math.max(0, Number(process.env.CODEX_CLEAN_EXIT_RECENT_INPUT_GRACE_MS || 750))
const CODEX_CLEAN_EXIT_LIFECYCLE_LOSS_GRACE_MS = Math.max(0, Number(process.env.CODEX_CLEAN_EXIT_LIFECYCLE_LOSS_GRACE_MS || 2000))
const perfConfig = getPerfConfig()

// TerminalMode is now a wider type -- any string is valid as a mode name.
// 'shell' is the only built-in; all CLI modes come from registered extensions.
export type TerminalMode = 'shell' | (string & {})
export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

export type CodingCliCommandSpec = {
  label: string
  envVar: string
  defaultCommand: string
  args?: string[]
  env?: Record<string, string>
  resumeArgs?: (sessionId: string) => string[]
  modelArgs?: (model: string) => string[]
  sandboxArgs?: (sandbox: string) => string[]
  permissionModeArgs?: (permissionMode: string) => string[]
  permissionModeEnvVar?: string
  permissionModeEnvValues?: Record<string, string>
}

const FALLBACK_CODING_CLI_COMMAND_SPECS: Array<[string, CodingCliCommandSpec]> = [
  ['claude', {
    label: 'Claude CLI',
    envVar: 'CLAUDE_CMD',
    defaultCommand: 'claude',
    resumeArgs: (sessionId: string) => ['--resume', sessionId],
    permissionModeArgs: (permissionMode: string) => ['--permission-mode', permissionMode],
  }],
  ['codex', {
    label: 'Codex CLI',
    envVar: 'CODEX_CMD',
    defaultCommand: 'codex',
    resumeArgs: (sessionId: string) => ['resume', sessionId],
    modelArgs: (model: string) => ['--model', model],
    sandboxArgs: (sandbox: string) => ['--sandbox', sandbox],
  }],
  ['opencode', {
    label: 'OpenCode',
    envVar: 'OPENCODE_CMD',
    defaultCommand: 'opencode',
    resumeArgs: (sessionId: string) => ['--session', sessionId],
    modelArgs: (model: string) => ['--model', model],
  }],
  ['gemini', {
    label: 'Gemini',
    envVar: 'GEMINI_CMD',
    defaultCommand: 'gemini',
  }],
  ['kimi', {
    label: 'Kimi',
    envVar: 'KIMI_CMD',
    defaultCommand: 'kimi',
  }],
]

// Compatibility seed for tests and standalone registry instances that are
// constructed before server bootstrap registers the scanned extension commands.
let codingCliCommands: Map<string, CodingCliCommandSpec> = new Map(FALLBACK_CODING_CLI_COMMAND_SPECS)

/**
 * Populate the CLI commands map from extension data.
 * Called once at server startup after extensions are scanned.
 */
export function registerCodingCliCommands(specs: Map<string, CodingCliCommandSpec>): void {
  codingCliCommands = specs
}

/**
 * The set of terminal modes that can actually be spawned: the built-in 'shell'
 * plus every registered coding-CLI mode (claude, codex, opencode, ...).
 */
export function getKnownTerminalModes(): TerminalMode[] {
  return ['shell', ...codingCliCommands.keys()]
}

/** Whether `mode` can be spawned (the built-in shell or a registered coding CLI). */
export function isKnownTerminalMode(mode: TerminalMode): boolean {
  return mode === 'shell' || codingCliCommands.has(mode)
}

/**
 * Thrown when a spawn is requested for a mode that is neither the built-in
 * 'shell' nor a registered coding-CLI extension. Guards against buildSpawnSpec's
 * old behaviour of falling back to exec-ing the mode name itself, which produced
 * a terminal that immediately died with "execvp(3) failed: No such file or
 * directory" (e.g. new-tab({ mode: 'terminal' })).
 */
export class UnknownTerminalModeError extends Error {
  constructor(public readonly mode: string) {
    super(`Invalid terminal mode: '${mode}'. Valid: ${getKnownTerminalModes().join(', ')}`)
    this.name = 'UnknownTerminalModeError'
  }
}

/**
 * Check if a terminal mode supports session resume.
 * Only modes with configured resumeArgs in CODING_CLI_COMMANDS support resume.
 */
export function modeSupportsResume(mode: TerminalMode): boolean {
  if (mode === 'shell') return false
  return !!codingCliCommands.get(mode)?.resumeArgs
}

type TerminalSessionRefSource = Pick<TerminalRecord, 'mode' | 'resumeSessionId'> & {
  codexDurability?: CodexDurabilityRef
}

export function buildTerminalSessionRef(record: TerminalSessionRefSource): SessionLocator | undefined {
  if (!modeSupportsResume(record.mode as TerminalMode)) return undefined
  if (!record.resumeSessionId) return undefined
  if (
    record.mode === 'codex'
    && (
      record.codexDurability?.state !== 'durable'
      || record.codexDurability.durableThreadId !== record.resumeSessionId
    )
  ) {
    return undefined
  }

  return {
    provider: record.mode as CodingCliProviderName,
    sessionId: record.resumeSessionId,
  }
}

type ProviderTarget = 'unix' | 'windows'

function providerNotificationArgs(
  mode: TerminalMode,
  target: ProviderTarget,
  terminalId: string,
  cwd?: string,
): { args: string[]; env: Record<string, string> } {
  const mcpInjection = generateMcpInjection(mode, terminalId, cwd, target)

  if (mode === 'codex') {
    return {
      args: ['-c', 'tui.notification_method=bel', '-c', "tui.notifications=['agent-turn-complete']", ...mcpInjection.args],
      env: mcpInjection.env,
    }
  }

  if (mode === 'claude') {
    const bellCommand = target === 'windows'
      ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$bell=[char]7; $ok=$false; try {[System.IO.File]::AppendAllText('\\\\.\\CONOUT$', [string]$bell); $ok=$true} catch {}; if (-not $ok) { try {[Console]::Out.Write($bell); $ok=$true} catch {} }; if (-not $ok) { try {[Console]::Error.Write($bell)} catch {} }"`
      : `sh -lc "printf '\\a' > /dev/tty 2>/dev/null || true"`
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: bellCommand,
              },
            ],
          },
        ],
      },
    }
    return {
      args: ['--settings', JSON.stringify(settings), ...mcpInjection.args],
      env: mcpInjection.env,
    }
  }

  return { args: mcpInjection.args, env: mcpInjection.env }
}

export type ProviderSettings = {
  permissionMode?: string
  model?: string
  sandbox?: string
  codexAppServer?: {
    wsUrl: string
    sidecar?: CodexLaunchSidecar
    recovery?: CodexRecoveryOptions
    deferLifecycleUntilPublished?: boolean
  }
  opencodeServer?: LoopbackServerEndpoint
}

export type CodexRecoveryLaunchInput = {
  terminalId: string
  generation: number
  cwd?: string
  resumeSessionId: string
}

export type CodexRecoveryOptions = {
  planCreate(input: CodexRecoveryLaunchInput): Promise<CodexLaunchPlan>
  retryDelayMs?: number
}

export type CodexDurabilityRestoreRecord = {
  terminalId: string
  durability: CodexDurabilityRef
}

function resolveCodingCliCommand(
  mode: TerminalMode,
  resumeSessionId?: string,
  target: ProviderTarget = 'unix',
  providerSettings?: ProviderSettings,
  terminalId?: string,
  cwd?: string,
) {
  if (mode === 'shell') return null
  const spec = codingCliCommands.get(mode)
  if (!spec) return null
  const command = (spec.envVar && process.env[spec.envVar]) || spec.defaultCommand
  const notification = providerNotificationArgs(mode, target, terminalId || '', cwd)
  const providerArgs = notification.args
  const baseArgs = spec.args || []
  const commandEnv: Record<string, string> = { ...(spec.env || {}), ...notification.env }
  const remoteArgs: string[] = []
  if (mode === 'opencode') {
    Object.assign(commandEnv, getOpencodeEnvOverrides({ ...process.env, ...commandEnv }))
  }
  if (mode === 'codex' && providerSettings?.codexAppServer) {
    const wsUrl = providerSettings.codexAppServer.wsUrl
    let parsed: URL
    try {
      parsed = new URL(wsUrl)
    } catch {
      throw new Error('Codex launch requires a valid loopback app-server websocket URL.')
    }
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') {
      throw new Error('Codex launch requires a loopback app-server websocket URL.')
    }
    remoteArgs.push('--remote', wsUrl, ...CODEX_MANAGED_REMOTE_CONFIG_ARGS)
  }
  let resumeArgs: string[] = []
  if (resumeSessionId) {
    if (spec.resumeArgs) {
      resumeArgs = spec.resumeArgs(resumeSessionId)
    } else {
      logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
    }
  }
  const settingsArgs: string[] = []
  if (mode === 'opencode') {
    const endpoint = providerSettings?.opencodeServer
    if (
      !endpoint
      || endpoint.hostname !== '127.0.0.1'
      || !Number.isInteger(endpoint.port)
      || endpoint.port <= 0
      || endpoint.port > 65535
    ) {
      throw new Error('OpenCode launch requires an allocated localhost control endpoint.')
    }
    settingsArgs.push(
      '--hostname',
      endpoint.hostname,
      '--port',
      String(endpoint.port),
    )
  }
  const effectiveModel = mode === 'opencode'
    ? (resumeSessionId
        ? undefined
        : resolveOpencodeLaunchModel(providerSettings?.model, { ...process.env, ...commandEnv }))
    : providerSettings?.model
  if (effectiveModel && spec.modelArgs) {
    settingsArgs.push(...spec.modelArgs(effectiveModel))
  }
  if (providerSettings?.sandbox && spec.sandboxArgs) {
    settingsArgs.push(...spec.sandboxArgs(providerSettings.sandbox))
  }
  if (providerSettings?.permissionMode && providerSettings.permissionMode !== 'default') {
    if (spec.permissionModeArgs) {
      settingsArgs.push(...spec.permissionModeArgs(providerSettings.permissionMode))
    }
    if (spec.permissionModeEnvVar) {
      const permissionValue =
        spec.permissionModeEnvValues?.[providerSettings.permissionMode] ??
        providerSettings.permissionMode
      if (permissionValue) {
        commandEnv[spec.permissionModeEnvVar] = permissionValue
      } else {
        logger.warn(
          { mode, permissionMode: providerSettings.permissionMode },
          'Permission mode requested but no env mapping configured',
        )
      }
    }
  }
  return {
    command,
    args: [...remoteArgs, ...providerArgs, ...baseArgs, ...settingsArgs, ...resumeArgs],
    env: commandEnv,
    label: spec.label,
  }
}

/**
 * Normalize a resume identifier for spawning the CLI process.
 * Claude Code accepts both UUIDs and human-readable names for --resume.
 * Returns the raw value for any non-empty string; undefined for empty/missing.
 */
function normalizeResumeForSpawn(_mode: TerminalMode, resumeSessionId?: string): string | undefined {
  if (!resumeSessionId) return undefined
  return resumeSessionId
}

/**
 * Normalize a resume identifier for session binding (the authoritative
 * terminal-to-session association).  Claude session files are UUID-named,
 * so only valid UUIDs can be used as binding keys.  Other providers
 * accept any non-empty string.
 */
function normalizeResumeForBinding(mode: TerminalMode, resumeSessionId?: string): string | undefined {
  if (!resumeSessionId) return undefined
  if (mode !== 'claude') return resumeSessionId
  if (isValidClaudeSessionId(resumeSessionId)) return resumeSessionId
  return undefined
}

function matchesScopedSession(mode: TerminalMode, term: TerminalRecord, sessionId: string, _cwd?: string): boolean {
  return term.mode === mode
    && term.resumeSessionId === sessionId
}

function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = codingCliCommands.get(mode)?.label
  return label || mode.charAt(0).toUpperCase() + mode.slice(1)
}

function getModeCommandOverrideEnvVar(mode: TerminalMode): string | undefined {
  if (mode === 'shell') return undefined
  return codingCliCommands.get(mode)?.envVar
}

function wrapTerminalSpawnError(
  err: unknown,
  opts: {
    mode: TerminalMode
    file: string
    resumeSessionId?: string
  },
): Error {
  const base = err instanceof Error ? err : new Error(String(err))
  const baseWithCode = base as Error & { code?: string; cause?: unknown }
  const label = getModeLabel(opts.mode)
  const action = opts.resumeSessionId ? `Could not restore ${label}` : `Could not start ${label}`
  const envVar = getModeCommandOverrideEnvVar(opts.mode)

  let message = base.message || 'Failed to spawn terminal'
  if (baseWithCode.code === 'ENOENT') {
    const common =
      `"${opts.file}" could not be started because the executable or working directory was not found on the server.`
    if (envVar) {
      message = `${action}: ${common} Reinstall it or set ${envVar} to the correct executable.`
    } else {
      message = `${action}: ${common} Check that the executable exists and the working directory is valid.`
    }
  } else if (message && !message.startsWith(`${action}:`)) {
    message = `${action}: ${message}`
  }

  const wrapped = new Error(message) as Error & { code?: string; cause?: unknown }
  wrapped.code = baseWithCode.code
  wrapped.cause = base
  return wrapped
}

type CodexRecoveryTeardownError = Error & {
  codexRecoveryTeardownFailed?: boolean
}

function codexRecoveryTeardownError(message: string): CodexRecoveryTeardownError {
  const error = new Error(message) as CodexRecoveryTeardownError
  error.codexRecoveryTeardownFailed = true
  return error
}

export function terminalIdFromCreateError(error: unknown): string | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  const terminalId = (error as { terminalId?: unknown }).terminalId
  return typeof terminalId === 'string' ? terminalId : undefined
}

function attachTerminalIdToCreateError(error: unknown, terminalId: string): unknown {
  const target: { terminalId?: string } = error && (typeof error === 'object' || typeof error === 'function')
    ? error as { terminalId?: string }
    : new Error(String(error)) as Error & { terminalId?: string }
  try {
    target.terminalId ??= terminalId
  } catch {
    // Preserve the original failure even if the thrown value rejects mutation.
  }
  return target
}

type PendingSnapshotQueue = {
  chunks: string[]
  queuedChars: number
}

type PendingOutput = {
  timer: NodeJS.Timeout | null
  chunksByTerminal: Map<string, string[]>
  perfByTerminal: Map<string, TerminalRecord['perf'] | undefined>
  queuedChars: number
}

type SidecarShutdownEntry = {
  promise: Promise<void>
  status: 'pending' | 'failed'
  terminalId: string
  shutdownSidecar: () => Promise<void>
  failureMessage: string
}

export type TerminalRecord = {
  terminalId: string
  title: string
  description?: string
  mode: TerminalMode
  opencodeServer?: LoopbackServerEndpoint
  resumeSessionId?: string
  pendingResumeName?: string
  createdAt: number
  lastActivityAt: number
  exitedAt?: number
  status: 'running' | 'exited'
  exitCode?: number
  cwd?: string
  shell: ShellType
  envContext?: { tabId?: string; paneId?: string }
  /** Normalized cwd used for MCP config injection (may differ from raw cwd on WSL). */
  mcpCwd?: string
  cols: number
  rows: number
  clients: Set<WebSocket>
  suppressedOutputClients: Set<WebSocket>
  pendingSnapshotClients: Map<WebSocket, PendingSnapshotQueue>

  buffer: ChunkRingBuffer
  pty: pty.IPty
  perf?: {
    outBytes: number
    outChunks: number
    droppedMessages: number
    inBytes: number
    inChunks: number
    pendingInputAt?: number
    pendingInputBytes: number
    pendingInputCount: number
    lastInputBytes?: number
    lastInputToOutputMs?: number
    maxInputToOutputMs: number
  }
  codexSidecar?: Pick<
    CodexLaunchSidecar,
    | 'shutdown'
    | 'onLifecycleLoss'
    | 'onCandidate'
    | 'onTurnStarted'
    | 'onTurnCompleted'
    | 'onRepairTrigger'
    | 'onFsChanged'
    | 'watchPath'
    | 'unwatchPath'
    | 'markCandidatePersisted'
    | 'readThreadTurn'
    | 'listThreadTurns'
  >
  codexSidecarLifecycleUnsubscribe?: () => void
  codexSidecarLifecyclePublished?: boolean
  codexSidecarPrePublicationLoss?: unknown
  codexSidecarGeneration?: number
  codexRolloutWatch?: { watchId: string; rolloutPath: string }
  codexDurability?: CodexDurabilityRef
  codexDurabilityProof?: {
    inFlight?: Promise<void>
    rerunRequested?: boolean
  }
  codexActiveTurn?: CodexTurnEvent
  codexUnconfirmedInputAt?: number
  codexUnconfirmedInputSource?: 'resume' | 'input'
  codexInputGate?: { state: 'identity_pending' }
  codexRecovery?: CodexRecoveryOptions
  codexRecoveryAttempt?: Promise<void>
  codexRecoveryAttemptSerial?: number
  codexLifecycleLossProofPending?: boolean
  codexCleanExitDecisionPending?: boolean
  codexRecoveryRetry?: { timer: NodeJS.Timeout; resolve: () => void }
  codexRecoveryBlockedError?: Error
  codexRecoveryFinalClose?: boolean
  codexRecoveryRetiringPty?: pty.IPty
  codexHandledPtyExits?: WeakSet<pty.IPty>
  codexPendingCleanExitFinalizer?: {
    timer: NodeJS.Timeout
  }
}

export type TerminalInputResult =
  | { status: 'written' }
  | { status: 'blocked_codex_identity_pending'; terminalId: string }
  | { status: 'blocked_codex_identity_capture_timeout'; terminalId: string }
  | { status: 'blocked_codex_identity_unavailable'; terminalId: string; reason?: string }
  | { status: 'blocked_codex_recovery_pending'; terminalId: string }
  | { status: 'blocked_codex_clean_exit_decision_pending'; terminalId: string }
  | { status: 'blocked_codex_lifecycle_loss_pending'; terminalId: string }
  | { status: 'no_terminal' }
  | { status: 'not_running' }

function isCodexStartupTerminalControlInput(data: string): boolean {
  if (data.length === 0 || data.length > 128) return false
  if (data === '\x1b[I' || data === '\x1b[O') return true
  if (/^\x1b\[\d{1,4};\d{1,4}R$/.test(data)) return true
  if (/^\x1b\[(?:\?|\>)?[\d;]{0,32}c$/.test(data)) return true
  return /^\x1b\](?:10|11|12|4;\d{1,3});rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\)$/.test(data)
}

export type BindSessionResult =
  | { ok: true; terminalId: string; sessionId: string }
  | { ok: false; reason: 'terminal_missing' | 'mode_mismatch' | 'invalid_session_id' | 'terminal_not_running' }
  | Extract<BindResult, { ok: false }>

export type RepairLegacySessionOwnersResult = {
  repaired: boolean
  canonicalTerminalId?: string
  clearedTerminalIds: string[]
}

type TerminalRegistryOptions = {
  codexDurabilityStore?: CodexDurabilityStore
  serverInstanceId?: string
}

export class ChunkRingBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private maxChars: number) {}

  private trimToMax() {
    const max = this.maxChars
    if (max <= 0) {
      this.clear()
      return
    }
    while (this.size > max && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.size -= removed.length
    }
    // If a single chunk is enormous, truncate it.
    if (this.size > max && this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks[0] = only.slice(-max)
      this.size = this.chunks[0].length
    }
  }

  append(chunk: string) {
    if (!chunk) return
    this.chunks.push(chunk)
    this.size += chunk.length
    this.trimToMax()
  }

  setMaxChars(next: number) {
    this.maxChars = Math.max(0, next)
    this.trimToMax()
  }

  snapshot(): string {
    return this.chunks.join('')
  }

  clear() {
    this.chunks = []
    this.size = 0
  }
}

function getDefaultCwd(settings?: ServerSettings): string | undefined {
  const candidate = settings?.defaultCwd
  if (!candidate) return undefined
  const { ok, resolvedPath } = isReachableDirectorySync(candidate)
  return ok ? resolvedPath : undefined
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Detect if running inside Windows Subsystem for Linux.
 * Uses environment variables set by WSL.
 */
export function isWsl(): boolean {
  return process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME ||
    !!process.env.WSL_INTEROP ||
    !!process.env.WSLENV
  )
}

/**
 * Returns true if Windows shells (cmd, powershell) are available.
 * This is true on native Windows and in WSL (via interop).
 */
export function isWindowsLike(): boolean {
  return isWindows() || isWsl()
}

/**
 * Get the executable path for cmd.exe or powershell.exe.
 * On native Windows, uses the simple name (relies on PATH).
 * On WSL, uses full paths since Windows executables may not be on PATH.
 */
function getWindowsExe(exe: 'cmd' | 'powershell'): string {
  if (isWindows()) {
    return exe === 'cmd' ? 'cmd.exe' : (process.env.POWERSHELL_EXE || 'powershell.exe')
  }
  // On WSL, use explicit paths since Windows PATH may not be available
  const systemRoot = process.env.WSL_WINDOWS_SYS32 || '/mnt/c/Windows/System32'
  if (exe === 'cmd') {
    return `${systemRoot}/cmd.exe`
  }
  return process.env.POWERSHELL_EXE || `${systemRoot}/WindowsPowerShell/v1.0/powershell.exe`
}

/**
 * Get the WSL mount prefix for Windows drives.
 * Derives from WSL_WINDOWS_SYS32 (e.g., /mnt/c/Windows/System32 → /mnt)
 * or defaults to /mnt for standard WSL configurations.
 *
 * Handles various mount configurations:
 * - /mnt/c/... → /mnt (standard)
 * - /c/... → '' (drives at root)
 * - /win/c/... → /win (custom prefix)
 */
function getWslMountPrefix(): string {
  const sys32 = process.env.WSL_WINDOWS_SYS32
  if (sys32) {
    // Extract mount prefix from path like /mnt/c/Windows/System32
    // The drive letter is a single char followed by /
    const match = sys32.match(/^(.*)\/[a-zA-Z]\//)
    if (match) {
      return match[1]
    }
  }
  return '/mnt'
}

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:([\\/]|$)/
const WINDOWS_UNC_PREFIX_RE = /^\\\\[^\\]+\\[^\\]+/
const WINDOWS_ROOTED_PREFIX_RE = /^\\(?!\\)/

function isWindowsAbsolutePath(input: string): boolean {
  return WINDOWS_DRIVE_PREFIX_RE.test(input) || WINDOWS_UNC_PREFIX_RE.test(input) || WINDOWS_ROOTED_PREFIX_RE.test(input)
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function convertWslDrivePathToWindows(input: string): string | undefined {
  const normalized = input.replace(/\\/g, '/')
  const mountPrefix = getWslMountPrefix()
  const prefixes = new Set([mountPrefix, '/mnt'])

  for (const prefix of prefixes) {
    const match = prefix
      ? normalized.match(new RegExp(`^${escapeRegex(prefix)}/([a-zA-Z])(?:/(.*))?$`))
      : normalized.match(/^\/([a-zA-Z])(?:\/(.*))?$/)
    if (!match) continue
    const drive = `${match[1].toUpperCase()}:`
    const rest = match[2]?.replace(/\//g, '\\')
    return rest ? `${drive}\\${rest}` : `${drive}\\`
  }
  return undefined
}

function resolveWindowsShellCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const candidate = cwd.trim()
  if (!candidate) return undefined

  if (isLinuxPath(candidate)) {
    return convertWslDrivePathToWindows(candidate)
  }

  if (WINDOWS_UNC_PREFIX_RE.test(candidate)) {
    return undefined
  }

  if (isWindowsAbsolutePath(candidate) || !isWsl()) {
    return path.win32.resolve(candidate)
  }
  return undefined
}

function resolveUnixShellCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const candidate = cwd.trim()
  if (!candidate) return undefined

  // In WSL, Linux processes need POSIX paths. Convert Windows-style cwd inputs
  // (e.g. D:\users\dan) to WSL mount paths before passing cwd to node-pty.
  // Skip conversion for paths already in Linux/POSIX format.
  if (isWsl() && !isLinuxPath(candidate)) {
    const converted = convertWindowsPathToWslPath(candidate)
    if (converted) {
      return converted
    }
  }

  return candidate
}

/**
 * Get a sensible default working directory for Windows shells.
 * On native Windows: user's home directory (C:\Users\<username>)
 * In WSL: a Windows-native drive path (USERPROFILE, HOME drive, or SYSTEMDRIVE root)
 *
 * This avoids UNC paths (\\wsl.localhost\...) which cmd.exe doesn't support.
 */
function getWindowsDefaultCwd(): string {
  if (isWindows()) {
    return os.homedir()
  }

  const userProfile = process.env.USERPROFILE
  if (userProfile?.trim()) {
    const resolved = resolveWindowsShellCwd(userProfile)
    if (resolved) return resolved
  }

  const homeDrive = process.env.HOMEDRIVE
  const homePath = process.env.HOMEPATH
  if (homeDrive && homePath) {
    return path.win32.resolve(`${homeDrive}${homePath}`)
  }

  const systemDrive = process.env.SYSTEMDRIVE || 'C:'
  return path.win32.resolve(`${systemDrive}\\`)
}

/**
 * Resolve the effective shell based on platform and requested shell type.
 * - Windows/WSL: 'system' → platform default, others pass through
 * - macOS/Linux (non-WSL): always normalize to 'system' (use $SHELL or fallback)
 */
function resolveShell(requested: ShellType): ShellType {
  if (isWindows()) {
    // On native Windows, 'system' maps to cmd (or ComSpec)
    return requested === 'system' ? 'cmd' : requested
  }
  if (isWsl()) {
    // On WSL, 'system' and 'wsl' both use the Linux shell
    // 'cmd' and 'powershell' use Windows executables via interop
    if (requested === 'system' || requested === 'wsl') {
      return 'system'
    }
    return requested // 'cmd' or 'powershell' pass through
  }
  // On macOS/Linux (non-WSL), always use 'system' shell
  // Windows-specific options are normalized to system
  return 'system'
}

/**
 * Get the system shell for macOS/Linux.
 * Priority: $SHELL (if exists) → platform fallback (if exists) → /bin/sh
 */
export function getSystemShell(): string {
  const shell = process.env.SHELL
  // Check if SHELL is set, non-empty, non-whitespace, and exists
  if (shell && shell.trim() && fs.existsSync(shell)) {
    return shell
  }

  if (process.platform === 'darwin') {
    // macOS: prefer zsh (default since Catalina), then bash, then sh
    if (fs.existsSync('/bin/zsh')) return '/bin/zsh'
    if (fs.existsSync('/bin/bash')) return '/bin/bash'
  } else {
    // Linux: prefer bash, then sh
    if (fs.existsSync('/bin/bash')) return '/bin/bash'
  }

  // Ultimate fallback - /bin/sh should always exist on Unix systems
  return '/bin/sh'
}

export function isLinuxPath(p: unknown): boolean {
  // Detect Linux/WSL paths that won't work on native Windows
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
}

/**
 * Escape special characters for cmd.exe shell commands.
 * cmd.exe uses ^ as its escape character for most special characters.
 * The % character is special and must be doubled (%%).
 */
export function escapeCmdExe(s: string): string {
  // Escape ^ first (the escape char itself), then other special chars
  // Order matters: ^ must be escaped before we add more ^
  return s
    .replace(/\^/g, '^^')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '%%')
    .replace(/"/g, '\\"')
}

function quoteCmdArg(arg: string): string {
  // cmd.exe expands %VAR% even inside quotes; double % to preserve literals.
  const escaped = arg.replace(/%/g, '%%')
  let quoted = '"'
  let backslashCount = 0
  for (const ch of escaped) {
    if (ch === '\\') {
      backslashCount += 1
      continue
    }

    if (ch === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1)
      quoted += '"'
      backslashCount = 0
      continue
    }

    if (backslashCount > 0) {
      quoted += '\\'.repeat(backslashCount)
      backslashCount = 0
    }
    quoted += ch
  }

  if (backslashCount > 0) {
    quoted += '\\'.repeat(backslashCount * 2)
  }
  quoted += '"'
  return quoted
}

function buildCmdCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCmdArg).join(' ')
}

function quotePowerShellLiteral(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`
}

function buildPowerShellCommand(command: string, args: string[]): string {
  const invocation = ['&', quotePowerShellLiteral(command), ...args.map(quotePowerShellLiteral)].join(' ')
  return invocation
}

export function buildSpawnSpec(
  mode: TerminalMode,
  cwd: string | undefined,
  shell: ShellType,
  resumeSessionId?: string,
  providerSettings?: ProviderSettings,
  envOverrides?: Record<string, string>,
  terminalId?: string,
) {
  // Reject modes that aren't the built-in shell or a registered coding CLI.
  // Otherwise the fallbacks below (`cli?.command || mode`, and the WSL bash
  // fallback) try to exec the mode name itself, spawning a terminal that dies
  // instantly with "execvp(3) failed: No such file or directory".
  if (mode !== 'shell' && !codingCliCommands.has(mode)) {
    throw new UnknownTerminalModeError(mode)
  }
  // Strip inherited env vars that interfere with child terminal behaviour:
  // - CLAUDECODE: causes child Claude processes to refuse to start ("nested session" error)
  // - CI/NO_COLOR/FORCE_COLOR/COLOR: disables interactive color in user PTYs
  // - PORT/AUTH_TOKEN/ALLOWED_ORIGINS: server-specific vars that cause port conflicts
  //   and leak credentials into child processes
  // - NODE_ENV/npm_lifecycle_script: server's production env leaks into child shells,
  //   breaking tools like React test-utils that check NODE_ENV
  const {
    CLAUDECODE: _claudecode,
    CI: _ci,
    NO_COLOR: _noColor,
    FORCE_COLOR: _forceColor,
    COLOR: _color,
    PORT: _port,
    AUTH_TOKEN: _authToken,
    ALLOWED_ORIGINS: _allowedOrigins,
    NODE_ENV: _nodeEnv,
    npm_lifecycle_script: _npmLifecycleScript,
    OPENCODE_SERVER_USERNAME: _opencodeServerUsername,
    OPENCODE_SERVER_PASSWORD: _opencodeServerPassword,
    ...parentEnv
  } = process.env
  const env = {
    ...parentEnv,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...envOverrides,
  }

  const normalizedResume = normalizeResumeForSpawn(mode, resumeSessionId)

  // Resolve shell for the current platform
  const effectiveShell = resolveShell(shell)

  // Debug logging for shell/cwd resolution
  logger.debug({
    mode,
    requestedShell: shell,
    effectiveShell,
    cwd,
    isLinuxPath: cwd ? isLinuxPath(cwd) : false,
    isWsl: isWsl(),
    isWindows: isWindows(),
  }, 'buildSpawnSpec: resolving shell and cwd')

  // In WSL with 'system' shell (which 'wsl' resolves to), use Linux shell directly
  // For 'cmd' or 'powershell' in WSL, fall through to Windows shell handling
  const inWslWithLinuxShell = isWsl() && effectiveShell === 'system'

  if (isWindowsLike() && !inWslWithLinuxShell) {
    // If the cwd is a Linux path, force WSL mode since native Windows shells can't use it
    // (Only applies on native Windows, not when already in WSL)
    const forceWsl = isWindows() && isLinuxPath(cwd)

    // Use protocol-specified shell, falling back to env var for backwards compatibility
    const windowsMode = forceWsl
      ? 'wsl'
      : effectiveShell !== 'system'
        ? effectiveShell
        : (process.env.WINDOWS_SHELL || 'wsl').toLowerCase()

    // Option A: WSL (from native Windows) — recommended for coding CLIs on Windows.
    // This path is skipped when already running inside WSL.
    if (windowsMode === 'wsl') {
      const wsl = process.env.WSL_EXE || 'wsl.exe'
      const distro = process.env.WSL_DISTRO // optional
      const args: string[] = []
      if (distro) args.push('-d', distro)

      // cwd must be a Linux path inside WSL for both the --cd arg and MCP injection.
      const wslCwd = cwd
        ? (isLinuxPath(cwd) ? cwd : (convertWindowsPathToWslPath(cwd) || cwd))
        : undefined
      if (wslCwd) {
        args.push('--cd', wslCwd)
      }

      if (mode === 'shell') {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, mcpCwd: wslCwd, env }
      }

      // Pass wslCwd (Linux-normalized) so MCP injection receives a valid POSIX path
      const cli = resolveCodingCliCommand(mode, normalizedResume, 'unix', providerSettings, terminalId, wslCwd)
      if (!cli) {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, mcpCwd: wslCwd, env }
      }

      args.push('--exec', cli.command, ...cli.args)
      return { file: wsl, args, cwd: undefined, mcpCwd: wslCwd, env: { ...env, ...cli.env } }
    }

    // Option B: Native Windows shells (PowerShell/cmd)

    if (windowsMode === 'cmd') {
      const file = getWindowsExe('cmd')
      // In WSL, we can't pass Linux paths as cwd to Windows executables (they become UNC paths)
      // Instead, pass no cwd and use cd /d inside the command
      const inWsl = isWsl()
      const winCwd = inWsl
        ? (resolveWindowsShellCwd(cwd) || getWindowsDefaultCwd())
        : (isLinuxPath(cwd) ? undefined : cwd)
      // For WSL: don't pass cwd to node-pty, use cd /d in command instead
      const procCwd = inWsl ? undefined : winCwd
      logger.debug({
        shell: 'cmd',
        inWsl,
        originalCwd: cwd,
        winCwd,
        procCwd,
        file,
      }, 'buildSpawnSpec: cmd.exe cwd resolution')
      if (mode === 'shell') {
        if (inWsl && winCwd) {
          // Use /K with cd command to change to Windows directory
          return { file, args: ['/K', `cd /d ${quoteCmdArg(winCwd)}`], cwd: procCwd, mcpCwd: resolveUnixShellCwd(cwd), env }
        }
        return { file, args: ['/K'], cwd: procCwd, mcpCwd: resolveUnixShellCwd(cwd), env }
      }
      // Pass Linux-resolved cwd for MCP injection (server writes config to Linux filesystem)
      const cmdMcpCwd = resolveUnixShellCwd(cwd)
      const cli = resolveCodingCliCommand(mode, normalizedResume, 'windows', providerSettings, terminalId, cmdMcpCwd)
      const cmd = cli?.command || mode
      const command = buildCmdCommand(cmd, cli?.args || [])
      const cd = winCwd ? `cd /d ${quoteCmdArg(winCwd)} && ` : ''
      return { file, args: ['/K', `${cd}${command}`], cwd: procCwd, mcpCwd: cmdMcpCwd, env: cli ? { ...env, ...cli.env } : env }
    }

    // default to PowerShell
    const file = getWindowsExe('powershell')
    // In WSL, we can't pass Linux paths as cwd to Windows executables (they become UNC paths)
    const inWsl = isWsl()
    const winCwd = inWsl
      ? (resolveWindowsShellCwd(cwd) || getWindowsDefaultCwd())
      : (isLinuxPath(cwd) ? undefined : cwd)
    const procCwd = inWsl ? undefined : winCwd
    logger.debug({
      shell: 'powershell',
      inWsl,
      originalCwd: cwd,
      winCwd,
      procCwd,
      file,
    }, 'buildSpawnSpec: powershell.exe cwd resolution')
    if (mode === 'shell') {
      if (inWsl && winCwd) {
        // Use Set-Location to change to Windows directory
        return { file, args: ['-NoLogo', '-NoExit', '-Command', `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}`], cwd: procCwd, mcpCwd: resolveUnixShellCwd(cwd), env }
      }
      return { file, args: ['-NoLogo'], cwd: procCwd, mcpCwd: resolveUnixShellCwd(cwd), env }
    }

    // Pass Linux-resolved cwd for MCP injection (server writes config to Linux filesystem)
    const psMcpCwd = resolveUnixShellCwd(cwd)
    const cli = resolveCodingCliCommand(mode, normalizedResume, 'windows', providerSettings, terminalId, psMcpCwd)
    const cmd = cli?.command || mode
    const invocation = buildPowerShellCommand(cmd, cli?.args || [])
    const cd = winCwd ? `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}; ` : ''
    const command = `${cd}${invocation}`
    return {
      file,
      args: ['-NoLogo', '-NoExit', '-Command', command],
      cwd: procCwd,
      mcpCwd: psMcpCwd,
      env: cli ? { ...env, ...cli.env } : env,
    }
  }
// Non-Windows: native spawn using system shell
  const systemShell = getSystemShell()
  const unixCwd = resolveUnixShellCwd(cwd)

  if (mode === 'shell') {
    return { file: systemShell, args: ['-l'], cwd: unixCwd, mcpCwd: unixCwd, env }
  }

  // Pass the resolved unixCwd (not raw cwd) so that MCP config injection
  // (via providerNotificationArgs → generateMcpInjection) receives a valid
  // Linux path. On WSL, raw cwd could be a Windows-style path (e.g. D:\project)
  // which would fail existsSync checks in config-writer.ts.
  const cli = resolveCodingCliCommand(mode, normalizedResume, 'unix', providerSettings, terminalId, unixCwd)
  const cmd = cli?.command || mode
  const args = cli?.args || []
  return { file: cmd, args, cwd: unixCwd, mcpCwd: unixCwd, env: cli ? { ...env, ...cli.env } : env }
}

export class TerminalRegistry extends EventEmitter {
  private terminals = new Map<string, TerminalRecord>()
  private bindingAuthority = new SessionBindingAuthority()
  private settings: ServerSettings | undefined
  private idleTimer: NodeJS.Timeout | null = null
  private perfTimer: NodeJS.Timeout | null = null
  private maxTerminals: number
  private maxExitedTerminals: number
  private scrollbackMaxChars: number
  private maxPendingSnapshotChars: number
  private sidecarShutdowns = new Map<string, SidecarShutdownEntry>()
  private codexDurabilityStore: CodexDurabilityStore
  private codexCandidatePersistenceQueues = new Map<string, Promise<void>>()
  private serverInstanceId: string
  // Legacy transport batching path. Broker cutover destination:
  // - outputBuffers/flush timers/mobile batching -> broker client-output queue.
  private outputBuffers = new Map<WebSocket, PendingOutput>()

  constructor(
    settings?: ServerSettings,
    maxTerminals?: number,
    maxExitedTerminals?: number,
    options: TerminalRegistryOptions = {},
  ) {
    super()
    // Permanent terminal.exit listeners: index, ws-handler, broker, codex-wiring,
    // terminal-view. Shutdown uses a single shared listener (no per-terminal scaling).
    this.setMaxListeners(20)
    this.settings = settings
    this.maxTerminals = maxTerminals ?? MAX_TERMINALS
    this.maxExitedTerminals = maxExitedTerminals ?? Number(process.env.MAX_EXITED_TERMINALS || 200)
    this.codexDurabilityStore = options.codexDurabilityStore ?? new CodexDurabilityStore()
    this.serverInstanceId = options.serverInstanceId?.trim() || process.env.FRESHELL_SERVER_INSTANCE_ID || `srv-${process.pid}`
    this.scrollbackMaxChars = this.computeScrollbackMaxChars(settings)
    {
      const raw = Number(process.env.MAX_PENDING_SNAPSHOT_CHARS || DEFAULT_MAX_PENDING_SNAPSHOT_CHARS)
      this.maxPendingSnapshotChars = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_PENDING_SNAPSHOT_CHARS
    }
    this.startIdleMonitor()
    this.startPerfMonitor()
  }

  setServerInstanceId(serverInstanceId: string): void {
    const normalized = serverInstanceId.trim()
    if (!normalized) return
    this.serverInstanceId = normalized
  }

  setSettings(settings: ServerSettings) {
    this.settings = settings
    this.scrollbackMaxChars = this.computeScrollbackMaxChars(settings)
    for (const t of this.terminals.values()) {
      t.buffer.setMaxChars(this.scrollbackMaxChars)
    }
  }

  getReplayRingMaxChars(): number {
    return this.scrollbackMaxChars
  }

  private computeScrollbackMaxChars(settings?: ServerSettings): number {
    const lines = settings?.terminal?.scrollback
    if (typeof lines !== 'number' || !Number.isFinite(lines)) return DEFAULT_MAX_SCROLLBACK_CHARS
    const computed = Math.floor(lines * APPROX_CHARS_PER_LINE)
    return Math.min(MAX_SCROLLBACK_CHARS, Math.max(MIN_SCROLLBACK_CHARS, computed))
  }

  private startIdleMonitor() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = setInterval(() => {
      this.enforceIdleKills().catch((err) => logger.warn({ err }, 'Idle monitor error'))
    }, 30_000)
  }

  private startPerfMonitor() {
    if (!perfConfig.enabled) return
    if (this.perfTimer) clearInterval(this.perfTimer)
    this.perfTimer = setInterval(() => {
      const now = Date.now()
      for (const term of this.terminals.values()) {
        if (!term.perf) continue
        if (term.perf.outBytes > 0 || term.perf.droppedMessages > 0) {
          logPerfEvent(
            'terminal_output',
            {
              terminalId: term.terminalId,
              mode: term.mode,
              status: term.status,
              clients: term.clients.size,
              outBytes: term.perf.outBytes,
              outChunks: term.perf.outChunks,
              droppedMessages: term.perf.droppedMessages,
            },
            term.perf.droppedMessages > 0 ? 'warn' : 'info',
          )
          term.perf.outBytes = 0
          term.perf.outChunks = 0
          term.perf.droppedMessages = 0
        }

        const pendingInputMs = term.perf.pendingInputAt ? now - term.perf.pendingInputAt : undefined
        const hasInputMetrics =
          term.perf.inBytes > 0 ||
          term.perf.inChunks > 0 ||
          term.perf.pendingInputAt !== undefined ||
          term.perf.maxInputToOutputMs > 0
        if (hasInputMetrics) {
          const hasLag =
            (pendingInputMs !== undefined && pendingInputMs >= perfConfig.terminalInputLagMs) ||
            term.perf.maxInputToOutputMs >= perfConfig.terminalInputLagMs
          logPerfEvent(
            'terminal_input',
            {
              terminalId: term.terminalId,
              mode: term.mode,
              status: term.status,
              clients: term.clients.size,
              inBytes: term.perf.inBytes,
              inChunks: term.perf.inChunks,
              pendingInputMs,
              pendingInputBytes: term.perf.pendingInputBytes,
              pendingInputCount: term.perf.pendingInputCount,
              lastInputBytes: term.perf.lastInputBytes,
              lastInputToOutputMs: term.perf.lastInputToOutputMs,
              maxInputToOutputMs: term.perf.maxInputToOutputMs,
            },
            hasLag ? 'warn' : 'info',
          )
          term.perf.inBytes = 0
          term.perf.inChunks = 0
          term.perf.maxInputToOutputMs = 0
          term.perf.lastInputToOutputMs = undefined
        }
      }
    }, perfConfig.terminalSampleMs)
    this.perfTimer.unref?.()
  }

  private async enforceIdleKills() {
    const settings = this.settings
    if (!settings) return
    const killMinutes = settings.safety.autoKillIdleMinutes
    if (!killMinutes || killMinutes <= 0) return
    const now = Date.now()

    for (const term of this.terminals.values()) {
      if (term.status !== 'running') continue
      if (term.clients.size > 0) continue // only detached

      const idleMs = now - term.lastActivityAt
      const idleMinutes = idleMs / 60000

      if (idleMinutes >= killMinutes) {
        logger.info({ terminalId: term.terminalId }, 'Auto-killing idle detached terminal')
        this.kill(term.terminalId)
      }
    }
  }

  // Exposed for unit tests to validate idle kill behavior without relying on timers.
  async enforceIdleKillsForTest(): Promise<void> {
    await this.enforceIdleKills()
  }

  private runningCount(): number {
    let n = 0
    for (const t of this.terminals.values()) {
      if (t.status === 'running') n += 1
    }
    return n
  }

  private recordTerminalExitWithoutDurableSession(
    record: TerminalRecord,
    exitCode: number | undefined,
    reason: 'pty_exit' | 'user_final_close',
  ): void {
    if (
      record.mode === 'shell'
      || record.resumeSessionId
      || (record.mode === 'codex' && record.codexDurability?.state === 'durable' && record.codexDurability.durableThreadId)
    ) {
      return
    }
    const ptyPid = record.pty.pid
    recordSessionLifecycleEvent({
      kind: 'terminal_exit_without_durable_session',
      terminalId: record.terminalId,
      mode: record.mode,
      exitCode: exitCode ?? 0,
      ageMs: Math.max(0, Date.now() - record.createdAt),
      reason,
      ...(ptyPid ? { ptyPid } : {}),
    })
  }

  private forgetCodexDurabilityStoreRecord(record: TerminalRecord, reason: string): void {
    if (record.mode !== 'codex') return
    if (!record.codexDurability) return
    void this.codexDurabilityStore.delete(record.terminalId).catch((err) => {
      logger.warn({ err, terminalId: record.terminalId, reason }, 'Failed to delete Codex durability store record')
    })
  }

  private finishTerminalPtyExit(
    record: TerminalRecord,
    event: { exitCode: number; signal?: number },
  ): void {
    this.clearCodexPendingCleanExitFinalizer(record)
    this.markCodexRecoveryFinalClose(record)
    record.status = 'exited'
    record.exitCode = event.exitCode
    const now = Date.now()
    record.lastActivityAt = now
    record.exitedAt = now
    cleanupMcpConfig(record.terminalId, record.mode, record.mcpCwd)
    for (const client of record.clients) {
      this.flushOutputBuffer(client)
      this.safeSend(client, { type: 'terminal.exit', terminalId: record.terminalId, exitCode: event.exitCode }, { terminalId: record.terminalId, perf: record.perf })
    }
    record.clients.clear()
    record.suppressedOutputClients.clear()
    record.pendingSnapshotClients.clear()
    this.recordTerminalExitWithoutDurableSession(record, event.exitCode, 'pty_exit')
    this.releaseBinding(record.terminalId, 'exit')
    this.emit('terminal.exit', { terminalId: record.terminalId, exitCode: event.exitCode })
    this.forgetCodexDurabilityStoreRecord(record, 'pty_exit')
    void this.releaseCodexSidecar(record).catch(() => undefined)
    this.reapExitedTerminals()
  }

  private reapExitedTerminals(): void {
    const max = this.maxExitedTerminals
    if (!max || max <= 0) return

    const exited = Array.from(this.terminals.values())
      .filter((t) => t.status === 'exited' && !t.codexSidecar && this.sidecarShutdownPromisesForTerminal(t.terminalId).length === 0)
      .sort((a, b) => (a.exitedAt ?? a.lastActivityAt) - (b.exitedAt ?? b.lastActivityAt))

    const excess = exited.length - max
    if (excess <= 0) return
    for (let i = 0; i < excess; i += 1) {
      const terminal = exited[i]
      this.terminals.delete(terminal.terminalId)
      this.forgetCodexDurabilityStoreRecord(terminal, 'reap_exited')
    }
  }

  private buildTerminalBaseEnv(
    terminalId: string,
    envContext?: { tabId?: string; paneId?: string },
  ): Record<string, string> {
    const port = Number(process.env.PORT || 3001)
    return {
      FRESHELL: '1',
      FRESHELL_URL: process.env.FRESHELL_URL || `http://localhost:${port}`,
      FRESHELL_TOKEN: process.env.AUTH_TOKEN || '',
      FRESHELL_TERMINAL_ID: terminalId,
      ...(envContext?.tabId ? { FRESHELL_TAB_ID: envContext.tabId } : {}),
      ...(envContext?.paneId ? { FRESHELL_PANE_ID: envContext.paneId } : {}),
    }
  }

  create(opts: {
    mode: TerminalMode
    shell?: ShellType
    cwd?: string
    cols?: number
    rows?: number
    resumeSessionId?: string
    sessionBindingReason?: SessionBindingReason
    providerSettings?: ProviderSettings
    envContext?: { tabId?: string; paneId?: string }
  }): TerminalRecord {
    this.reapExitedTerminals()
    if (this.runningCount() >= this.maxTerminals) {
      throw new Error(`Maximum terminal limit (${this.maxTerminals}) reached. Please close some terminals before creating new ones.`)
    }

    const terminalId = nanoid()
    const createdAt = Date.now()
    const cols = opts.cols || 120
    const rows = opts.rows || 30

    const cwd = opts.cwd || getDefaultCwd(this.settings) || (isWindows() ? undefined : os.homedir())
    const resumeForSpawn = normalizeResumeForSpawn(opts.mode, opts.resumeSessionId)
    const resumeForBinding = normalizeResumeForBinding(opts.mode, opts.resumeSessionId)
    const shell = opts.shell || 'system'
    const baseEnv = this.buildTerminalBaseEnv(terminalId, opts.envContext)

    const { file, args, env, cwd: procCwd, mcpCwd } = buildSpawnSpec(
      opts.mode,
      cwd,
      shell,
      resumeForSpawn,
      opts.providerSettings,
      baseEnv,
      terminalId,
    )

    const endSpawnTimer = startPerfTimer(
      'terminal_spawn',
      { terminalId, mode: opts.mode, shell },
      { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
    )

    logger.info({ terminalId, file, args, cwd: procCwd, mode: opts.mode, shell }, 'Spawning terminal')

    let ptyProc: ReturnType<typeof pty.spawn>
    try {
      ptyProc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: procCwd,
        env: env as any,
      })
    } catch (err) {
      // Clean up MCP config temp files that were created before the spawn attempt.
      // Use mcpCwd (the Linux path passed to generateMcpInjection), not procCwd
      // (which may be undefined for WSL cmd/powershell paths).
      cleanupMcpConfig(terminalId, opts.mode, mcpCwd)
      throw wrapTerminalSpawnError(err, {
        mode: opts.mode,
        file,
        resumeSessionId: resumeForSpawn,
      })
    }
    endSpawnTimer({ cwd: procCwd })

    const title = getModeLabel(opts.mode)

    const initialCodexDurability: CodexDurabilityRef | undefined = opts.mode === 'codex' && resumeForBinding
      ? {
          schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
          state: 'durable',
          durableThreadId: resumeForBinding,
        }
      : undefined

    const record: TerminalRecord = {
      terminalId,
      title,
      description: undefined,
      mode: opts.mode,
      opencodeServer: opts.mode === 'opencode' ? opts.providerSettings?.opencodeServer : undefined,
      resumeSessionId: undefined,
      createdAt,
      lastActivityAt: createdAt,
      status: 'running',
      cwd,
      shell,
      envContext: opts.envContext,
      mcpCwd,
      cols,
      rows,
      clients: new Set(),
      suppressedOutputClients: new Set(),
      pendingSnapshotClients: new Map(),

      buffer: new ChunkRingBuffer(this.scrollbackMaxChars),
      pty: ptyProc,
      codexSidecar: opts.mode === 'codex' ? opts.providerSettings?.codexAppServer?.sidecar : undefined,
      codexSidecarLifecyclePublished: opts.mode === 'codex'
        ? !opts.providerSettings?.codexAppServer?.deferLifecycleUntilPublished
        : undefined,
      codexSidecarGeneration: opts.mode === 'codex' ? 0 : undefined,
      codexDurability: initialCodexDurability,
      codexUnconfirmedInputAt: opts.mode === 'codex' && resumeForBinding && (opts.sessionBindingReason ?? 'resume') === 'resume'
        ? createdAt
        : undefined,
      codexUnconfirmedInputSource: opts.mode === 'codex' && resumeForBinding && (opts.sessionBindingReason ?? 'resume') === 'resume'
        ? 'resume'
        : undefined,
      codexInputGate: opts.mode === 'codex' && !resumeForBinding
        ? { state: 'identity_pending' }
        : undefined,
      codexRecovery: opts.mode === 'codex' ? opts.providerSettings?.codexAppServer?.recovery : undefined,
      perf: perfConfig.enabled
        ? {
            outBytes: 0,
            outChunks: 0,
            droppedMessages: 0,
            inBytes: 0,
            inChunks: 0,
            pendingInputAt: undefined,
            pendingInputBytes: 0,
            pendingInputCount: 0,
            lastInputBytes: undefined,
            lastInputToOutputMs: undefined,
            maxInputToOutputMs: 0,
          }
        : undefined,
    }

    this.registerCodexSidecarLifecycle(record)

    ptyProc.onData((data) => {
      if (record.pty !== ptyProc) return
      const now = Date.now()
      record.lastActivityAt = now
      record.buffer.append(data)
      this.emit('terminal.output.raw', {
        terminalId,
        data,
        at: now,
      } satisfies TerminalOutputRawEvent)
      if (record.perf) {
        record.perf.outBytes += data.length
        record.perf.outChunks += 1
        if (record.perf.pendingInputAt !== undefined) {
          const lagMs = now - record.perf.pendingInputAt
          record.perf.lastInputToOutputMs = lagMs
          if (lagMs > record.perf.maxInputToOutputMs) {
            record.perf.maxInputToOutputMs = lagMs
          }
          if (lagMs >= perfConfig.terminalInputLagMs) {
            const key = `terminal_input_lag_${terminalId}`
            if (shouldLog(key, perfConfig.rateLimitMs)) {
              logPerfEvent(
                'terminal_input_lag',
                {
                  terminalId,
                  mode: record.mode,
                  status: record.status,
                  lagMs,
                  pendingInputBytes: record.perf.pendingInputBytes,
                  pendingInputCount: record.perf.pendingInputCount,
                  lastInputBytes: record.perf.lastInputBytes,
                },
                'warn',
              )
            }
          }
          record.perf.pendingInputAt = undefined
          record.perf.pendingInputBytes = 0
          record.perf.pendingInputCount = 0
        }
      }
      for (const client of record.clients) {
        if (record.suppressedOutputClients.has(client)) continue
        // Legacy snapshot ordering path. Broker cutover destination:
        // - pendingSnapshotClients ordering -> broker attach-staging queue.
        const pending = record.pendingSnapshotClients.get(client)
        if (pending) {
          const nextChars = pending.queuedChars + data.length
          if (data.length > this.maxPendingSnapshotChars || nextChars > this.maxPendingSnapshotChars) {
            // If a terminal spews output while we're sending a snapshot, queueing unboundedly can OOM the server.
            // Prefer explicit resync: drop the client and let it reconnect/reattach for a fresh snapshot.
            try {
              client.close(4008, 'Attach snapshot queue overflow')
            } catch {
              // ignore
            }
            record.pendingSnapshotClients.delete(client)
            record.clients.delete(client)
            continue
          }
          pending.chunks.push(data)
          pending.queuedChars = nextChars
          continue
        }
        this.sendTerminalOutput(client, terminalId, data, record.perf)
      }
    })

    ptyProc.onExit((e) => {
      if (this.hasHandledPtyExit(record, ptyProc)) return
      this.markHandledPtyExit(record, ptyProc)
      if (!record.codexRecoveryFinalClose && record.codexRecoveryRetiringPty === ptyProc) {
        return
      }
      if (record.pty !== ptyProc) {
        return
      }
      if (record.status === 'exited') {
        return
      }
      const finishExit = () => {
        if (
          this.shouldRecoverCodexPtyExit(record, e)
          && this.startCodexDurableRecovery(record, {
            source: 'pty_exit',
            exitCode: e.exitCode,
            signal: e.signal,
          })
        ) {
          return
        }
        if (!this.scheduleCodexCleanExitFinalizer(record, ptyProc, e)) {
          this.finishTerminalPtyExit(record, e)
        }
      }
      const finishExitAfterActiveTurnCheck = () => {
        if (!this.shouldCheckCodexActiveTurnBeforeCleanExit(record, e)) {
          finishExit()
          return
        }
        record.codexCleanExitDecisionPending = true
        const recoverySerial = record.codexRecoveryAttemptSerial ?? 0
        void (async () => {
          try {
            const shouldRecover = await this.shouldRecoverCleanCodexExitForActiveTurn(record)
            if ((record.codexRecoveryAttemptSerial ?? 0) !== recoverySerial) return
            if (record.pty !== ptyProc || record.status === 'exited') return
            if (record.codexRecoveryAttempt || record.codexLifecycleLossProofPending) return
            if (
              shouldRecover
              && this.startCodexDurableRecovery(record, {
                source: 'pty_exit',
                exitCode: e.exitCode,
                signal: e.signal,
              })
            ) {
              return
            }
            if (!this.scheduleCodexCleanExitFinalizer(record, ptyProc, e)) {
              this.finishTerminalPtyExit(record, e)
            }
          } finally {
            if (this.terminals.get(record.terminalId) === record && !record.codexPendingCleanExitFinalizer) {
              record.codexCleanExitDecisionPending = undefined
            }
          }
        })()
      }
      if (this.needsCodexFinalDurabilityProof(record)) {
        if (record.codexLifecycleLossProofPending) return
        void (async () => {
          await this.proveCodexBeforeFinalLoss(record, 'pty_exit')
          if (record.pty !== ptyProc || record.status === 'exited') return
          finishExitAfterActiveTurnCheck()
        })()
        return
      }
      finishExitAfterActiveTurnCheck()
    })

    this.terminals.set(terminalId, record)
    if (opts.mode === 'codex' && record.codexInputGate?.state === 'identity_pending') {
      recordSessionLifecycleEvent({
        kind: 'codex_candidate_pending',
        provider: 'codex',
        terminalId,
        generation: record.codexSidecarGeneration ?? 0,
        ...(record.envContext?.tabId ? { tabId: record.envContext.tabId } : {}),
        ...(record.envContext?.paneId ? { paneId: record.envContext.paneId } : {}),
        ...(record.cwd ? { cwd: record.cwd } : {}),
      })
    }
    const exactSessionId = resumeForBinding
    if (modeSupportsResume(opts.mode) && exactSessionId) {
      const bound = this.bindSession(
        terminalId,
        opts.mode as CodingCliProviderName,
        exactSessionId,
        opts.sessionBindingReason ?? 'resume',
      )
      if (!bound.ok) {
        logger.warn(
          { terminalId, mode: opts.mode, sessionId: exactSessionId, reason: bound.reason },
          'Failed to bind resume session during terminal create',
        )
      }
    }
    if (resumeForSpawn && !resumeForBinding) {
      record.pendingResumeName = resumeForSpawn
      logger.info(
        { terminalId, mode: opts.mode, pendingResumeName: resumeForSpawn },
        'Terminal created with named resume; awaiting session association',
      )
    }
    try {
      this.emit('terminal.created', record)
    } catch (err) {
      throw attachTerminalIdToCreateError(err, terminalId)
    }
    return record
  }

  private registerCodexSidecarLifecycle(record: TerminalRecord): void {
    record.codexSidecarLifecycleUnsubscribe?.()
    const sidecar = record.codexSidecar
    if (!sidecar) {
      record.codexSidecarLifecycleUnsubscribe = undefined
      return
    }
    const isCurrentSidecar = () => this.terminals.get(record.terminalId)?.codexSidecar === sidecar

    const unsubscribers: Array<() => void> = []
    const lifecycleUnsubscribe = sidecar.onLifecycleLoss?.((event) => {
      if (!isCurrentSidecar()) return
      this.handleCodexLifecycleLoss(record.terminalId, event)
    })
    if (lifecycleUnsubscribe) unsubscribers.push(lifecycleUnsubscribe)

    const candidateUnsubscribe = sidecar.onCandidate?.((candidate) => {
      if (!isCurrentSidecar()) return
      void this.persistCodexCandidate(record.terminalId, candidate).catch((err) => {
        logger.error({ err, terminalId: record.terminalId }, 'Failed to persist Codex restore identity')
        void this.failCodexFreshIdentity(record.terminalId, 'candidate_persist_failed').catch((failErr) => {
          logger.error({ err: failErr, terminalId: record.terminalId }, 'Failed to mark Codex terminal non-restorable after candidate persistence failure')
        })
      })
    })
    if (candidateUnsubscribe) unsubscribers.push(candidateUnsubscribe)

    const turnStartedUnsubscribe = sidecar.onTurnStarted?.((event) => {
      if (!isCurrentSidecar()) return
      this.emit('codex.turn.started', {
        terminalId: record.terminalId,
        at: Date.now(),
      } satisfies CodexTurnStartedEvent)
      void this.handleCodexTurnStarted(record.terminalId, event).catch((err) => {
        logger.error({ err, terminalId: record.terminalId }, 'Failed to update Codex turn-start durability state')
      })
    })
    if (turnStartedUnsubscribe) unsubscribers.push(turnStartedUnsubscribe)

    const turnCompletedUnsubscribe = sidecar.onTurnCompleted?.((event) => {
      if (!isCurrentSidecar()) return
      this.emit('codex.turn.completed', {
        terminalId: record.terminalId,
        at: Date.now(),
      } satisfies CodexTurnCompletedEvent)
      void this.handleCodexTurnCompleted(record.terminalId, event).catch((err) => {
        logger.error({ err, terminalId: record.terminalId }, 'Failed to proof Codex rollout after turn completion')
      })
    })
    if (turnCompletedUnsubscribe) unsubscribers.push(turnCompletedUnsubscribe)

    const repairUnsubscribe = sidecar.onRepairTrigger?.((event) => {
      if (!isCurrentSidecar()) return
      if (event.kind === 'candidate_capture_timeout') {
        void this.failCodexFreshIdentity(record.terminalId, 'candidate_capture_timeout').catch((err) => {
          logger.error({ err, terminalId: record.terminalId }, 'Failed to mark Codex terminal non-restorable after candidate capture timeout')
        })
        return
      }
      if (event.kind === 'proxy_close' || event.kind === 'proxy_error') {
        this.handleCodexLifecycleLoss(record.terminalId, event)
        return
      }
      this.requestCodexDurabilityProof(record.terminalId, `repair:${event.kind}`)
    })
    if (repairUnsubscribe) unsubscribers.push(repairUnsubscribe)

    const fsChangedUnsubscribe = sidecar.onFsChanged?.((event) => {
      if (!isCurrentSidecar()) return
      this.handleCodexRolloutFsChanged(record.terminalId, event)
    })
    if (fsChangedUnsubscribe) unsubscribers.push(fsChangedUnsubscribe)

    record.codexSidecarLifecycleUnsubscribe = () => {
      for (const unsubscribe of unsubscribers.splice(0)) {
        unsubscribe()
      }
    }
  }

  private armCodexRolloutWatch(record: TerminalRecord): void {
    const candidate = record.codexDurability?.candidate
    const sidecar = record.codexSidecar
    if (!candidate || !sidecar?.watchPath) return
    if (record.codexRolloutWatch?.rolloutPath === candidate.rolloutPath) return

    this.unwatchCodexRollout(record, 'replace')
    const watchId = `codex-rollout-${record.terminalId}-${Date.now()}`
    record.codexRolloutWatch = { watchId, rolloutPath: candidate.rolloutPath }
    sidecar.watchPath(candidate.rolloutPath, watchId)
      .then(() => {
        logger.debug({
          terminalId: record.terminalId,
          watchId,
          rolloutPath: candidate.rolloutPath,
        }, 'Watching Codex rollout proof path')
      })
      .catch((err) => {
        if (record.codexRolloutWatch?.watchId === watchId) {
          record.codexRolloutWatch = undefined
        }
        logger.warn({
          err,
          terminalId: record.terminalId,
          watchId,
          rolloutPath: candidate.rolloutPath,
        }, 'Failed to watch Codex rollout proof path')
      })
  }

  private unwatchCodexRollout(record: TerminalRecord, reason: string): void {
    const watch = record.codexRolloutWatch
    if (!watch) return
    record.codexRolloutWatch = undefined
    record.codexSidecar?.unwatchPath?.(watch.watchId).catch((err) => {
      logger.warn({
        err,
        terminalId: record.terminalId,
        watchId: watch.watchId,
        rolloutPath: watch.rolloutPath,
        reason,
      }, 'Failed to unwatch Codex rollout proof path')
    })
  }

  private handleCodexRolloutFsChanged(
    terminalId: string,
    event: { watchId: string; changedPaths: string[] },
  ): void {
    const record = this.terminals.get(terminalId)
    if (!record?.codexRolloutWatch) return
    const watch = record.codexRolloutWatch
    if (event.watchId !== watch.watchId) return
    if (event.changedPaths.length > 0 && !event.changedPaths.includes(watch.rolloutPath)) return
    this.requestCodexDurabilityProof(terminalId, 'fs_changed')
  }

  private codexCandidateMatches(record: TerminalRecord, threadId: string | undefined): boolean {
    if (!threadId) return false
    const candidateThreadId = record.codexDurability?.candidate?.candidateThreadId
    return record.resumeSessionId === threadId || candidateThreadId === threadId
  }

  private getCodexRecoveryThreadId(record: TerminalRecord): string | undefined {
    const durableThreadId = record.codexDurability?.state === 'durable'
      ? record.codexDurability.durableThreadId
      : undefined
    return durableThreadId ?? record.resumeSessionId ?? record.codexDurability?.candidate?.candidateThreadId
  }

  private buildCodexDurabilityRef(candidate: CodexRemoteProxyCandidate, capturedAt: number): CodexDurabilityRef | undefined {
    const candidateThreadId = candidate.thread.id
    const rolloutPath = typeof candidate.thread.path === 'string' ? candidate.thread.path : undefined
    if (!candidateThreadId || !rolloutPath || candidate.thread.ephemeral === true || !path.isAbsolute(rolloutPath)) {
      return undefined
    }
    return {
      schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
      state: 'captured_pre_turn',
      candidate: {
        provider: 'codex',
        candidateThreadId,
        rolloutPath,
        source: candidate.source as CodexCandidateSource,
        capturedAt,
      },
    }
  }

  private codexDurabilityRecordToRef(record: CodexDurabilityStoreRecord): CodexDurabilityRef {
    return {
      schemaVersion: record.schemaVersion,
      state: record.state,
      ...(record.candidate ? { candidate: record.candidate } : {}),
      ...(record.turnCompletedAt !== undefined ? { turnCompletedAt: record.turnCompletedAt } : {}),
      ...(record.lastProofFailure ? { lastProofFailure: record.lastProofFailure } : {}),
      ...(record.durableThreadId ? { durableThreadId: record.durableThreadId } : {}),
      ...(record.nonRestorableReason ? { nonRestorableReason: record.nonRestorableReason } : {}),
    }
  }

  async readCodexDurabilityForRestoreLocator(locator: CodexDurabilityRestoreLocator): Promise<CodexDurabilityRef | undefined> {
    return (await this.readCodexDurabilityRecordForRestoreLocator(locator))?.durability
  }

  async readCodexDurabilityRecordForRestoreLocator(locator: CodexDurabilityRestoreLocator): Promise<CodexDurabilityRestoreRecord | undefined> {
    const record = await this.codexDurabilityStore.readForRestoreLocator(locator)
    return record
      ? {
          terminalId: record.terminalId,
          durability: this.codexDurabilityRecordToRef(record),
        }
      : undefined
  }

  async deleteCodexDurabilityStoreRecord(terminalId: string, reason: string): Promise<void> {
    await this.codexDurabilityStore.delete(terminalId)
    logger.info({ terminalId, reason }, 'Deleted Codex durability store record')
  }

  private async writeCodexDurability(record: TerminalRecord, durability: CodexDurabilityRef, updatedAt = Date.now()): Promise<CodexDurabilityRef> {
    const stored = await this.codexDurabilityStore.write({
      ...durability,
      terminalId: record.terminalId,
      ...(record.envContext?.tabId ? { tabId: record.envContext.tabId } : {}),
      ...(record.envContext?.paneId ? { paneId: record.envContext.paneId } : {}),
      serverInstanceId: this.serverInstanceId,
      updatedAt,
    })
    const storedDurability = this.codexDurabilityRecordToRef(stored)
    record.codexDurability = storedDurability
    return storedDurability
  }

  private async replaceCodexDurabilityStoreRecord(record: TerminalRecord, durability: CodexDurabilityRef, updatedAt = Date.now()): Promise<CodexDurabilityRef> {
    await this.codexDurabilityStore.delete(record.terminalId)
    return this.writeCodexDurability(record, durability, updatedAt)
  }

  private async persistCodexCandidate(terminalId: string, candidate: CodexRemoteProxyCandidate): Promise<void> {
    const previous = this.codexCandidatePersistenceQueues.get(terminalId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistCodexCandidateSerial(terminalId, candidate))
    this.codexCandidatePersistenceQueues.set(terminalId, next)
    void next.finally(() => {
      if (this.codexCandidatePersistenceQueues.get(terminalId) === next) {
        this.codexCandidatePersistenceQueues.delete(terminalId)
      }
    }).catch(() => undefined)
    return next
  }

  private async persistCodexCandidateSerial(terminalId: string, candidate: CodexRemoteProxyCandidate): Promise<void> {
    const record = this.terminals.get(terminalId)
    if (!record || record.status !== 'running') return
    if (record.mode !== 'codex') return
    if (record.resumeSessionId) return

    const capturedAt = Date.now()
    const durability = this.buildCodexDurabilityRef(candidate, capturedAt)
    if (!durability?.candidate) {
      logger.warn({
        terminalId,
        threadId: candidate.thread.id,
        rolloutPath: candidate.thread.path,
        ephemeral: candidate.thread.ephemeral,
        source: candidate.source,
      }, 'Ignoring Codex restore identity candidate without deterministic rollout path')
      return
    }

    if (record.codexDurability?.candidate) {
      const existing = record.codexDurability.candidate
      if (
        existing.candidateThreadId === durability.candidate.candidateThreadId
        && existing.rolloutPath === durability.candidate.rolloutPath
      ) {
        record.codexSidecar?.markCandidatePersisted?.()
        return
      }
      logger.warn({
        terminalId,
        existingThreadId: existing.candidateThreadId,
        candidateThreadId: durability.candidate.candidateThreadId,
      }, 'Ignoring mismatched Codex restore identity candidate after one was already persisted')
      return
    }

    const stored = await this.codexDurabilityStore.write({
      ...durability,
      terminalId: record.terminalId,
      ...(record.envContext?.tabId ? { tabId: record.envContext.tabId } : {}),
      ...(record.envContext?.paneId ? { paneId: record.envContext.paneId } : {}),
      serverInstanceId: this.serverInstanceId,
      updatedAt: capturedAt,
    })
    const latest = this.terminals.get(terminalId)
    if (
      latest !== record
      || record.status !== 'running'
      || record.resumeSessionId
      || record.codexDurability?.state === 'non_restorable'
    ) {
      if (record.status === 'running' && record.resumeSessionId && record.codexDurability?.state === 'durable') {
        await this.replaceCodexDurabilityStoreRecord(record, record.codexDurability)
      } else {
        await this.codexDurabilityStore.delete(terminalId)
      }
      logger.warn({
        terminalId,
        threadId: durability.candidate.candidateThreadId,
        rolloutPath: durability.candidate.rolloutPath,
      }, 'Discarded late Codex restore identity candidate after terminal stopped accepting candidates')
      return
    }
    if (record.codexDurability?.candidate) {
      const existing = record.codexDurability.candidate
      if (
        existing.candidateThreadId === durability.candidate.candidateThreadId
        && existing.rolloutPath === durability.candidate.rolloutPath
      ) {
        record.codexSidecar?.markCandidatePersisted?.()
      } else if (record.codexDurability) {
        await this.replaceCodexDurabilityStoreRecord(record, record.codexDurability)
      }
      return
    }
    const storedDurability = this.codexDurabilityRecordToRef(stored)
    record.codexDurability = storedDurability
    record.codexInputGate = undefined
    record.codexSidecar?.markCandidatePersisted?.()
    this.armCodexRolloutWatch(record)
    logger.info({
      terminalId,
      candidateThreadId: storedDurability.candidate?.candidateThreadId,
      rolloutPath: storedDurability.candidate?.rolloutPath,
      source: storedDurability.candidate?.source,
    }, 'Persisted Codex restore identity before user input')
    if (storedDurability.candidate) {
      recordSessionLifecycleEvent({
        kind: 'codex_candidate_captured',
        provider: 'codex',
        terminalId,
        candidateThreadId: storedDurability.candidate.candidateThreadId,
        rolloutPath: storedDurability.candidate.rolloutPath,
        source: storedDurability.candidate.source,
        generation: record.codexSidecarGeneration ?? 0,
      })
    }
    this.broadcastCodexDurability(record, storedDurability)
  }

  private async failCodexFreshIdentity(terminalId: string, reason: string): Promise<void> {
    const record = this.terminals.get(terminalId)
    if (!record || record.mode !== 'codex' || record.status !== 'running') return
    if (record.codexDurability?.candidate || record.resumeSessionId) return

    const durability: CodexDurabilityRef = {
      schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
      state: 'non_restorable',
      nonRestorableReason: reason,
    }
    try {
      const stored = await this.writeCodexDurability(record, durability)
      record.codexInputGate = undefined
      this.broadcastCodexDurability(record, stored)
    } catch (err) {
      logger.error({ err, terminalId, reason }, 'Failed to persist non-restorable Codex identity state')
    }
    logger.warn({ terminalId, reason }, 'Closing Codex terminal before user input because restore identity was not captured')
    await this.killAndWait(terminalId)
  }

  private async handleCodexTurnStarted(terminalId: string, event: CodexTurnEvent): Promise<void> {
    const record = this.terminals.get(terminalId)
    if (!record || record.status !== 'running') return
    if (!this.codexCandidateMatches(record, event.threadId)) return
    record.codexActiveTurn = event
    record.codexUnconfirmedInputAt = undefined
    record.codexUnconfirmedInputSource = undefined
    if (!record.codexDurability?.candidate || record.codexDurability.state === 'durable') return

    const durability: CodexDurabilityRef = {
      ...record.codexDurability,
      state: 'turn_in_progress_unproven',
    }
    const stored = await this.writeCodexDurability(record, durability)
    logger.info({
      terminalId,
      candidateThreadId: stored.candidate?.candidateThreadId,
      turnId: event.turnId,
    }, 'Codex turn started before restore proof')
    this.broadcastCodexDurability(record, stored)
  }

  private async handleCodexTurnCompleted(terminalId: string, event: CodexTurnEvent): Promise<void> {
    const record = this.terminals.get(terminalId)
    if (!record || record.status !== 'running') return
    if (!this.codexCandidateMatches(record, event.threadId)) return
    const completedActiveTurn = (
      record.codexActiveTurn?.threadId === event.threadId
      && !!record.codexActiveTurn.turnId
      && !!event.turnId
      && record.codexActiveTurn.turnId === event.turnId
    )
    if (completedActiveTurn) {
      record.codexActiveTurn = undefined
      record.codexUnconfirmedInputAt = undefined
      record.codexUnconfirmedInputSource = undefined
    }
    if (!record.codexDurability?.candidate || record.codexDurability.state === 'durable') return

    const completedAt = Date.now()
    const durability: CodexDurabilityRef = {
      ...record.codexDurability,
      state: 'proof_checking',
      turnCompletedAt: completedAt,
    }
    const stored = await this.writeCodexDurability(record, durability, completedAt)
    logger.info({
      terminalId,
      candidateThreadId: stored.candidate?.candidateThreadId,
      rolloutPath: stored.candidate?.rolloutPath,
      turnId: event.turnId,
    }, 'Codex turn completed; checking rollout proof')
    this.broadcastCodexDurability(record, stored)
    this.requestCodexDurabilityProof(terminalId, 'turn_completed')
  }

  private requestCodexDurabilityProof(terminalId: string, trigger: string): void {
    const record = this.terminals.get(terminalId)
    if (
      !record
      || !record.codexDurability?.candidate
      || record.codexDurability.state === 'durable'
      || record.codexDurability.state === 'non_restorable'
    ) return
    if (record.codexDurability.turnCompletedAt === undefined) {
      logger.debug({ terminalId, trigger }, 'Skipping Codex rollout proof before turn completion')
      return
    }
    const proofState = record.codexDurabilityProof ?? {}
    record.codexDurabilityProof = proofState
    if (proofState.inFlight) {
      proofState.rerunRequested = true
      return
    }

    const run = async (): Promise<void> => {
      do {
        proofState.rerunRequested = false
        await this.runCodexDurabilityProof(terminalId, trigger)
      } while (proofState.rerunRequested)
    }
    proofState.inFlight = run()
      .catch((err) => {
        logger.error({ err, terminalId, trigger }, 'Codex rollout proof execution failed')
      })
      .finally(() => {
        const current = this.terminals.get(terminalId)
        if (current?.codexDurabilityProof === proofState) {
          proofState.inFlight = undefined
          proofState.rerunRequested = false
        }
      })
  }

  private async runCodexDurabilityProof(terminalId: string, trigger: string): Promise<void> {
    const record = this.terminals.get(terminalId)
    if (
      !record
      || !record.codexDurability?.candidate
      || record.codexDurability.state === 'durable'
      || record.codexDurability.state === 'non_restorable'
    ) return
    const candidate = record.codexDurability.candidate
    const preProofDurability = record.codexDurability

    const checking: CodexDurabilityRef = {
      ...record.codexDurability,
      state: 'proof_checking',
    }
    const checkingStored = await this.writeCodexDurability(record, checking)
    this.broadcastCodexDurability(record, checkingStored)

    const proof = await proofCodexRollout({
      rolloutPath: candidate.rolloutPath,
      candidateThreadId: candidate.candidateThreadId,
    })
    const checkedAt = Date.now()
    if (proof.ok) {
      const bound = this.bindSession(terminalId, 'codex', proof.rolloutProofId, 'association')
      if (!bound.ok) {
        const failed: CodexDurabilityRef = {
          ...checkingStored,
          state: 'non_restorable',
          lastProofFailure: undefined,
          nonRestorableReason: `session_binding_failed:${bound.reason}`,
        }
        const stored = await this.writeCodexDurability(record, failed, checkedAt)
        record.codexDurabilityProof = undefined
        this.unwatchCodexRollout(record, 'session_binding_failed')
        logger.warn({ terminalId, proof, reason: bound.reason }, 'Codex rollout proof succeeded but session binding failed')
        this.broadcastCodexDurability(record, stored)
        await this.killAndWait(terminalId).catch((err) => {
          logger.warn({ err, terminalId }, 'Failed to close Codex terminal after session binding failure')
        })
        return
      }
      const durable: CodexDurabilityRef = {
        ...checkingStored,
        state: 'durable',
        durableThreadId: proof.rolloutProofId,
        lastProofFailure: undefined,
      }
      const stored = await this.writeCodexDurability(record, durable, checkedAt)
      record.codexDurabilityProof = undefined
      this.unwatchCodexRollout(record, 'durable')
      logger.info({
        terminalId,
        candidateThreadId: candidate.candidateThreadId,
        durableThreadId: proof.rolloutProofId,
        rolloutPath: candidate.rolloutPath,
        trigger,
      }, 'Codex rollout proof succeeded')
      this.broadcastCodexDurability(record, stored)
      this.broadcastCodexSessionAssociated(record, proof.rolloutProofId)
      recordSessionLifecycleEvent({
        kind: 'codex_durable_session_observed',
        provider: 'codex',
        terminalId,
        sessionId: proof.rolloutProofId,
        generation: record.codexSidecarGeneration ?? 0,
        source: 'sidecar',
      })
      return
    }

    const failed: CodexDurabilityRef = {
      ...checkingStored,
      state: checkingStored.turnCompletedAt !== undefined
        ? 'durability_unproven_after_completion'
        : preProofDurability.state,
      lastProofFailure: {
        reason: proof.reason,
        message: proof.message,
        checkedAt,
      },
    }
    const stored = await this.writeCodexDurability(record, failed, checkedAt)
    logger.warn({
      terminalId,
      candidateThreadId: candidate.candidateThreadId,
      rolloutPath: candidate.rolloutPath,
      trigger,
      reason: proof.reason,
      message: proof.message,
    }, 'Codex rollout proof failed')
    this.broadcastCodexDurability(record, stored)
  }

  async promoteCodexDurabilityFromCreateProof(
    terminalId: string,
    durableThreadId: string,
    checkedAt = Date.now(),
  ): Promise<BindSessionResult> {
    const record = this.terminals.get(terminalId)
    if (!record) return { ok: false, reason: 'terminal_missing' }
    if (record.mode !== 'codex') return { ok: false, reason: 'mode_mismatch' }
    if (record.status !== 'running') return { ok: false, reason: 'terminal_not_running' }

    const bound = this.bindSession(terminalId, 'codex', durableThreadId, 'association')
    if (!bound.ok) return bound
    const sessionId = bound.sessionId
    record.resumeSessionId = sessionId

    const durability: CodexDurabilityRef = {
      schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
      state: 'durable',
      ...(record.codexDurability?.candidate ? { candidate: record.codexDurability.candidate } : {}),
      ...(record.codexDurability?.turnCompletedAt !== undefined ? { turnCompletedAt: record.codexDurability.turnCompletedAt } : {}),
      durableThreadId: sessionId,
    }
    const stored = await this.writeCodexDurability(record, durability, checkedAt)
    record.codexDurabilityProof = undefined
    this.unwatchCodexRollout(record, 'durable')
    logger.info({
      terminalId,
      durableThreadId: sessionId,
    }, 'Codex rollout proof promoted captured restore state during terminal.create')
    this.broadcastCodexDurability(record, stored)
    recordSessionLifecycleEvent({
      kind: 'codex_durable_session_observed',
      provider: 'codex',
      terminalId,
      sessionId,
      generation: record.codexSidecarGeneration ?? 0,
      source: 'sidecar',
    })
    return { ok: true, terminalId, sessionId }
  }

  private needsCodexFinalDurabilityProof(record: TerminalRecord): boolean {
    return record.mode === 'codex'
      && !record.resumeSessionId
      && !!record.codexDurability?.candidate
      && record.codexDurability.state !== 'durable'
      && record.codexDurability.state !== 'non_restorable'
  }

  private async proveCodexBeforeFinalLoss(record: TerminalRecord, trigger: string): Promise<void> {
    if (!this.needsCodexFinalDurabilityProof(record)) return
    try {
      await this.runCodexDurabilityProof(record.terminalId, trigger)
    } catch (err) {
      logger.warn({ err, terminalId: record.terminalId, trigger }, 'Final Codex rollout proof read failed')
    }
  }

  private closeCodexTerminalAfterBlockedLifecycleLoss(record: TerminalRecord, event: unknown): void {
    if (!record.codexRecoveryBlockedError) return
    if (this.terminals.get(record.terminalId) !== record || record.status !== 'running') return
    logger.error(
      { err: record.codexRecoveryBlockedError, terminalId: record.terminalId, event },
      'Closing Codex terminal because durable recovery is blocked after lifecycle loss',
    )
    this.kill(record.terminalId)
  }

  private broadcastCodexDurability(record: TerminalRecord, durability: CodexDurabilityRef): void {
    for (const client of record.clients) {
      this.safeSend(client, {
        type: 'terminal.codex.durability.updated',
        terminalId: record.terminalId,
        durability,
      }, { terminalId: record.terminalId, perf: record.perf })
    }
    this.emit('terminal.codex.durability.updated', {
      terminalId: record.terminalId,
      durability,
    })
  }

  private broadcastCodexSessionAssociated(record: TerminalRecord, sessionId: string): void {
    for (const client of record.clients) {
      this.safeSend(client, {
        type: 'terminal.session.associated',
        terminalId: record.terminalId,
        sessionRef: {
          provider: 'codex',
          sessionId,
        },
      }, { terminalId: record.terminalId, perf: record.perf })
    }
  }

  publishCodexSidecar(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (!record) {
      throw new Error(`Cannot publish Codex sidecar for missing terminal ${terminalId}.`)
    }
    if (record.codexSidecarPrePublicationLoss !== undefined) {
      throw new Error('Codex app-server reported lifecycle loss before terminal create completed.')
    }
    if (record.status !== 'running') {
      throw new Error('Codex terminal PTY exited before create completed.')
    }
    if (!record.codexSidecar) return
    record.codexSidecarLifecyclePublished = true
  }

  private handleCodexLifecycleLoss(terminalId: string, event: unknown): void {
    const record = this.terminals.get(terminalId)
    if (!record || record.status !== 'running' || record.codexRecoveryFinalClose) return

    if (!record.codexSidecarLifecyclePublished) {
      record.codexSidecarPrePublicationLoss = event
      logger.warn(
        { terminalId, event },
        'Codex app-server reported lifecycle loss before terminal create completed',
      )
      return
    }

    const eventThreadId = typeof event === 'object' && event !== null && 'threadId' in event
      ? (event as { threadId?: unknown }).threadId
      : undefined
    if (
      typeof eventThreadId === 'string'
      && (record.resumeSessionId || record.codexDurability?.candidate?.candidateThreadId)
      && !this.codexCandidateMatches(record, eventThreadId)
    ) {
      return
    }

    this.clearCodexPendingCleanExitFinalizer(record)

    if (!record.resumeSessionId || !record.codexRecovery) {
      if (record.codexLifecycleLossProofPending) return
      void (async () => {
        record.codexLifecycleLossProofPending = true
        try {
          await this.proveCodexBeforeFinalLoss(record, 'lifecycle_loss')
          if (record.status !== 'running') return
          if (record.resumeSessionId && record.codexRecovery) {
            if (!this.startCodexDurableRecovery(record, { source: 'lifecycle_loss', event })) {
              this.closeCodexTerminalAfterBlockedLifecycleLoss(record, event)
            }
            return
          }
          logger.warn(
            { terminalId, event },
            'Codex app-server reported terminal lifecycle loss without durable recovery; closing terminal',
          )
          await this.killAndWait(terminalId).catch((err) => {
            logger.error({ err, terminalId }, 'Failed to close terminal after Codex app-server lifecycle loss')
          })
        } finally {
          record.codexLifecycleLossProofPending = false
        }
      })()
      return
    }

    if (!this.startCodexDurableRecovery(record, { source: 'lifecycle_loss', event })) {
      this.closeCodexTerminalAfterBlockedLifecycleLoss(record, event)
    }
  }

  private startCodexDurableRecovery(
    record: TerminalRecord,
    trigger: { source: 'lifecycle_loss'; event: unknown } | { source: 'pty_exit'; exitCode: number; signal?: number },
  ): boolean {
    if (
      record.mode !== 'codex'
      || record.status !== 'running'
      || record.codexRecoveryFinalClose
      || !record.resumeSessionId
      || !record.codexRecovery
    ) {
      return false
    }

    if (record.codexRecoveryBlockedError) {
      logger.error(
        { err: record.codexRecoveryBlockedError, terminalId: record.terminalId, trigger },
        'Codex durable recovery is blocked by a previous sidecar teardown failure',
      )
      return false
    }

    if (record.codexRecoveryAttempt) return true

    logger.warn(
      { terminalId: record.terminalId, trigger, resumeSessionId: record.resumeSessionId },
      'Codex durable terminal lost its live worker; starting durable recovery',
    )
    record.codexRecoveryAttemptSerial = (record.codexRecoveryAttemptSerial ?? 0) + 1
    record.codexRecoveryRetiringPty = record.pty
    let attempt!: Promise<void>
    attempt = Promise.resolve()
      .then(() => this.runCodexRecoveryLoop(record.terminalId))
      .catch((err) => {
        logger.error({ err, terminalId: record.terminalId }, 'Codex durable recovery loop failed')
        if (record.codexRecoveryBlockedError && this.terminals.get(record.terminalId) === record && record.status === 'running') {
          if (trigger.source === 'pty_exit') {
            this.finishTerminalPtyExit(record, {
              exitCode: trigger.exitCode,
              signal: trigger.signal,
            })
          } else {
            this.closeCodexTerminalAfterBlockedLifecycleLoss(record, trigger.event)
          }
        }
      })
      .finally(() => {
        const latest = this.terminals.get(record.terminalId)
        if (latest?.codexRecoveryAttempt === attempt) {
          latest.codexRecoveryAttempt = undefined
          latest.codexRecoveryRetiringPty = undefined
        }
      })
    record.codexRecoveryAttempt = attempt
    return true
  }

  private isCleanPtyExit(event: { exitCode: number; signal?: number }): boolean {
    return event.exitCode === 0 && (!event.signal || event.signal === 0)
  }

  private clearCodexPendingCleanExitFinalizer(record: TerminalRecord): void {
    const pending = record.codexPendingCleanExitFinalizer
    if (!pending) return
    clearTimeout(pending.timer)
    record.codexPendingCleanExitFinalizer = undefined
    record.codexCleanExitDecisionPending = undefined
  }

  private shouldDelayCodexCleanExitForLifecycleLoss(record: TerminalRecord, event: { exitCode: number; signal?: number }): boolean {
    return record.mode === 'codex'
      && this.isCleanPtyExit(event)
      && !!record.resumeSessionId
      && !!record.codexRecovery
      && record.codexSidecarLifecyclePublished === true
      && !record.codexRecoveryAttempt
      && !record.codexLifecycleLossProofPending
      && !record.codexRecoveryFinalClose
  }

  private scheduleCodexCleanExitFinalizer(
    record: TerminalRecord,
    ptyProc: pty.IPty,
    event: { exitCode: number; signal?: number },
  ): boolean {
    if (!this.shouldDelayCodexCleanExitForLifecycleLoss(record, event)) return false
    this.clearCodexPendingCleanExitFinalizer(record)
    record.codexCleanExitDecisionPending = true
    const timer = setTimeout(() => {
      if (record.codexPendingCleanExitFinalizer?.timer !== timer) return
      record.codexPendingCleanExitFinalizer = undefined
      record.codexCleanExitDecisionPending = undefined
      if (this.terminals.get(record.terminalId) !== record) return
      if (record.pty !== ptyProc || record.status === 'exited') return
      if (record.codexRecoveryAttempt || record.codexLifecycleLossProofPending) return
      this.finishTerminalPtyExit(record, event)
    }, CODEX_CLEAN_EXIT_LIFECYCLE_LOSS_GRACE_MS)
    timer.unref?.()
    record.codexPendingCleanExitFinalizer = { timer }
    return true
  }

  private hasHandledPtyExit(record: TerminalRecord, ptyProc: pty.IPty): boolean {
    return record.codexHandledPtyExits?.has(ptyProc) ?? false
  }

  private markHandledPtyExit(record: TerminalRecord, ptyProc: pty.IPty): void {
    record.codexHandledPtyExits ??= new WeakSet()
    record.codexHandledPtyExits.add(ptyProc)
  }

  private shouldCheckCodexActiveTurnBeforeCleanExit(record: TerminalRecord, event: { exitCode: number; signal?: number }): boolean {
    return this.isCleanPtyExit(event)
      && !record.codexRecoveryAttempt
      && !record.codexLifecycleLossProofPending
      && !!this.getCodexRecoveryThreadId(record)
      && (
        !!record.codexActiveTurn
        || record.codexUnconfirmedInputAt !== undefined
      )
  }

  private async shouldRecoverCleanCodexExitForActiveTurn(record: TerminalRecord): Promise<boolean> {
    const initialSnapshot = record.codexActiveTurn
      ? { turn: record.codexActiveTurn, reliable: true }
      : await this.findCurrentCodexActiveTurn(record)
    let turn = initialSnapshot.turn
    if (!turn) {
      if (!initialSnapshot.reliable) return true
      const delayedSnapshot = await this.waitForRecentCodexInputVisibility(record)
      turn = delayedSnapshot.turn
      if (!turn) return !delayedSnapshot.reliable
    }

    if (!turn.turnId) {
      const currentSnapshot = await this.findCurrentCodexActiveTurn(record)
      turn = currentSnapshot.turn
      if (!turn) return !currentSnapshot.reliable
    }

    if (!turn.turnId || (!record.codexSidecar?.listThreadTurns && !record.codexSidecar?.readThreadTurn)) {
      return true
    }

    try {
      const latestTurnStatus = await this.readCodexTurnStatusForCleanExit(record, turn.threadId, turn.turnId)
      if (latestTurnStatus === 'inProgress') return true
      record.codexActiveTurn = undefined
      record.codexUnconfirmedInputAt = undefined
      const currentSnapshot = await this.findCurrentCodexActiveTurn(record)
      if (currentSnapshot.turn) return true
      return !currentSnapshot.reliable
    } catch (err) {
      logger.warn({
        err,
        terminalId: record.terminalId,
        threadId: turn.threadId,
        turnId: turn.turnId,
      }, 'Failed to read Codex active turn before clean PTY exit recovery decision')
      return true
    }
  }

  private async readCodexTurnStatusForCleanExit(
    record: TerminalRecord,
    threadId: string,
    turnId: string,
  ): Promise<string | undefined> {
    if (record.codexSidecar?.listThreadTurns) {
      let cursor: string | undefined
      for (;;) {
        const page = await record.codexSidecar.listThreadTurns({
          threadId,
          limit: 50,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
          ...(cursor ? { cursor } : {}),
        })
        const turn = page.turns.find((candidate) => candidate.id === turnId)
        if (turn) return turn.status
        if (!page.nextCursor) return undefined
        cursor = page.nextCursor
      }
    }

    const turn = await record.codexSidecar!.readThreadTurn!({ threadId, turnId })
    return turn.status
  }

  private async waitForRecentCodexInputVisibility(record: TerminalRecord): Promise<{ turn?: CodexTurnEvent; reliable: boolean }> {
    if (record.codexUnconfirmedInputAt === undefined) return { reliable: true }
    if (!record.codexSidecar?.listThreadTurns) return { reliable: true }
    const elapsedMs = Date.now() - record.codexUnconfirmedInputAt
    const remainingMs = CODEX_CLEAN_EXIT_RECENT_INPUT_GRACE_MS - elapsedMs
    if (remainingMs <= 0) return { reliable: record.codexUnconfirmedInputSource !== 'input' }

    logger.debug({
      terminalId: record.terminalId,
      elapsedMs,
      graceMs: CODEX_CLEAN_EXIT_RECENT_INPUT_GRACE_MS,
    }, 'Waiting briefly for recent Codex input to appear in turn listing before clean PTY exit decision')
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
    const snapshot = await this.findCurrentCodexActiveTurn(record)
    return snapshot
  }

  private async findCurrentCodexActiveTurn(record: TerminalRecord): Promise<{ turn?: CodexTurnEvent; reliable: boolean }> {
    const threadId = this.getCodexRecoveryThreadId(record)
    if (!threadId || !record.codexSidecar?.listThreadTurns) return { reliable: true }

    try {
      const page = await record.codexSidecar.listThreadTurns({
        threadId,
        limit: 50,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      })
      const inProgress = page.turns.find((turn) => turn.status === 'inProgress')
      if (!inProgress) return { reliable: true }
      const event: CodexTurnEvent = {
        threadId,
        turnId: inProgress.id,
        params: {},
      }
      record.codexActiveTurn = event
      return { turn: event, reliable: true }
    } catch (err) {
      logger.warn({
        err,
        terminalId: record.terminalId,
        threadId,
      }, 'Failed to list Codex turns before clean PTY exit recovery decision')
      return { reliable: false }
    }
  }

  private shouldRecoverCodexPtyExit(record: TerminalRecord, event: { exitCode: number; signal?: number }): boolean {
    return Boolean(record.codexRecoveryAttempt || record.codexLifecycleLossProofPending) || !this.isCleanPtyExit(event)
  }

  private canContinueCodexRecovery(record: TerminalRecord | undefined, resumeSessionId?: string): record is TerminalRecord {
    const expectedResumeSessionId = resumeSessionId ?? record?.resumeSessionId
    if (
      !record
      || record.status !== 'running'
      || record.codexRecoveryFinalClose
      || record.codexRecoveryBlockedError
      || !record.codexRecovery
      || !expectedResumeSessionId
    ) {
      return false
    }

    return this.ensureCodexRecoverySessionBinding(record, expectedResumeSessionId)
  }

  private ensureCodexRecoverySessionBinding(record: TerminalRecord, resumeSessionId: string): boolean {
    if (
      record.status !== 'running'
      || record.codexRecoveryFinalClose
      || record.codexRecoveryBlockedError
      || !record.codexRecovery
    ) {
      return false
    }

    const provider = record.mode as CodingCliProviderName
    const expectedKey = makeSessionKey(provider, resumeSessionId)
    const owner = this.bindingAuthority.ownerForSession(provider, resumeSessionId)
    if (owner && owner !== record.terminalId) return false

    const currentBinding = this.bindingAuthority.sessionForTerminal(record.terminalId)
    if (currentBinding && currentBinding !== expectedKey) return false

    if (!currentBinding) {
      const bound = this.bindSession(record.terminalId, provider, resumeSessionId, 'resume')
      if (!bound.ok) return false
    }

    record.resumeSessionId = resumeSessionId
    return true
  }

  private async runCodexRecoveryLoop(terminalId: string): Promise<void> {
    while (true) {
      const record = this.terminals.get(terminalId)
      if (!this.canContinueCodexRecovery(record)) return
      const resumeSessionId = record.resumeSessionId!

      try {
        await this.runCodexRecoveryAttempt(record, resumeSessionId)
        return
      } catch (err) {
        if (
          (err as { codexRecoveryTeardownFailed?: boolean })?.codexRecoveryTeardownFailed
          || isCodexSidecarTeardownError(err)
        ) {
          this.blockCodexRecovery(record, err)
          throw err
        }
        logger.warn(
          { err, terminalId, resumeSessionId: record.resumeSessionId },
          'Codex durable recovery candidate failed; retrying after teardown',
        )
      }

      const latest = this.terminals.get(terminalId)
      if (!this.canContinueCodexRecovery(latest, resumeSessionId)) return
      await this.waitForCodexRecoveryRetry(latest, latest.codexRecovery?.retryDelayMs ?? 1_000)
    }
  }

  private waitForCodexRecoveryRetry(record: TerminalRecord, delayMs: number): Promise<void> {
    if (record.codexRecoveryFinalClose) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (record.codexRecoveryRetry?.timer === timer) {
          record.codexRecoveryRetry = undefined
        }
        resolve()
      }, Math.max(0, delayMs))
      timer.unref?.()
      record.codexRecoveryRetry = {
        timer,
        resolve: () => {
          clearTimeout(timer)
          if (record.codexRecoveryRetry?.timer === timer) {
            record.codexRecoveryRetry = undefined
          }
          resolve()
        },
      }
    })
  }

  private blockCodexRecovery(record: TerminalRecord, err: unknown): void {
    record.codexRecoveryBlockedError = err instanceof Error ? err : new Error(String(err))
    const retry = record.codexRecoveryRetry
    if (retry) {
      retry.resolve()
    }
  }

  private markCodexRecoveryFinalClose(record: TerminalRecord): void {
    record.codexRecoveryFinalClose = true
    this.clearCodexPendingCleanExitFinalizer(record)
    const retry = record.codexRecoveryRetry
    if (retry) {
      retry.resolve()
    }
  }

  private async runCodexRecoveryAttempt(
    record: TerminalRecord,
    resumeSessionId: string,
  ): Promise<void> {
    const recovery = record.codexRecovery
    if (!recovery) return
    const generation = (record.codexSidecarGeneration ?? 0) + 1
    let plan: CodexLaunchPlan | undefined
    let candidate: { pty: ReturnType<typeof pty.spawn>; mcpCwd?: string; exited: boolean; exitCode?: number } | undefined
    let published = false

    const cleanupCandidate = async () => {
      if (candidate && !published) {
        try {
          candidate.pty.kill()
        } catch (err) {
          logger.warn({ err, terminalId: record.terminalId }, 'Failed to kill unpublished Codex recovery PTY')
        }
      }
      if (plan) {
        try {
          await this.trackSidecarShutdown(
            record.terminalId,
            `recovery-candidate:${generation}`,
            () => plan!.sidecar.shutdown(),
            'Codex recovery candidate sidecar shutdown failed',
          )
        } catch (err) {
          throw codexRecoveryTeardownError(
            `Codex recovery candidate teardown failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }

    try {
      plan = await recovery.planCreate({
        terminalId: record.terminalId,
        generation,
        cwd: record.cwd,
        resumeSessionId,
      })
      if (!this.canContinueCodexRecovery(this.terminals.get(record.terminalId), resumeSessionId)) {
        await cleanupCandidate()
        return
      }

      candidate = this.spawnCodexRecoveryPty(record, plan, resumeSessionId)
      await plan.sidecar.adopt({ terminalId: record.terminalId, generation })
      if (candidate.exited) {
        throw new Error(`Codex recovery candidate PTY exited before publication with code ${candidate.exitCode ?? 'unknown'}.`)
      }

      const latest = this.terminals.get(record.terminalId)
      if (!this.canContinueCodexRecovery(latest, resumeSessionId) || latest !== record) {
        await cleanupCandidate()
        return
      }

      const oldPty = record.pty
      const oldSidecar = record.codexSidecar
      record.codexRecoveryRetiringPty = oldPty
      if (oldSidecar) {
        try {
          await this.trackSidecarShutdown(
            record.terminalId,
            `recovery-retiring:${record.codexSidecarGeneration ?? 0}`,
            () => oldSidecar.shutdown(),
            'Codex retiring sidecar shutdown failed',
          )
        } catch (err) {
          record.codexRecoveryRetiringPty = undefined
          throw codexRecoveryTeardownError(
            `Codex retiring sidecar teardown failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      if (candidate.exited) {
        throw new Error(`Codex recovery candidate PTY exited before publication with code ${candidate.exitCode ?? 'unknown'}.`)
      }

      const latestAfterRetire = this.terminals.get(record.terminalId)
      if (!this.canContinueCodexRecovery(latestAfterRetire, resumeSessionId) || latestAfterRetire !== record) {
        record.codexRecoveryRetiringPty = undefined
        await cleanupCandidate()
        return
      }

      record.codexSidecarLifecycleUnsubscribe?.()
      record.codexSidecarLifecycleUnsubscribe = undefined
      record.pty = candidate.pty
      record.mcpCwd = candidate.mcpCwd
      record.codexSidecar = plan.sidecar
      record.codexSidecarLifecyclePublished = true
      record.codexSidecarPrePublicationLoss = undefined
      record.codexSidecarGeneration = generation
      this.registerCodexSidecarLifecycle(record)
      record.codexRecoveryRetiringPty = undefined
      record.codexRecoveryAttempt = undefined
      published = true

      try {
        let oldPtyExited = false
        let forceRetireTimer: NodeJS.Timeout | undefined
        oldPty.onExit(() => {
          oldPtyExited = true
          if (forceRetireTimer) {
            clearTimeout(forceRetireTimer)
            forceRetireTimer = undefined
          }
        })
        oldPty.kill('SIGTERM')
        forceRetireTimer = setTimeout(() => {
          if (oldPtyExited) return
          try {
            oldPty.kill('SIGKILL')
          } catch {
            // The old PTY may already be gone; the delayed kill is only a safety net.
          }
        }, 500)
        forceRetireTimer.unref?.()
      } catch (err) {
        logger.warn({ err, terminalId: record.terminalId }, 'Failed to retire previous Codex recovery PTY')
      }
    } catch (err) {
      if (!published) {
        record.codexRecoveryRetiringPty = undefined
        await cleanupCandidate()
      }
      throw err
    }
  }

  private spawnCodexRecoveryPty(
    record: TerminalRecord,
    plan: CodexLaunchPlan,
    resumeSessionId: string,
  ): { pty: ReturnType<typeof pty.spawn>; mcpCwd?: string; exited: boolean; exitCode?: number } {
    const providerSettings: ProviderSettings = {
      codexAppServer: {
        ...plan.remote,
        sidecar: plan.sidecar,
      },
    }
    const { file, args, env, cwd: procCwd, mcpCwd } = buildSpawnSpec(
      record.mode,
      record.cwd,
      record.shell,
      resumeSessionId,
      providerSettings,
      this.buildTerminalBaseEnv(record.terminalId, record.envContext),
      record.terminalId,
    )

    const ptyProc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: record.cols,
      rows: record.rows,
      cwd: procCwd,
      env: env as any,
    })
    const candidate = { pty: ptyProc, mcpCwd, exited: false, exitCode: undefined as number | undefined }
    this.attachCodexRecoveryPtyHandlers(record, ptyProc, candidate)
    return candidate
  }

  private attachCodexRecoveryPtyHandlers(
    record: TerminalRecord,
    ptyProc: ReturnType<typeof pty.spawn>,
    candidate?: { exited: boolean; exitCode?: number },
  ): void {
    ptyProc.onData((data) => {
      if (record.pty !== ptyProc || record.status !== 'running') return
      const now = Date.now()
      record.lastActivityAt = now
      record.buffer.append(data)
      this.emit('terminal.output.raw', {
        terminalId: record.terminalId,
        data,
        at: now,
      } satisfies TerminalOutputRawEvent)
      for (const client of record.clients) {
        if (record.suppressedOutputClients.has(client)) continue
        const pending = record.pendingSnapshotClients.get(client)
        if (pending) {
          const nextChars = pending.queuedChars + data.length
          if (data.length > this.maxPendingSnapshotChars || nextChars > this.maxPendingSnapshotChars) {
            try {
              client.close(4008, 'Attach snapshot queue overflow')
            } catch {
              // ignore
            }
            record.pendingSnapshotClients.delete(client)
            record.clients.delete(client)
            continue
          }
          pending.chunks.push(data)
          pending.queuedChars = nextChars
          continue
        }
        this.sendTerminalOutput(client, record.terminalId, data, record.perf)
      }
    })

    ptyProc.onExit((event) => {
      if (this.hasHandledPtyExit(record, ptyProc)) return
      this.markHandledPtyExit(record, ptyProc)
      if (candidate) {
        candidate.exited = true
        candidate.exitCode = event.exitCode
      }
      if (!record.codexRecoveryFinalClose && record.codexRecoveryRetiringPty === ptyProc) {
        return
      }
      if (record.pty !== ptyProc || record.status === 'exited') return
      const finishExit = () => {
        if (
          this.shouldRecoverCodexPtyExit(record, event)
          && this.startCodexDurableRecovery(record, {
            source: 'pty_exit',
            exitCode: event.exitCode,
            signal: event.signal,
          })
        ) {
          return
        }
        if (!this.scheduleCodexCleanExitFinalizer(record, ptyProc, event)) {
          this.finishTerminalPtyExit(record, event)
        }
      }
      const finishExitAfterActiveTurnCheck = () => {
        if (!this.shouldCheckCodexActiveTurnBeforeCleanExit(record, event)) {
          finishExit()
          return
        }
        record.codexCleanExitDecisionPending = true
        const recoverySerial = record.codexRecoveryAttemptSerial ?? 0
        void (async () => {
          try {
            const shouldRecover = await this.shouldRecoverCleanCodexExitForActiveTurn(record)
            if ((record.codexRecoveryAttemptSerial ?? 0) !== recoverySerial) return
            if (record.pty !== ptyProc || record.status === 'exited') return
            if (record.codexRecoveryAttempt || record.codexLifecycleLossProofPending) return
            if (
              shouldRecover
              && this.startCodexDurableRecovery(record, {
                source: 'pty_exit',
                exitCode: event.exitCode,
                signal: event.signal,
              })
            ) {
              return
            }
            if (!this.scheduleCodexCleanExitFinalizer(record, ptyProc, event)) {
              this.finishTerminalPtyExit(record, event)
            }
          } finally {
            if (this.terminals.get(record.terminalId) === record && !record.codexPendingCleanExitFinalizer) {
              record.codexCleanExitDecisionPending = undefined
            }
          }
        })()
      }
      if (this.needsCodexFinalDurabilityProof(record)) {
        if (record.codexLifecycleLossProofPending) return
        void (async () => {
          await this.proveCodexBeforeFinalLoss(record, 'pty_exit')
          if (record.pty !== ptyProc || record.status === 'exited') return
          finishExitAfterActiveTurnCheck()
        })()
        return
      }
      finishExitAfterActiveTurnCheck()
    })
  }

  attach(terminalId: string, client: WebSocket, opts?: { pendingSnapshot?: boolean; suppressOutput?: boolean }): TerminalRecord | null {
    const term = this.terminals.get(terminalId)
    if (!term) return null
    term.clients.add(client)
    if (opts?.pendingSnapshot) term.pendingSnapshotClients.set(client, { chunks: [], queuedChars: 0 })
    if (opts?.suppressOutput) term.suppressedOutputClients.add(client)
    return term
  }

  finishAttachSnapshot(terminalId: string, client: WebSocket): void {
    const term = this.terminals.get(terminalId)
    if (!term) return
    const queued = term.pendingSnapshotClients.get(client)
    if (!queued) return
    term.pendingSnapshotClients.delete(client)
    for (const data of queued.chunks) {
      this.sendTerminalOutput(client, terminalId, data, term.perf)
    }
  }

  detach(terminalId: string, client: WebSocket): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    this.flushOutputBuffer(client)
    this.clearOutputBuffer(client)
    term.clients.delete(client)
    term.suppressedOutputClients.delete(client)
    term.pendingSnapshotClients.delete(client)
    return true
  }

  input(terminalId: string, data: string): TerminalInputResult {
    const term = this.terminals.get(terminalId)
    if (!term) return { status: 'no_terminal' }
    if (
      term.mode === 'codex'
      && term.codexDurability?.state === 'non_restorable'
    ) {
      if (term.codexDurability.nonRestorableReason === 'candidate_capture_timeout') {
        return { status: 'blocked_codex_identity_capture_timeout', terminalId }
      }
      return {
        status: 'blocked_codex_identity_unavailable',
        terminalId,
        reason: term.codexDurability.nonRestorableReason,
      }
    }
    if (term.status !== 'running') return { status: 'not_running' }
    if (term.codexRecoveryAttempt) {
      return { status: 'blocked_codex_recovery_pending', terminalId }
    }
    if (term.codexCleanExitDecisionPending) {
      return { status: 'blocked_codex_clean_exit_decision_pending', terminalId }
    }
    if (term.codexLifecycleLossProofPending) {
      return { status: 'blocked_codex_lifecycle_loss_pending', terminalId }
    }
    if (term.codexInputGate?.state === 'identity_pending') {
      if (isCodexStartupTerminalControlInput(data)) {
        term.pty.write(data)
        return { status: 'written' }
      }
      return { status: 'blocked_codex_identity_pending', terminalId }
    }
    const now = Date.now()
    term.lastActivityAt = now
    if (term.perf) {
      term.perf.inBytes += data.length
      term.perf.inChunks += 1
      term.perf.lastInputBytes = data.length
      term.perf.pendingInputBytes += data.length
      term.perf.pendingInputCount += 1
      if (term.perf.pendingInputAt === undefined) {
        term.perf.pendingInputAt = now
      }
    }
    if (term.mode === 'codex') {
      term.codexUnconfirmedInputAt = now
      term.codexUnconfirmedInputSource = 'input'
    }
    term.pty.write(data)
    this.emit('terminal.input.raw', {
      terminalId,
      data,
      at: now,
    } satisfies TerminalInputRawEvent)
    return { status: 'written' }
  }

  acknowledgeCodexCandidatePersisted(input: {
    terminalId: string
    candidateThreadId: string
    rolloutPath: string
  }): 'accepted' | 'missing_terminal' | 'mismatch' | 'no_candidate' {
    const term = this.terminals.get(input.terminalId)
    if (!term) return 'missing_terminal'
    const candidate = term.codexDurability?.candidate
    if (!candidate) return 'no_candidate'
    if (
      candidate.candidateThreadId !== input.candidateThreadId
      || candidate.rolloutPath !== input.rolloutPath
    ) {
      return 'mismatch'
    }
    return 'accepted'
  }

  releaseCodexInputGateForTest(terminalId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    term.codexInputGate = undefined
    term.codexSidecar?.markCandidatePersisted?.()
    return true
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const term = this.terminals.get(terminalId)
    if (!term || term.status !== 'running') return false
    if (term.cols === cols && term.rows === rows) return true
    term.cols = cols
    term.rows = rows
    try {
      term.pty.resize(cols, rows)
    } catch (err) {
      logger.debug({ err, terminalId }, 'resize failed')
    }
    return true
  }

  kill(terminalId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    if (term.status === 'exited') {
      void this.releaseCodexSidecar(term).catch(() => undefined)
      return true
    }
    this.markCodexRecoveryFinalClose(term)
    cleanupMcpConfig(terminalId, term.mode, term.mcpCwd)
    try {
      term.pty.kill()
    } catch (err) {
      logger.warn({ err, terminalId }, 'kill failed')
    }
    term.status = 'exited'
    term.exitCode = term.exitCode ?? 0
    const now = Date.now()
    term.lastActivityAt = now
    term.exitedAt = now
    for (const client of term.clients) {
      this.flushOutputBuffer(client)
      this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: term.exitCode })
    }
    term.clients.clear()
    term.suppressedOutputClients.clear()
    term.pendingSnapshotClients.clear()
    this.recordTerminalExitWithoutDurableSession(term, term.exitCode, 'user_final_close')
    this.releaseBinding(terminalId, 'exit')
    this.emit('terminal.exit', { terminalId, exitCode: term.exitCode })
    this.forgetCodexDurabilityStoreRecord(term, 'user_final_close')
    void this.releaseCodexSidecar(term).catch(() => undefined)
    this.reapExitedTerminals()
    return true
  }

  async killAndWait(terminalId: string): Promise<boolean> {
    const term = this.terminals.get(terminalId)
    const ok = this.kill(terminalId)
    if (!ok) return false
    const recoveryAttempt = term?.codexRecoveryAttempt
      ? term.codexRecoveryAttempt.catch((err) => {
          logger.error({ err, terminalId }, 'Codex recovery did not finish cleanly during terminal close')
          throw err
        })
      : undefined
    const joins = [this.waitForSidecarShutdown(terminalId)]
    if (recoveryAttempt) joins.push(recoveryAttempt)
    const failures = await collectShutdownFailures(joins)
    throwShutdownFailures(failures, 'Codex terminal final close failed.')
    return true
  }

  remove(terminalId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    this.kill(terminalId)
    this.terminals.delete(terminalId)
    this.forgetCodexDurabilityStoreRecord(term, 'remove')
    return true
  }

  private releaseCodexSidecar(term: TerminalRecord): Promise<void> {
    const existing = this.sidecarShutdowns.get(this.sidecarShutdownKey(term.terminalId))
    if (existing?.status === 'pending') return existing.promise

    this.unwatchCodexRollout(term, 'sidecar_release')
    term.codexSidecarLifecycleUnsubscribe?.()
    term.codexSidecarLifecycleUnsubscribe = undefined
    const sidecar = term.codexSidecar
    if (!sidecar) return existing?.promise ?? Promise.resolve()

    return this.trackSidecarShutdown(
      term.terminalId,
      'current',
      async () => {
        await sidecar.shutdown()
        if (term.codexSidecar === sidecar) {
          term.codexSidecar = undefined
          term.codexSidecarLifecyclePublished = undefined
          term.codexSidecarPrePublicationLoss = undefined
        }
      },
      'Codex sidecar shutdown failed',
    )
  }

  private sidecarShutdownKey(terminalId: string, scope = 'current'): string {
    return scope === 'current' ? terminalId : `${terminalId}:${scope}`
  }

  private sidecarShutdownPromisesForTerminal(terminalId: string): Promise<void>[] {
    const prefix = `${terminalId}:`
    return [...this.sidecarShutdowns.entries()]
      .filter(([key]) => key === terminalId || key.startsWith(prefix))
      .map(([key, entry]) => this.runSidecarShutdownEntry(key, entry))
  }

  private trackSidecarShutdown(
    terminalId: string,
    scope: string,
    shutdownSidecar: () => Promise<void>,
    failureMessage: string,
  ): Promise<void> {
    const key = this.sidecarShutdownKey(terminalId, scope)
    const existing = this.sidecarShutdowns.get(key)
    if (existing?.status === 'pending') return existing.promise

    const entry: SidecarShutdownEntry = existing ?? {
      promise: Promise.resolve(),
      status: 'failed',
      terminalId,
      shutdownSidecar,
      failureMessage,
    }
    entry.terminalId = terminalId
    entry.shutdownSidecar = shutdownSidecar
    entry.failureMessage = failureMessage
    this.sidecarShutdowns.set(key, entry)
    return this.runSidecarShutdownEntry(key, entry)
  }

  private runSidecarShutdownEntry(key: string, entry: SidecarShutdownEntry): Promise<void> {
    if (entry.status === 'pending') return entry.promise
    entry.status = 'pending'
    const shutdown = Promise.resolve()
      .then(() => entry.shutdownSidecar())
      .then(() => {
        if (this.sidecarShutdowns.get(key) === entry) {
          this.sidecarShutdowns.delete(key)
        }
      })
      .catch((err) => {
        if (this.sidecarShutdowns.get(key) === entry) {
          entry.status = 'failed'
        }
        logger.error({ err, terminalId: entry.terminalId }, entry.failureMessage)
        throw err
      })
    entry.promise = shutdown
    return shutdown
  }

  private async waitForSidecarShutdown(terminalId: string): Promise<void> {
    const term = this.terminals.get(terminalId)
    const promises = new Set<Promise<void>>()
    if (term) promises.add(this.releaseCodexSidecar(term))
    for (const promise of this.sidecarShutdownPromisesForTerminal(terminalId)) {
      promises.add(promise)
    }
    const failures = await collectShutdownFailures([...promises])
    throwShutdownFailures(failures, 'Codex terminal sidecar shutdown failed.')
  }

  private async waitForCodexShutdownWork(records: Iterable<TerminalRecord>): Promise<void> {
    const recordList = Array.from(records)
    const recoveryAttempts = recordList
      .map((term) => term.codexRecoveryAttempt)
      .filter((promise): promise is Promise<void> => !!promise)
    const sidecarShutdowns = new Set<Promise<void>>()
    for (const term of recordList) {
      sidecarShutdowns.add(this.releaseCodexSidecar(term))
    }
    for (const [key, entry] of [...this.sidecarShutdowns.entries()]) {
      sidecarShutdowns.add(this.runSidecarShutdownEntry(key, entry))
    }
    const failures = [
      ...await collectShutdownFailures(recoveryAttempts),
      ...await collectShutdownFailures([...sidecarShutdowns]),
    ]
    throwShutdownFailures(failures, 'Codex registry shutdown work failed.')
  }

  list(): Array<{
    terminalId: string
    title: string
    description?: string
    mode: TerminalMode
    resumeSessionId?: string
    sessionRef?: { provider: CodingCliProviderName; sessionId: string }
    createdAt: number
    lastActivityAt: number
    status: 'running' | 'exited'
    hasClients: boolean
    cwd?: string
    codexDurability?: CodexDurabilityRef
  }> {
    return Array.from(this.terminals.values()).map((t) => ({
      terminalId: t.terminalId,
      title: t.title,
      description: t.description,
      mode: t.mode,
      resumeSessionId: t.resumeSessionId,
      sessionRef: buildTerminalSessionRef(t),
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      status: t.status,
      hasClients: t.clients.size > 0,
      cwd: t.cwd,
      codexDurability: t.codexDurability,
    }))
  }

  get(terminalId: string): TerminalRecord | undefined {
    return this.terminals.get(terminalId)
  }

  getAttachedClientCount(terminalId: string): number {
    const term = this.terminals.get(terminalId)
    return term ? term.clients.size : 0
  }

  listAttachedClientIds(terminalId: string): string[] {
    const term = this.terminals.get(terminalId)
    if (!term) return []
    const ids: string[] = []
    for (const client of term.clients) {
      const connectionId = (client as LiveWebSocket).connectionId
      if (connectionId) ids.push(connectionId)
    }
    return ids
  }

  private releaseBinding(
    terminalId: string,
    reason: SessionUnbindReason,
    explicit?: { provider?: CodingCliProviderName; sessionId?: string; cwd?: string },
  ): void {
    const rec = this.terminals.get(terminalId)
    const existingBinding = this.bindingAuthority.sessionForTerminal(terminalId)
    const existing = existingBinding ? parseSessionKey(existingBinding) : undefined
    const provider = explicit?.provider
      ?? existing?.provider
      ?? (rec && modeSupportsResume(rec.mode) ? rec.mode as CodingCliProviderName : undefined)
    const sessionId = explicit?.sessionId
      ?? existing?.sessionId
      ?? rec?.resumeSessionId
    this.bindingAuthority.unbindTerminal(terminalId)
    if (rec) rec.resumeSessionId = undefined
    if (!provider || !sessionId) return
    this.emit('terminal.session.unbound', {
      terminalId,
      provider,
      sessionId,
      reason,
    } satisfies TerminalSessionUnboundEvent)
  }

  private isMobileClient(client: WebSocket): boolean {
    return (client as LiveWebSocket).isMobileClient === true
  }

  private hasClientBacklog(client: WebSocket): boolean {
    const buffered = (client as any).bufferedAmount as number | undefined
    return typeof buffered === 'number' && buffered > 0
  }

  private clearOutputBuffer(client: WebSocket): void {
    const pending = this.outputBuffers.get(client)
    if (!pending) return
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    this.outputBuffers.delete(client)
  }

  private flushOutputBuffer(client: WebSocket): void {
    const pending = this.outputBuffers.get(client)
    if (!pending) return

    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }

    if (pending.queuedChars <= 0) {
      this.outputBuffers.delete(client)
      return
    }

    for (const [terminalId, chunks] of pending.chunksByTerminal) {
      if (chunks.length === 0) continue
      const data = chunks.join('')
      const perf = pending.perfByTerminal.get(terminalId)
      this.safeSendOutputFrames(client, terminalId, data, perf)
    }
    this.outputBuffers.delete(client)
  }

  private safeSendOutputFrames(
    client: WebSocket,
    terminalId: string,
    data: string,
    perf?: TerminalRecord['perf'],
  ): void {
    if (!data) return
    // Legacy framing path. Broker cutover destination:
    // - safeSendOutputFrames + safeSend backpressure guards -> broker scheduler + catastrophic breaker.
    for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_FRAME_CHARS) {
      this.safeSend(
        client,
        {
          type: 'terminal.output',
          terminalId,
          data: data.slice(offset, offset + MAX_OUTPUT_FRAME_CHARS),
        },
        { terminalId, perf },
      )
    }
  }

  private sendTerminalOutput(client: WebSocket, terminalId: string, data: string, perf?: TerminalRecord['perf']): void {
    // Preserve immediate hard-stop behavior when the socket buffer is already over limit.
    // This avoids queueing additional data for clients that need explicit resync.
    const buffered = (client as any).bufferedAmount as number | undefined
    if (typeof buffered === 'number' && buffered > MAX_WS_BUFFERED_AMOUNT) {
      this.safeSendOutputFrames(client, terminalId, data, perf)
      return
    }

    const pendingExisting = this.outputBuffers.get(client)
    const shouldBatch = this.isMobileClient(client) || !!pendingExisting || this.hasClientBacklog(client)

    if (!shouldBatch) {
      this.safeSendOutputFrames(client, terminalId, data, perf)
      return
    }

    let pending = pendingExisting
    if (!pending) {
      pending = {
        timer: null,
        chunksByTerminal: new Map(),
        perfByTerminal: new Map(),
        queuedChars: 0,
      }
      this.outputBuffers.set(client, pending)
    }

    const nextSize = pending.queuedChars + data.length
    if (nextSize > MAX_OUTPUT_BUFFER_CHARS) {
      this.flushOutputBuffer(client)
      this.safeSendOutputFrames(client, terminalId, data, perf)
      return
    }

    const chunks = pending.chunksByTerminal.get(terminalId) || []
    chunks.push(data)
    pending.chunksByTerminal.set(terminalId, chunks)
    pending.perfByTerminal.set(terminalId, perf)
    pending.queuedChars = nextSize

    if (!pending.timer) {
      pending.timer = setTimeout(() => {
        this.flushOutputBuffer(client)
      }, OUTPUT_FLUSH_MS)
    }
  }

  safeSend(client: WebSocket, msg: unknown, context?: { terminalId?: string; perf?: TerminalRecord['perf'] }) {
    // Backpressure guard.
    const buffered = client.bufferedAmount as number | undefined
    if (typeof buffered === 'number' && buffered > MAX_WS_BUFFERED_AMOUNT) {
      if (context?.perf) context.perf.droppedMessages += 1
      if (perfConfig.enabled && context?.terminalId) {
        const key = `terminal_drop_${context.terminalId}`
        if (shouldLog(key, perfConfig.rateLimitMs)) {
          logPerfEvent(
            'terminal_output_dropped',
            {
              terminalId: context.terminalId,
              bufferedBytes: buffered,
              limitBytes: MAX_WS_BUFFERED_AMOUNT,
            },
            'warn',
          )
        }
      }
      // Prefer explicit resync over silent corruption.
      try {
        client.close(4008, 'Backpressure')
      } catch {
        // ignore
      }
      return
    }
    let messageType: string | undefined
    if (msg && typeof msg === 'object' && 'type' in msg) {
      const typeValue = (msg as { type?: unknown }).type
      if (typeof typeValue === 'string') messageType = typeValue
    }
    try {
      client.send(JSON.stringify(msg))
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          terminalId: context?.terminalId || 'unknown',
          messageType: messageType || 'unknown',
        },
        'Terminal output send failed',
      )
    }
  }

  broadcast(msg: unknown) {
    for (const term of this.terminals.values()) {
      for (const client of term.clients) {
        this.safeSend(client, msg)
      }
    }
  }

  updateTitle(terminalId: string, title: string) {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    term.title = title
    return true
  }

  updateDescription(terminalId: string, description: string | undefined) {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    term.description = description
    return true
  }

  /**
   * Find provider-mode terminals that match a session by exact resumeSessionId.
   * Providers with cwd-scoped session IDs (such as Kimi) also filter by cwd
   * when one is supplied.
   */
  findTerminalsBySession(mode: TerminalMode, sessionId: string, cwd?: string): TerminalRecord[] {
    const results: TerminalRecord[] = []
    for (const term of this.terminals.values()) {
      if (matchesScopedSession(mode, term, sessionId, cwd)) {
        results.push(term)
      }
    }
    return results
  }

  /**
   * Find a running terminal of the given mode that already owns the given sessionId.
   */
  findRunningTerminalBySession(mode: TerminalMode, sessionId: string, cwd?: string): TerminalRecord | undefined {
    if (modeSupportsResume(mode)) {
      const owner = this.bindingAuthority.ownerForSession(mode as CodingCliProviderName, sessionId)
      if (owner) {
        const rec = this.terminals.get(owner)
        if (rec && rec.status === 'running' && matchesScopedSession(mode, rec, sessionId, cwd)) {
          return rec
        }
        this.releaseBinding(owner, 'stale_owner', { provider: mode as CodingCliProviderName, sessionId, cwd })
      }
    }
    const matches = Array.from(this.terminals.values())
      .filter((term) => term.status === 'running' && matchesScopedSession(mode, term, sessionId, cwd))
    return matches[0]
  }

  getCanonicalRunningTerminalBySession(mode: TerminalMode, sessionId: string, cwd?: string): TerminalRecord | undefined {
    if (!modeSupportsResume(mode)) return undefined

    const owner = this.bindingAuthority.ownerForSession(mode as CodingCliProviderName, sessionId)
    if (owner) {
      const rec = this.terminals.get(owner)
      if (rec && rec.status === 'running' && matchesScopedSession(mode, rec, sessionId, cwd)) {
        return rec
      }
      this.releaseBinding(owner, 'stale_owner', { provider: mode as CodingCliProviderName, sessionId, cwd })
    }

    const matches = Array.from(this.terminals.values())
      .filter((term) => term.status === 'running' && matchesScopedSession(mode, term, sessionId, cwd))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

    return matches[0]
  }

  findRunningCodexTerminalByCandidate(candidateThreadId: string, rolloutPath: string): TerminalRecord | undefined {
    for (const term of this.terminals.values()) {
      const candidate = term.codexDurability?.candidate
      if (
        term.mode === 'codex'
        && term.status === 'running'
        && candidate?.candidateThreadId === candidateThreadId
        && candidate.rolloutPath === rolloutPath
      ) {
        return term
      }
    }
    return undefined
  }

  repairLegacySessionOwners(mode: TerminalMode, sessionId: string, cwd?: string): RepairLegacySessionOwnersResult {
    if (!modeSupportsResume(mode)) {
      return { repaired: false, clearedTerminalIds: [] }
    }
    const matches = Array.from(this.terminals.values())
      .filter((term) => term.status === 'running' && matchesScopedSession(mode, term, sessionId, cwd))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    if (matches.length === 0) {
      return { repaired: false, clearedTerminalIds: [] }
    }

    const provider = mode as CodingCliProviderName
    const canonical = matches[0]
    const owner = this.bindingAuthority.ownerForSession(provider, sessionId)
    const canonicalKey = makeSessionKey(provider, sessionId)
    const canonicalBinding = this.bindingAuthority.sessionForTerminal(canonical.terminalId)
    const needsCanonicalBind = owner !== canonical.terminalId || canonicalBinding !== canonicalKey
    const clearedTerminalIds: string[] = []
    const clearedTerminals = new Set<string>()

    if (owner && owner !== canonical.terminalId) {
      const ownerIsDuplicate = matches.some((term) => term.terminalId === owner)
      this.releaseBinding(owner, ownerIsDuplicate ? 'repair_duplicate' : 'stale_owner', { provider, sessionId, cwd })
      if (ownerIsDuplicate) {
        clearedTerminalIds.push(owner)
        clearedTerminals.add(owner)
      }
    }

    let canonicalBound = true
    if (needsCanonicalBind) {
      const bound = this.bindSession(canonical.terminalId, provider, sessionId, 'resume')
      if (bound.ok) {
        canonical.resumeSessionId = sessionId
      } else {
        canonicalBound = false
        logger.warn(
          {
            provider,
            sessionId,
            canonicalTerminalId: canonical.terminalId,
            reason: bound.reason,
            ...(bound.reason === 'session_already_owned' ? { ownerTerminalId: bound.owner } : {}),
            ...(bound.reason === 'terminal_already_bound' ? { existingBinding: bound.existing } : {}),
          },
          'session_bind_repair_failed',
        )
      }
    }

    for (const duplicate of matches.slice(1)) {
      if (clearedTerminals.has(duplicate.terminalId)) continue
      this.releaseBinding(duplicate.terminalId, 'repair_duplicate', { provider, sessionId, cwd })
      clearedTerminalIds.push(duplicate.terminalId)
    }

    const repaired = clearedTerminalIds.length > 0 || (needsCanonicalBind && canonicalBound)
    if (repaired && (clearedTerminalIds.length > 0 || owner !== canonical.terminalId)) {
      logger.info(
        {
          provider,
          sessionId,
          canonicalTerminalId: canonical.terminalId,
          previousOwnerTerminalId: owner,
          clearedTerminalIds,
        },
        'session_bind_repair_applied',
      )
    }
    return {
      repaired,
      canonicalTerminalId: canonical.terminalId,
      clearedTerminalIds,
    }
  }

  /**
   * Find a running Claude terminal that already owns the given sessionId.
   * @deprecated Use findRunningTerminalBySession('claude', sessionId) instead.
   */
  findRunningClaudeTerminalBySession(sessionId: string): TerminalRecord | undefined {
    return this.findRunningTerminalBySession('claude', sessionId)
  }

  /**
   * Find terminals of a given mode that have no resumeSessionId (waiting to be associated)
   * and whose cwd matches the given path. Results sorted by createdAt (oldest first).
   */
  findUnassociatedTerminals(mode: TerminalMode, cwd: string): TerminalRecord[] {
    const results: TerminalRecord[] = []
    // Platform-aware normalization: case-insensitive on Windows, case-sensitive on Unix
    const normalize = (p: string) => {
      const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '')
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    }
    const targetCwd = normalize(cwd)

    for (const term of this.terminals.values()) {
      if (term.status !== 'running') continue
      if (term.mode !== mode) continue
      if (term.resumeSessionId) continue // Already associated
      if (!term.cwd) continue
      if (normalize(term.cwd) === targetCwd) {
        results.push(term)
      }
    }
    // Sort by createdAt ascending (oldest first), with fallback for safety
    return results.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  /**
   * Find claude-mode terminals that have no resumeSessionId (waiting to be associated)
   * and whose cwd matches the given path. Results sorted by createdAt (oldest first).
   */
  findUnassociatedClaudeTerminals(cwd: string): TerminalRecord[] {
    return this.findUnassociatedTerminals('claude', cwd)
  }

  /**
   * Set the resumeSessionId on a terminal (one-time association).
   * Returns false if terminal not found.
   */
  bindSession(
    terminalId: string,
    provider: CodingCliProviderName,
    sessionId: string,
    reason: SessionBindingReason = 'association',
  ): BindSessionResult {
    const term = this.terminals.get(terminalId)
    if (!term) return { ok: false, reason: 'terminal_missing' }
    if (term.mode !== provider) return { ok: false, reason: 'mode_mismatch' }
    if (term.status !== 'running') return { ok: false, reason: 'terminal_not_running' }

    const normalized = normalizeResumeForBinding(provider, sessionId)
    if (!normalized) return { ok: false, reason: 'invalid_session_id' }

    const currentBinding = this.bindingAuthority.sessionForTerminal(terminalId)
    const currentKey = currentBinding ?? (term.resumeSessionId ? makeSessionKey(provider, term.resumeSessionId) : undefined)
    const nextKey = makeSessionKey(provider, normalized)
    const owner = this.bindingAuthority.ownerForSession(provider, normalized)
    if (owner && owner !== terminalId) {
      logger.warn(
        {
          provider,
          sessionId: normalized,
          ownerTerminalId: owner,
          attemptedTerminalId: terminalId,
        },
        'session_bind_conflict',
      )
      return { ok: false, reason: 'session_already_owned', owner }
    }

    if (currentKey && currentKey !== nextKey) {
      const current = parseSessionKey(currentKey)
      this.releaseBinding(terminalId, 'rebind', current)
    }

    const bound = this.bindingAuthority.bind({ provider, sessionId: normalized, terminalId })
    if (!bound.ok) {
      if (bound.reason === 'session_already_owned') {
        logger.warn(
          {
            provider,
            sessionId: normalized,
            ownerTerminalId: bound.owner,
            attemptedTerminalId: terminalId,
          },
          'session_bind_conflict',
        )
      } else {
        logger.warn(
          {
            provider,
            sessionId: normalized,
            terminalId,
            existingBinding: bound.existing,
          },
          'session_terminal_already_bound',
        )
      }
      return bound
    }

    term.resumeSessionId = normalized
    this.emit('terminal.session.bound', {
      terminalId,
      provider,
      sessionId: normalized,
      reason,
    } satisfies TerminalSessionBoundEvent)
    recordSessionLifecycleEvent({
      kind: 'terminal_session_bound',
      terminalId,
      provider,
      sessionId: normalized,
      reason,
    })
    return { ok: true, terminalId, sessionId: normalized }
  }

  rebindSession(
    terminalId: string,
    provider: CodingCliProviderName,
    sessionId: string,
    reason: SessionBindingReason = 'association',
  ): BindSessionResult {
    const normalized = normalizeResumeForBinding(provider, sessionId)
    if (!normalized) return { ok: false, reason: 'invalid_session_id' }

    const owner = this.bindingAuthority.ownerForSession(provider, normalized)
    if (owner && owner !== terminalId) {
      this.releaseBinding(owner, 'rebind', { provider, sessionId: normalized })
    }

    return this.bindSession(terminalId, provider, normalized, reason)
  }

  setResumeSessionId(terminalId: string, sessionId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    if (term.mode === 'shell') return false
    return this.bindSession(terminalId, term.mode as CodingCliProviderName, sessionId, 'association').ok
  }

  /**
   * Check whether a session is already bound to any terminal.
   */
  isSessionBound(provider: CodingCliProviderName, sessionId: string, cwd?: string): boolean {
    const normalized = normalizeResumeForBinding(provider, sessionId)
    if (!normalized) return false
    return this.bindingAuthority.ownerForSession(provider, normalized) !== undefined
  }

  getSessionOwner(provider: CodingCliProviderName, sessionId: string): string | undefined {
    const normalized = normalizeResumeForBinding(provider, sessionId)
    if (!normalized) return undefined
    return this.bindingAuthority.ownerForSession(provider, normalized)
  }

  /**
   * Gracefully shutdown all terminals. Kills all running PTY processes
   * and clears the idle monitor timer.
   */
  shutdown(): void {
    // Stop the idle monitor
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    if (this.perfTimer) {
      clearInterval(this.perfTimer)
      this.perfTimer = null
    }

    // Kill all terminals
    const terminalIds = Array.from(this.terminals.keys())
    for (const terminalId of terminalIds) {
      this.kill(terminalId)
    }

    logger.info({ count: terminalIds.length }, 'All terminals shut down')
  }

  /**
   * Gracefully shutdown all terminals. Sends SIGTERM (or plain kill on Windows)
   * and waits for processes to exit, giving them time to flush writes.
   * Falls back to forced kill after timeout.
   */
  async shutdownGracefully(timeoutMs: number = 5000): Promise<void> {
    // Stop timers
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    if (this.perfTimer) {
      clearInterval(this.perfTimer)
      this.perfTimer = null
    }

    const running: TerminalRecord[] = []
    for (const term of this.terminals.values()) {
      if (term.status === 'running') running.push(term)
    }

    if (running.length === 0) {
      await this.waitForCodexShutdownWork(this.terminals.values())
      logger.info('No running terminals to shut down')
      return
    }

    // Use a single listener + resolver map instead of one listener per terminal,
    // to avoid exceeding maxListeners when many terminals are running.
    const resolvers = new Map<string, () => void>()
    const exitPromises = running.map(term =>
      new Promise<void>(resolve => {
        if (term.status === 'exited') { resolve(); return }
        resolvers.set(term.terminalId, resolve)
        // TOCTOU guard — status may mutate between filter and here
        if ((term.status as string) === 'exited') {
          resolvers.delete(term.terminalId)
          resolve()
        }
      })
    )
    const exitHandler = (evt: { terminalId: string }) => {
      const resolve = resolvers.get(evt.terminalId)
      if (resolve) {
        resolvers.delete(evt.terminalId)
        resolve()
        if (resolvers.size === 0) this.off('terminal.exit', exitHandler)
      }
    }
    if (resolvers.size > 0) this.on('terminal.exit', exitHandler)

    // Send SIGTERM (or plain kill on Windows where signal args are unsupported)
    const isWindows = process.platform === 'win32'
    for (const term of running) {
      this.markCodexRecoveryFinalClose(term)
      try {
        if (isWindows) {
          term.pty.kill()
        } else {
          term.pty.kill('SIGTERM')
        }
      } catch {
        // Already gone — will be cleaned up below
      }
    }

    logger.info({ count: running.length }, 'Sent SIGTERM to running terminals, waiting for exit...')

    // Wait for all to exit, or timeout
    await Promise.race([
      Promise.all(exitPromises),
      new Promise<void>(r => setTimeout(r, timeoutMs)),
    ])

    // Clean up the shared listener if any terminals didn't exit in time
    this.off('terminal.exit', exitHandler)
    resolvers.clear()

    // Force kill any that didn't exit in time
    let forceKilled = 0
    for (const term of running) {
      if (term.status !== 'exited') {
        this.kill(term.terminalId)
        forceKilled++
      }
    }

    if (forceKilled > 0) {
      logger.warn({ forceKilled }, 'Force-killed terminals after graceful timeout')
    }

    await this.waitForCodexShutdownWork(this.terminals.values())

    logger.info({ count: running.length, forceKilled }, 'All terminals shut down')
  }
}
