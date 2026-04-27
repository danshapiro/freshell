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
import { convertWindowsPathToWslPath, isReachableDirectorySync } from './path-utils.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
import type { LoopbackServerEndpoint } from './local-port.js'
import { makeSessionKey, parseSessionKey, type CodingCliProviderName } from './coding-cli/types.js'
import { SessionBindingAuthority, type BindResult } from './session-binding-authority.js'
import type {
  SessionBindingReason,
  SessionUnbindReason,
  TerminalInputRawEvent,
  TerminalOutputRawEvent,
  TerminalSessionBoundEvent,
  TerminalSessionUnboundEvent,
} from './terminal-stream/registry-events.js'
import type { CodexTerminalSidecar } from './coding-cli/codex-app-server/sidecar.js'
import type { CodexThreadLifecycleEvent } from './coding-cli/codex-app-server/client.js'
import type { CodexLaunchFactory, CodexLaunchPlan } from './coding-cli/codex-app-server/launch-planner.js'
import {
  CODEX_RECOVERY_INPUT_BUFFER_TTL_MS,
  CodexRecoveryPolicy,
  type CodexRecoveryState,
  type CodexWorkerCloseReason,
  type CodexWorkerFailureSource,
} from './coding-cli/codex-app-server/recovery-policy.js'
import { CodexRemoteTuiFailureDetector } from './coding-cli/codex-app-server/remote-tui-failure-detector.js'
import { getOpencodeEnvOverrides, resolveOpencodeLaunchModel } from './opencode-launch.js'
import { generateMcpInjection, cleanupMcpConfig } from './mcp/config-writer.js'
import {
  createTerminalStartupProbeState,
  extractTerminalStartupProbes,
  type TerminalStartupProbeColors,
  type TerminalStartupProbeState,
} from '../shared/terminal-startup-probes.js'

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
const perfConfig = getPerfConfig()
const PREATTACH_CODEX_STARTUP_PROBE_COLORS: TerminalStartupProbeColors = {
  foreground: '#c9d1d9',
  background: '#0d1117',
  cursor: '#c9d1d9',
}
const CODEX_RECOVERY_READINESS_TIMEOUT_MS = Number(process.env.CODEX_RECOVERY_READINESS_TIMEOUT_MS || 5_000)
const CODEX_PRE_DURABLE_STABILITY_MS = Number(process.env.CODEX_PRE_DURABLE_STABILITY_MS || 1_500)
const CODEX_RECOVERY_INPUT_NOT_SENT_MESSAGE =
  '\r\n[Freshell] Codex is reconnecting; input was not sent because recovery is still in progress.\r\n'
const CODEX_RECOVERY_FAILED_INPUT_MESSAGE =
  '\r\n[Freshell] Codex recovery failed. Close this pane or refresh after checking the server logs.\r\n'

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
    permissionModeEnvVar: 'OPENCODE_PERMISSION',
    permissionModeEnvValues: {
      plan: '{"edit":"ask","bash":"ask"}',
      acceptEdits: '{"edit":"allow","bash":"ask"}',
      bypassPermissions: '{"edit":"allow","bash":"allow"}',
    },
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
 * Check if a terminal mode supports session resume.
 * Only modes with configured resumeArgs in CODING_CLI_COMMANDS support resume.
 */
export function modeSupportsResume(mode: TerminalMode): boolean {
  if (mode === 'shell') return false
  return !!codingCliCommands.get(mode)?.resumeArgs
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
      args: [
        '-c', 'tui.notification_method=bel',
        '-c', "tui.notifications=['agent-turn-complete']",
        ...mcpInjection.args,
      ],
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
  }
  opencodeServer?: LoopbackServerEndpoint
}

export type TerminalEnvContext = { tabId?: string; paneId?: string }

export function buildFreshellTerminalEnv(
  terminalId: string,
  envContext?: TerminalEnvContext,
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
    remoteArgs.push('--remote', wsUrl)
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
    ? resolveOpencodeLaunchModel(providerSettings?.model, { ...process.env, ...commandEnv })
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

export type TerminalRecord = {
  terminalId: string
  title: string
  description?: string
  mode: TerminalMode
  codexSidecar?: Pick<CodexTerminalSidecar, 'shutdown'>
  opencodeServer?: LoopbackServerEndpoint
  resumeSessionId?: string
  pendingResumeName?: string
  createdAt: number
  lastActivityAt: number
  exitedAt?: number
  status: 'running' | 'exited'
  exitCode?: number
  cwd?: string
  /** Normalized cwd used for MCP config injection (may differ from raw cwd on WSL). */
  mcpCwd?: string
  cols: number
  rows: number
  clients: Set<WebSocket>
  suppressedOutputClients: Set<WebSocket>
  pendingSnapshotClients: Map<WebSocket, PendingSnapshotQueue>
  preAttachStartupProbeState?: TerminalStartupProbeState

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
  codex?: {
    recoveryState: CodexRecoveryState
    workerGeneration: number
    nextWorkerGeneration: number
    retiringGenerations: Set<number>
    closeReasonByGeneration: Map<number, CodexWorkerCloseReason>
    durableSessionId?: string
    originalResumeSessionId?: string
    currentWsUrl?: string
    currentAppServerPid?: number
    launchFactory?: CodexLaunchFactory
    launchBaseProviderSettings?: {
      model?: string
      sandbox?: string
      permissionMode?: string
    }
    envContext?: TerminalEnvContext
    recoveryPolicy: CodexRecoveryPolicy
    inputExpiryTimer?: NodeJS.Timeout
    remoteTuiFailureDetector: CodexRemoteTuiFailureDetector
    activeReplacement?: CodexActiveReplacement
  }
}

type TerminalLaunchSpec = {
  terminalId: string
  mode: TerminalMode
  shell: ShellType
  cwd?: string
  cols: number
  rows: number
  resumeSessionId?: string
  providerSettings?: ProviderSettings
  envContext?: TerminalEnvContext
  baseEnv: Record<string, string>
}

type SpawnedTerminalWorker = {
  pty: pty.IPty
  procCwd?: string
  mcpCwd?: string
}

type TerminalRuntimeStatus = 'running' | 'recovering' | 'recovery_failed'

type CodexActiveReplacement = {
  id: string
  attempt: number
  source: CodexWorkerFailureSource
  retiringGeneration: number
  candidateGeneration: number
  candidatePublished: boolean
  aborted: boolean
  retiringWsUrl?: string
  retiringAppServerPid?: number
  retiringPtyPid?: number
  pendingReadinessSessionId?: string
  pendingDurableSessionId?: string
  readinessTimer?: NodeJS.Timeout
  preDurableTimer?: NodeJS.Timeout
  backoffTimer?: NodeJS.Timeout
  candidateSidecar?: CodexLaunchPlan['sidecar']
  candidatePty?: pty.IPty
  candidateMcpCwd?: string
  candidateWsUrl?: string
  candidateAppServerPid?: number
}

export type BindSessionResult =
  | { ok: true; terminalId: string; sessionId: string }
  | { ok: false; reason: 'terminal_missing' | 'mode_mismatch' | 'invalid_session_id' | 'terminal_not_running' }
  | BindResult

export type RepairLegacySessionOwnersResult = {
  repaired: boolean
  canonicalTerminalId?: string
  clearedTerminalIds: string[]
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
  // Legacy transport batching path. Broker cutover destination:
  // - outputBuffers/flush timers/mobile batching -> broker client-output queue.
  private outputBuffers = new Map<WebSocket, PendingOutput>()

  constructor(settings?: ServerSettings, maxTerminals?: number, maxExitedTerminals?: number) {
    super()
    // Permanent terminal.exit listeners: index, ws-handler, broker, codex-wiring,
    // terminal-view. Shutdown uses a single shared listener (no per-terminal scaling).
    this.setMaxListeners(20)
    this.settings = settings
    this.maxTerminals = maxTerminals ?? MAX_TERMINALS
    this.maxExitedTerminals = maxExitedTerminals ?? Number(process.env.MAX_EXITED_TERMINALS || 200)
    this.scrollbackMaxChars = this.computeScrollbackMaxChars(settings)
    {
      const raw = Number(process.env.MAX_PENDING_SNAPSHOT_CHARS || DEFAULT_MAX_PENDING_SNAPSHOT_CHARS)
      this.maxPendingSnapshotChars = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_PENDING_SNAPSHOT_CHARS
    }
    this.startIdleMonitor()
    this.startPerfMonitor()
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
      if (term.mode === 'codex' && this.isCodexRecoveryProtected(term)) continue

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

  private reapExitedTerminals(): void {
    const max = this.maxExitedTerminals
    if (!max || max <= 0) return

    const exited = Array.from(this.terminals.values())
      .filter((t) => t.status === 'exited')
      .sort((a, b) => (a.exitedAt ?? a.lastActivityAt) - (b.exitedAt ?? b.lastActivityAt))

    const excess = exited.length - max
    if (excess <= 0) return
    for (let i = 0; i < excess; i += 1) {
      this.terminals.delete(exited[i].terminalId)
    }
  }

  private spawnTerminalWorker(spec: TerminalLaunchSpec): SpawnedTerminalWorker {
    const { file, args, env, cwd: procCwd, mcpCwd } = buildSpawnSpec(
      spec.mode,
      spec.cwd,
      spec.shell,
      spec.resumeSessionId,
      spec.providerSettings,
      spec.baseEnv,
      spec.terminalId,
    )

    const endSpawnTimer = startPerfTimer(
      'terminal_spawn',
      { terminalId: spec.terminalId, mode: spec.mode, shell: spec.shell },
      { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
    )

    logger.info({
      terminalId: spec.terminalId,
      file,
      args,
      cwd: procCwd,
      mode: spec.mode,
      shell: spec.shell,
    }, 'Spawning terminal')

    try {
      const ptyProc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: procCwd,
        env: env as any,
      })
      endSpawnTimer({ cwd: procCwd })
      return {
        pty: ptyProc,
        procCwd,
        mcpCwd,
      }
    } catch (err) {
      // Clean up MCP config temp files that were created before the spawn attempt.
      // Use mcpCwd (the Linux path passed to generateMcpInjection), not procCwd
      // (which may be undefined for WSL cmd/powershell paths).
      cleanupMcpConfig(spec.terminalId, spec.mode, mcpCwd)
      throw wrapTerminalSpawnError(err, {
        mode: spec.mode,
        file,
        resumeSessionId: spec.resumeSessionId,
      })
    }
  }

  private installTerminalWorkerHandlers(record: TerminalRecord, generation: number, attemptId?: string): void {
    record.pty.onData((data) => {
      if (record.mode === 'codex') {
        if (!this.isCurrentCodexGeneration(record, generation)) return
        if (record.codex?.retiringGenerations.has(generation)) return
      }
      this.handleTerminalWorkerData(record, generation, data)
      if (record.mode === 'codex') {
        const fatal = record.codex?.remoteTuiFailureDetector.push(data)
        if (fatal?.fatal) {
          void this.handleCodexWorkerFailure(
            record,
            generation,
            'remote_tui_fatal_output',
            new Error(`Codex remote TUI reported a fatal ${fatal.reason} condition.`),
            attemptId,
          )
        }
      }
    })

    record.pty.onExit((e) => {
      if (record.mode === 'codex') {
        const codex = record.codex
        if (!codex) return
        if (!this.isCurrentCodexGeneration(record, generation)) return
        if (codex.retiringGenerations.has(generation)) return
        const closeReason = codex.closeReasonByGeneration.get(generation)
        if (closeReason === 'recovery_retire') return
        if (closeReason === 'user_final_close') {
          this.finalizeTerminalExit(record, e.exitCode, 'user_final_close')
          return
        }
        void this.handleCodexWorkerFailure(
          record,
          generation,
          'pty_exit',
          new Error(`Codex worker PTY exited with code ${e.exitCode}.`),
          attemptId,
        )
        return
      }
      this.finalizeTerminalExit(record, e.exitCode, 'pty_exit')
    })
  }

  private isCurrentCodexGeneration(record: TerminalRecord, generation: number): boolean {
    return record.codex?.workerGeneration === generation
  }

  private isActiveCodexCandidate(record: TerminalRecord, generation: number, attemptId?: string): boolean {
    const active = record.codex?.activeReplacement
    return Boolean(
      active
      && !active.aborted
      && active.candidateGeneration === generation
      && attemptId !== undefined
      && active.id === attemptId,
    )
  }

  private isCodexRecoveryState(record: TerminalRecord): boolean {
    return record.codex?.recoveryState === 'recovering_durable'
      || record.codex?.recoveryState === 'recovering_pre_durable'
  }

  private isCodexRecoveryProtected(record: TerminalRecord): boolean {
    return this.isCodexRecoveryState(record) || record.codex?.recoveryState === 'recovery_failed'
  }

  private clearCodexInputExpiryTimer(record: TerminalRecord): void {
    const codex = record.codex
    if (!codex?.inputExpiryTimer) return
    clearTimeout(codex.inputExpiryTimer)
    codex.inputExpiryTimer = undefined
  }

  private scheduleCodexInputExpiryTimer(record: TerminalRecord): void {
    const codex = record.codex
    if (!codex || codex.inputExpiryTimer) return
    codex.inputExpiryTimer = setTimeout(() => {
      codex.inputExpiryTimer = undefined
      if (record.status !== 'running' || !this.isCodexRecoveryState(record)) {
        codex.recoveryPolicy.clearBufferedInput()
        return
      }
      const drain = codex.recoveryPolicy.drainBufferedInput()
      if (!drain.ok && drain.reason === 'expired') {
        this.appendLocalTerminalMessage(record, CODEX_RECOVERY_INPUT_NOT_SENT_MESSAGE)
      }
    }, CODEX_RECOVERY_INPUT_BUFFER_TTL_MS + 1)
    codex.inputExpiryTimer.unref?.()
  }

  private codexRecoveryLogContext(record: TerminalRecord, active?: CodexActiveReplacement): Record<string, unknown> {
    const codex = record.codex
    return {
      terminalId: record.terminalId,
      hasDurableSession: Boolean(codex?.durableSessionId),
      oldWsUrl: active?.retiringWsUrl ?? codex?.currentWsUrl,
      newWsUrl: active?.candidateWsUrl,
      oldPtyPid: active?.retiringPtyPid ?? record.pty?.pid,
      newPtyPid: active?.candidatePty?.pid,
      oldAppServerPid: active?.retiringAppServerPid ?? codex?.currentAppServerPid,
      newAppServerPid: active?.candidateAppServerPid,
    }
  }

  private resizePublishedCodexRecoveryCandidate(record: TerminalRecord, generation?: number): void {
    const active = record.codex?.activeReplacement
    if (!active || active.aborted || !active.candidatePublished) return
    if (generation !== undefined && active.candidateGeneration !== generation) return
    if (!this.isCurrentCodexGeneration(record, active.candidateGeneration)) return
    const candidatePty = active.candidatePty ?? record.pty
    try {
      candidatePty.resize(record.cols, record.rows)
    } catch (err) {
      logger.debug({ err, terminalId: record.terminalId }, 'codex recovery resize failed')
    }
  }

  private getRuntimeStatus(record: TerminalRecord): TerminalRuntimeStatus | undefined {
    if (record.status === 'exited') return undefined
    if (record.mode !== 'codex') return 'running'
    const state = record.codex?.recoveryState
    if (state === 'recovering_durable' || state === 'recovering_pre_durable') return 'recovering'
    if (state === 'recovery_failed') return 'recovery_failed'
    return 'running'
  }

  private async handleCodexWorkerFailure(
    record: TerminalRecord,
    generation: number,
    source: CodexWorkerFailureSource,
    error: Error,
    attemptId?: string,
  ): Promise<void> {
    const codex = record.codex
    if (!codex || record.status === 'exited') {
      return
    }
    const isCurrent = this.isCurrentCodexGeneration(record, generation)
    const isActiveCandidate = this.isActiveCodexCandidate(record, generation, attemptId)
    if (!isCurrent && !isActiveCandidate) {
      logger.info({
        terminalId: record.terminalId,
        source,
        generation,
        currentGeneration: codex.workerGeneration,
      }, 'codex_recovery_abandoned_stale_generation')
      return
    }
    if (codex.retiringGenerations.has(generation) && !isActiveCandidate) {
      codex.recoveryPolicy.noteRecoveryRetireCallback()
      return
    }
    if (codex.closeReasonByGeneration.get(generation) === 'user_final_close') {
      this.finalizeTerminalExit(record, record.exitCode ?? 0, 'user_final_close')
      return
    }

    logger.warn({
      err: error,
      terminalId: record.terminalId,
      source,
      generation,
      recoveryState: codex.recoveryState,
      hasDurableSession: Boolean(codex.durableSessionId),
    }, 'codex_worker_failure')

    if (isActiveCandidate) {
      await this.failActiveCodexReplacementAttempt(record, attemptId!, source, error)
      return
    }

    await this.startCodexBundleReplacement(record, source, error)
  }

  private attachCodexSidecar(
    record: TerminalRecord,
    sidecar: Pick<CodexTerminalSidecar, 'attachTerminal' | 'shutdown'>,
    generation: number,
    attemptId?: string,
  ): void {
    sidecar.attachTerminal({
      terminalId: record.terminalId,
      onDurableSession: (sessionId) => {
        this.noteCodexDurableSession(record, sessionId, generation, attemptId)
      },
      onThreadLifecycle: (event) => {
        this.handleCodexThreadLifecycle(record, generation, attemptId, event)
      },
      onFatal: (error, source = 'sidecar_fatal') => {
        void this.handleCodexWorkerFailure(record, generation, source, error, attemptId)
      },
    })
  }

  private handleCodexThreadLifecycle(
    record: TerminalRecord,
    generation: number,
    attemptId: string | undefined,
    event: CodexThreadLifecycleEvent,
  ): void {
    const codex = record.codex
    if (!codex || record.status === 'exited') return
    const isCurrent = this.isCurrentCodexGeneration(record, generation)
    const isActiveCandidate = this.isActiveCodexCandidate(record, generation, attemptId)
    if (!isCurrent && !isActiveCandidate) return

    const active = codex.activeReplacement
    const expectedSessionId = codex.durableSessionId
      ?? (isActiveCandidate ? active?.pendingDurableSessionId : undefined)
    if (
      expectedSessionId
      && event.kind === 'thread_closed'
      && event.threadId === expectedSessionId
    ) {
      void this.handleCodexWorkerFailure(
        record,
        generation,
        'provider_thread_lifecycle_loss',
        new Error('Codex provider reported the active thread closed.'),
        attemptId,
      )
      return
    }

    if (
      expectedSessionId
      && event.kind === 'thread_status_changed'
      && event.threadId === expectedSessionId
      && (event.status.type === 'notLoaded' || event.status.type === 'systemError')
    ) {
      void this.handleCodexWorkerFailure(
        record,
        generation,
        'provider_thread_lifecycle_loss',
        new Error(`Codex provider reported the active thread status ${event.status.type}.`),
        attemptId,
      )
      return
    }

    if (
      event.kind === 'thread_started'
      && (expectedSessionId ? event.thread.id === expectedSessionId : isActiveCandidate)
      && this.isCodexRecoveryState(record)
    ) {
      this.noteCodexReadinessEvidence(record, generation, attemptId, event.thread.id)
      return
    }

    if (
      expectedSessionId
      && event.kind === 'thread_status_changed'
      && event.threadId === expectedSessionId
      && event.status.type === 'idle'
      && this.isCodexRecoveryState(record)
    ) {
      this.noteCodexReadinessEvidence(record, generation, attemptId, event.threadId)
    }
  }

  private promoteCodexDurableSession(record: TerminalRecord, sessionId: string, generation: number): void {
    const codex = record.codex
    if (!codex || !this.isCurrentCodexGeneration(record, generation)) {
      return
    }
    if (codex.retiringGenerations.has(generation)) {
      return
    }
    if (codex.durableSessionId && codex.durableSessionId !== sessionId) {
      logger.warn({
        terminalId: record.terminalId,
        existingSessionId: codex.durableSessionId,
        nextSessionId: sessionId,
        generation,
      }, 'Ignoring conflicting Codex durable session promotion')
      return
    }

    codex.durableSessionId = sessionId
    if (codex.recoveryState === 'running_live_only') {
      codex.recoveryState = 'running_durable'
    } else if (codex.recoveryState === 'recovering_pre_durable') {
      const active = codex.activeReplacement
      if (
        active
        && active.candidateGeneration === generation
        && active.candidatePublished
        && !active.aborted
      ) {
        if (active.preDurableTimer) {
          clearTimeout(active.preDurableTimer)
          active.preDurableTimer = undefined
        }
        codex.recoveryState = 'recovering_durable'
        if (!active.readinessTimer) {
          active.readinessTimer = setTimeout(() => {
            void this.failActiveCodexReplacementAttempt(
              record,
              active.id,
              'readiness_timeout',
              new Error('Timed out waiting for Codex durable session readiness evidence.'),
            )
          }, CODEX_RECOVERY_READINESS_TIMEOUT_MS)
          active.readinessTimer.unref?.()
        }
        if (active.pendingReadinessSessionId === sessionId) {
          this.markCodexRecoveryReady(record, generation, active.id)
        }
      }
    }
    const rebound = this.rebindSession(record.terminalId, 'codex', sessionId, 'association')
    if (!rebound.ok) {
      logger.warn(
        { terminalId: record.terminalId, sessionId, reason: rebound.reason },
        'Failed to promote Codex durable session from sidecar notification',
      )
    }
  }

  private noteCodexDurableSession(
    record: TerminalRecord,
    sessionId: string,
    generation: number,
    attemptId?: string,
  ): void {
    const codex = record.codex
    if (!codex || record.status === 'exited') return

    const active = codex.activeReplacement
    if (
      active
      && active.id === attemptId
      && active.candidateGeneration === generation
      && !active.candidatePublished
    ) {
      if (codex.durableSessionId && codex.durableSessionId !== sessionId) {
        logger.warn({
          terminalId: record.terminalId,
          existingSessionId: codex.durableSessionId,
          candidateSessionId: sessionId,
          generation,
        }, 'Ignoring conflicting unpublished Codex durable session promotion')
        return
      }
      active.pendingDurableSessionId = sessionId
      return
    }

    this.promoteCodexDurableSession(record, sessionId, generation)
  }

  private emitTerminalStatus(
    record: TerminalRecord,
    status: TerminalRuntimeStatus,
    reason?: string,
    attempt?: number,
  ): void {
    const event = {
      terminalId: record.terminalId,
      status,
      ...(reason ? { reason } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
    }
    this.emit('terminal.status', event)
  }

  private async startCodexBundleReplacement(
    record: TerminalRecord,
    source: CodexWorkerFailureSource,
    error: Error,
  ): Promise<void> {
    const codex = record.codex
    if (!codex || record.status === 'exited') return
    const existing = codex.activeReplacement
    if (existing && !existing.aborted) {
      logger.warn({
        terminalId: record.terminalId,
        source,
        generation: codex.workerGeneration,
        attempt: existing.attempt,
        err: error,
      }, 'codex_recovery_attempt_coalesced')
      return
    }

    const retiringGeneration = codex.workerGeneration
    const attempt = codex.recoveryPolicy.nextAttempt()
    if (!attempt.ok) {
      await this.retireCodexWorkerBundle(record, retiringGeneration)
      this.enterCodexRecoveryFailed(record, source, error)
      return
    }

    const recoveryState: CodexRecoveryState = codex.durableSessionId ? 'recovering_durable' : 'recovering_pre_durable'
    codex.recoveryState = recoveryState
    const candidateGeneration = codex.nextWorkerGeneration
    codex.nextWorkerGeneration += 1
    const active: CodexActiveReplacement = {
      id: nanoid(),
      attempt: attempt.attempt,
      source,
      retiringGeneration,
      candidateGeneration,
      candidatePublished: false,
      aborted: false,
      retiringWsUrl: codex.currentWsUrl,
      retiringAppServerPid: codex.currentAppServerPid,
      retiringPtyPid: record.pty.pid,
    }
    codex.activeReplacement = active

    logger.warn({
      ...this.codexRecoveryLogContext(record, active),
      terminalId: record.terminalId,
      source,
      state: recoveryState,
      generation: retiringGeneration,
      candidateGeneration,
      attempt: attempt.attempt,
      err: error,
    }, 'codex_recovery_started')
    this.emitTerminalStatus(record, 'recovering', source, attempt.attempt)
    await this.retireCodexWorkerBundle(record, retiringGeneration)

    const launch = () => {
      void this.runCodexReplacementAttempt(record, active.id).catch((err) => {
        void this.failActiveCodexReplacementAttempt(
          record,
          active.id,
          'replacement_launch_failure',
          err instanceof Error ? err : new Error(String(err)),
        )
      })
    }

    if (attempt.delayMs > 0) {
      active.backoffTimer = setTimeout(launch, attempt.delayMs)
      active.backoffTimer.unref?.()
      return
    }
    launch()
  }

  private async runCodexReplacementAttempt(record: TerminalRecord, attemptId: string): Promise<void> {
    const codex = record.codex
    const active = codex?.activeReplacement
    if (!codex || !active || active.id !== attemptId || active.aborted || record.status === 'exited') return
    const launchFactory = codex.launchFactory
    if (!launchFactory) {
      await this.failActiveCodexReplacementAttempt(
        record,
        attemptId,
        'replacement_launch_failure',
        new Error('Codex recovery cannot continue because no launch factory is stored for this terminal.'),
      )
      return
    }

    const resumeSessionId = codex.durableSessionId ?? codex.originalResumeSessionId
    logger.warn({
      ...this.codexRecoveryLogContext(record, active),
      terminalId: record.terminalId,
      attempt: active.attempt,
      generation: active.retiringGeneration,
      candidateGeneration: active.candidateGeneration,
    }, 'codex_recovery_attempt')

    let plan: CodexLaunchPlan | undefined
    let worker: SpawnedTerminalWorker | undefined
    let spawnStarted = false
    try {
      plan = await launchFactory({
        terminalId: record.terminalId,
        cwd: record.cwd,
        envContext: codex.envContext,
        resumeSessionId,
        providerSettings: codex.launchBaseProviderSettings,
      })

      if (!this.isActiveAttempt(record, attemptId)) {
        await plan.sidecar.shutdown().catch(() => undefined)
        return
      }

      active.candidateSidecar = plan.sidecar
      active.candidateWsUrl = plan.remote.wsUrl
      active.candidateAppServerPid = plan.remote.processPid
      this.attachCodexSidecar(record, plan.sidecar, active.candidateGeneration, attemptId)

      if (codex.durableSessionId) {
        active.readinessTimer = setTimeout(() => {
          void this.failActiveCodexReplacementAttempt(
            record,
            attemptId,
            'readiness_timeout',
            new Error('Timed out waiting for Codex durable session readiness evidence.'),
          )
        }, CODEX_RECOVERY_READINESS_TIMEOUT_MS)
        active.readinessTimer.unref?.()
      }

      spawnStarted = true
      worker = this.spawnTerminalWorker({
        terminalId: record.terminalId,
        mode: record.mode,
        shell: 'system',
        cwd: record.cwd,
        cols: record.cols,
        rows: record.rows,
        resumeSessionId: plan.sessionId ?? resumeSessionId,
        providerSettings: {
          ...codex.launchBaseProviderSettings,
          codexAppServer: { wsUrl: plan.remote.wsUrl },
        },
        envContext: codex.envContext,
        baseEnv: buildFreshellTerminalEnv(record.terminalId, codex.envContext),
      })

      if (!this.isActiveAttempt(record, attemptId)) {
        try { worker.pty.kill() } catch {}
        await plan.sidecar.shutdown().catch(() => undefined)
        cleanupMcpConfig(record.terminalId, record.mode, worker.mcpCwd)
        return
      }

      active.candidatePty = worker.pty
      active.candidateMcpCwd = worker.mcpCwd
      record.pty = worker.pty
      record.mcpCwd = worker.mcpCwd
      record.codexSidecar = plan.sidecar
      codex.currentWsUrl = plan.remote.wsUrl
      codex.currentAppServerPid = plan.remote.processPid
      if (record.clients.size === 0) {
        record.preAttachStartupProbeState = createTerminalStartupProbeState()
      }
      this.installTerminalWorkerHandlers(record, active.candidateGeneration, attemptId)
      codex.workerGeneration = active.candidateGeneration
      codex.remoteTuiFailureDetector.reset()
      active.candidatePublished = true
      codex.closeReasonByGeneration.delete(active.candidateGeneration)

      if (active.pendingDurableSessionId) {
        this.promoteCodexDurableSession(record, active.pendingDurableSessionId, active.candidateGeneration)
      }
      if (codex.durableSessionId) {
        if (active.pendingReadinessSessionId === codex.durableSessionId) {
          this.markCodexRecoveryReady(record, active.candidateGeneration, attemptId)
        }
      } else {
        this.startCodexPreDurableStabilityTimer(record, active.candidateGeneration, attemptId)
      }
    } catch (err) {
      if (worker) {
        try { worker.pty.kill() } catch {}
        cleanupMcpConfig(record.terminalId, record.mode, worker.mcpCwd)
      }
      if (plan) {
        await plan.sidecar.shutdown().catch(() => undefined)
      }
      await this.failActiveCodexReplacementAttempt(
        record,
        attemptId,
        spawnStarted ? 'replacement_spawn_failure' : 'replacement_launch_failure',
        err instanceof Error ? err : new Error(String(err)),
      )
    }
  }

  private isActiveAttempt(record: TerminalRecord, attemptId: string): boolean {
    const active = record.codex?.activeReplacement
    return Boolean(active && active.id === attemptId && !active.aborted && record.status === 'running')
  }

  private async retireCodexWorkerBundle(record: TerminalRecord, generation: number): Promise<void> {
    const codex = record.codex
    if (!codex || codex.retiringGenerations.has(generation)) return
    codex.retiringGenerations.add(generation)
    codex.closeReasonByGeneration.set(generation, 'recovery_retire')
    const sidecar = record.codexSidecar
    record.codexSidecar = undefined
    if (sidecar) {
      await sidecar.shutdown().catch((err) => {
        logger.warn({ err, terminalId: record.terminalId, generation }, 'Failed to shut down retiring Codex sidecar')
      })
    }
    try {
      record.pty.kill()
    } catch (err) {
      logger.warn({ err, terminalId: record.terminalId, generation }, 'Failed to kill retiring Codex PTY')
    }
    cleanupMcpConfig(record.terminalId, record.mode, record.mcpCwd)
    logger.warn({ terminalId: record.terminalId, generation }, 'codex_recovery_bundle_retired')
  }

  private async failActiveCodexReplacementAttempt(
    record: TerminalRecord,
    attemptId: string,
    source: CodexWorkerFailureSource,
    error: Error,
  ): Promise<void> {
    const codex = record.codex
    const active = codex?.activeReplacement
    if (!codex || !active || active.id !== attemptId || active.aborted) return
    active.aborted = true
    if (active.readinessTimer) clearTimeout(active.readinessTimer)
    if (active.preDurableTimer) clearTimeout(active.preDurableTimer)
    if (active.backoffTimer) clearTimeout(active.backoffTimer)
    codex.retiringGenerations.add(active.candidateGeneration)
    codex.closeReasonByGeneration.set(active.candidateGeneration, 'recovery_retire')
    const candidateSidecar = active.candidatePublished ? record.codexSidecar : active.candidateSidecar
    if (candidateSidecar) {
      await candidateSidecar.shutdown().catch(() => undefined)
    }
    const candidatePty = active.candidatePublished ? record.pty : active.candidatePty
    if (candidatePty) {
      try { candidatePty.kill() } catch {}
    }
    if (active.candidateMcpCwd) {
      cleanupMcpConfig(record.terminalId, record.mode, active.candidateMcpCwd)
    }
    codex.activeReplacement = undefined
    logger.warn({
      ...this.codexRecoveryLogContext(record, active),
      err: error,
      terminalId: record.terminalId,
      source,
      attempt: active.attempt,
      generation: active.candidateGeneration,
    }, 'codex_recovery_attempt_failed')
    await this.startCodexBundleReplacement(record, source, error)
  }

  private noteCodexReadinessEvidence(
    record: TerminalRecord,
    generation: number,
    attemptId: string | undefined,
    sessionId: string,
  ): void {
    const codex = record.codex
    if (!codex) return
    const active = codex.activeReplacement
    if (
      active
      && active.id === attemptId
      && active.candidateGeneration === generation
      && !active.candidatePublished
    ) {
      if (
        (codex.durableSessionId || active.pendingDurableSessionId)
        && codex.durableSessionId !== sessionId
        && active.pendingDurableSessionId !== sessionId
      ) {
        return
      }
      active.pendingReadinessSessionId = sessionId
      return
    }
    if (
      active
      && active.id === attemptId
      && active.candidateGeneration === generation
      && active.candidatePublished
      && !codex.durableSessionId
    ) {
      active.pendingReadinessSessionId = sessionId
      return
    }
    if (codex.durableSessionId !== sessionId) return
    if (this.isCurrentCodexGeneration(record, generation)) {
      this.markCodexRecoveryReady(record, generation, attemptId)
    }
  }

  private markCodexRecoveryReady(record: TerminalRecord, generation: number, attemptId: string | undefined): void {
    const codex = record.codex
    const active = codex?.activeReplacement
    if (!codex || !active || active.id !== attemptId || !active.candidatePublished) return
    if (!this.isCurrentCodexGeneration(record, generation)) return
    if (active.readinessTimer) clearTimeout(active.readinessTimer)
    if (active.preDurableTimer) clearTimeout(active.preDurableTimer)
    this.resizePublishedCodexRecoveryCandidate(record, generation)
    codex.activeReplacement = undefined
    codex.recoveryState = 'running_durable'
    codex.recoveryPolicy.markStableRunning()
    this.emitTerminalStatus(record, 'running', 'codex_recovery_ready', active.attempt)
    this.flushCodexBufferedInput(record)
    logger.warn({
      ...this.codexRecoveryLogContext(record, active),
      terminalId: record.terminalId,
      generation,
      attempt: active.attempt,
    }, 'codex_recovery_ready')
  }

  private startCodexPreDurableStabilityTimer(
    record: TerminalRecord,
    generation: number,
    attemptId: string,
  ): void {
    const active = record.codex?.activeReplacement
    if (!active || active.id !== attemptId || active.candidateGeneration !== generation) return
    active.preDurableTimer = setTimeout(() => {
      const codex = record.codex
      if (!codex || codex.activeReplacement?.id !== attemptId || record.status !== 'running') return
      if (!this.isCurrentCodexGeneration(record, generation)) return
      if (codex.durableSessionId) return
      this.resizePublishedCodexRecoveryCandidate(record, generation)
      codex.activeReplacement = undefined
      codex.recoveryState = 'running_live_only'
      codex.recoveryPolicy.markStableRunning()
      this.emitTerminalStatus(record, 'running', 'codex_recovery_ready', active.attempt)
      this.flushCodexBufferedInput(record)
    }, CODEX_PRE_DURABLE_STABILITY_MS)
    active.preDurableTimer.unref?.()
  }

  private enterCodexRecoveryFailed(
    record: TerminalRecord,
    source: CodexWorkerFailureSource,
    error: Error,
  ): void {
    const codex = record.codex
    if (!codex || record.status === 'exited') return
    if (codex.activeReplacement?.readinessTimer) clearTimeout(codex.activeReplacement.readinessTimer)
    if (codex.activeReplacement?.preDurableTimer) clearTimeout(codex.activeReplacement.preDurableTimer)
    if (codex.activeReplacement?.backoffTimer) clearTimeout(codex.activeReplacement.backoffTimer)
    this.clearCodexInputExpiryTimer(record)
    codex.recoveryPolicy.clearBufferedInput()
    codex.activeReplacement = undefined
    codex.recoveryState = 'recovery_failed'
    this.emitTerminalStatus(record, 'recovery_failed', source)
    logger.warn({
      ...this.codexRecoveryLogContext(record),
      err: error,
      terminalId: record.terminalId,
      source,
    }, 'codex_recovery_failed')
  }

  private flushCodexBufferedInput(record: TerminalRecord): void {
    this.clearCodexInputExpiryTimer(record)
    const drain = record.codex?.recoveryPolicy.drainBufferedInput()
    if (!drain) return
    if (!drain.ok) {
      if (drain.reason === 'expired') {
        this.appendLocalTerminalMessage(record, CODEX_RECOVERY_INPUT_NOT_SENT_MESSAGE)
      }
      return
    }
    record.pty.write(drain.data)
    this.emit('terminal.input.raw', {
      terminalId: record.terminalId,
      data: drain.data,
      at: Date.now(),
    } satisfies TerminalInputRawEvent)
  }

  private appendLocalTerminalMessage(record: TerminalRecord, message: string): void {
    const terminalId = record.terminalId
    const now = Date.now()
    record.lastActivityAt = now
    record.buffer.append(message)
    this.emit('terminal.output.raw', {
      terminalId,
      data: message,
      at: now,
    } satisfies TerminalOutputRawEvent)
    this.deliverTerminalOutputToClients(record, terminalId, message)
  }

  private deliverTerminalOutputToClients(record: TerminalRecord, terminalId: string, data: string): void {
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
      this.sendTerminalOutput(client, terminalId, data, record.perf)
    }
  }

  private handleTerminalWorkerData(record: TerminalRecord, _generation: number, data: string): void {
    const terminalId = record.terminalId
    this.handlePreAttachStartupProbes(record, data)
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
    this.deliverTerminalOutputToClients(record, terminalId, data)
  }

  private finalizeTerminalExit(
    record: TerminalRecord,
    exitCode: number | undefined,
    _reason: 'pty_exit' | 'user_final_close',
  ): void {
    if (record.status === 'exited') {
      return
    }
    const terminalId = record.terminalId
    const finalExitCode = exitCode ?? 0
    record.status = 'exited'
    record.exitCode = finalExitCode
    const now = Date.now()
    record.lastActivityAt = now
    record.exitedAt = now
    cleanupMcpConfig(terminalId, record.mode, record.mcpCwd)
    this.shutdownCodexSidecar(record)
    for (const client of record.clients) {
      this.flushOutputBuffer(client)
      this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: finalExitCode }, { terminalId, perf: record.perf })
    }
    record.clients.clear()
    record.suppressedOutputClients.clear()
    record.pendingSnapshotClients.clear()
    this.releaseBinding(terminalId, 'exit')
    this.emit('terminal.exit', { terminalId, exitCode: finalExitCode })
    this.reapExitedTerminals()
  }

  create(opts: {
    terminalId?: string
    mode: TerminalMode
    shell?: ShellType
    cwd?: string
    cols?: number
    rows?: number
    resumeSessionId?: string
    sessionBindingReason?: SessionBindingReason
    providerSettings?: ProviderSettings
    codexLaunchBaseProviderSettings?: {
      model?: string
      sandbox?: string
      permissionMode?: string
    }
    codexSidecar?: Pick<CodexTerminalSidecar, 'attachTerminal' | 'shutdown'>
    codexLaunchFactory?: CodexLaunchFactory
    envContext?: TerminalEnvContext
  }): TerminalRecord {
    this.reapExitedTerminals()
    if (this.runningCount() >= this.maxTerminals) {
      throw new Error(`Maximum terminal limit (${this.maxTerminals}) reached. Please close some terminals before creating new ones.`)
    }

    const terminalId = opts.terminalId ?? nanoid()
    const createdAt = Date.now()
    const cols = opts.cols || 120
    const rows = opts.rows || 30

    const cwd = opts.cwd || getDefaultCwd(this.settings) || (isWindows() ? undefined : os.homedir())
    const resumeForSpawn = normalizeResumeForSpawn(opts.mode, opts.resumeSessionId)
    const resumeForBinding = normalizeResumeForBinding(opts.mode, opts.resumeSessionId)
    const baseEnv = buildFreshellTerminalEnv(terminalId, opts.envContext)
    const worker = this.spawnTerminalWorker({
      terminalId,
      mode: opts.mode,
      shell: opts.shell || 'system',
      cwd,
      cols,
      rows,
      resumeSessionId: resumeForSpawn,
      providerSettings: opts.providerSettings,
      envContext: opts.envContext,
      baseEnv,
    })

    const title = getModeLabel(opts.mode)

    const record: TerminalRecord = {
      terminalId,
      title,
      description: undefined,
      mode: opts.mode,
      codexSidecar: opts.mode === 'codex' ? opts.codexSidecar : undefined,
      opencodeServer: opts.mode === 'opencode' ? opts.providerSettings?.opencodeServer : undefined,
      resumeSessionId: undefined,
      createdAt,
      lastActivityAt: createdAt,
      status: 'running',
      cwd,
      mcpCwd: worker.mcpCwd,
      cols,
      rows,
      clients: new Set(),
      suppressedOutputClients: new Set(),
      pendingSnapshotClients: new Map(),
      preAttachStartupProbeState: opts.mode === 'codex' ? createTerminalStartupProbeState() : undefined,

      buffer: new ChunkRingBuffer(this.scrollbackMaxChars),
      pty: worker.pty,
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
      codex: opts.mode === 'codex'
        ? {
            recoveryState: resumeForBinding ? 'running_durable' : 'running_live_only',
            workerGeneration: 1,
            nextWorkerGeneration: 2,
            retiringGenerations: new Set(),
            closeReasonByGeneration: new Map(),
            durableSessionId: resumeForBinding,
            originalResumeSessionId: resumeForBinding,
            currentWsUrl: opts.providerSettings?.codexAppServer?.wsUrl,
            launchFactory: opts.codexLaunchFactory,
            launchBaseProviderSettings: opts.codexLaunchBaseProviderSettings
              ? {
                  model: opts.codexLaunchBaseProviderSettings.model,
                  sandbox: opts.codexLaunchBaseProviderSettings.sandbox,
                  permissionMode: opts.codexLaunchBaseProviderSettings.permissionMode,
                }
              : {
                  model: opts.providerSettings?.model,
                  sandbox: opts.providerSettings?.sandbox,
                  permissionMode: opts.providerSettings?.permissionMode,
                },
            envContext: opts.envContext,
            recoveryPolicy: new CodexRecoveryPolicy(),
            remoteTuiFailureDetector: new CodexRemoteTuiFailureDetector(),
          }
        : undefined,
    }

    this.installTerminalWorkerHandlers(record, 1)

    this.terminals.set(terminalId, record)
    if (opts.mode === 'codex' && opts.codexSidecar) {
      const generation = record.codex?.workerGeneration ?? 1
      this.attachCodexSidecar(record, opts.codexSidecar, generation)
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
    this.emit('terminal.created', record)
    return record
  }

  attach(terminalId: string, client: WebSocket, opts?: { pendingSnapshot?: boolean; suppressOutput?: boolean }): TerminalRecord | null {
    const term = this.terminals.get(terminalId)
    if (!term) return null
    term.preAttachStartupProbeState = undefined
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

  input(terminalId: string, data: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term || term.status !== 'running') return false
    const now = Date.now()
    term.lastActivityAt = now
    if (term.mode === 'codex' && this.isCodexRecoveryState(term)) {
      const buffered = term.codex?.recoveryPolicy.bufferInput(data)
      if (!buffered?.ok) {
        this.clearCodexInputExpiryTimer(term)
        this.appendLocalTerminalMessage(term, CODEX_RECOVERY_INPUT_NOT_SENT_MESSAGE)
      } else {
        this.scheduleCodexInputExpiryTimer(term)
      }
      return true
    }
    if (term.mode === 'codex' && term.codex?.recoveryState === 'recovery_failed') {
      this.appendLocalTerminalMessage(term, CODEX_RECOVERY_FAILED_INPUT_MESSAGE)
      return true
    }
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
    term.pty.write(data)
    this.emit('terminal.input.raw', {
      terminalId,
      data,
      at: now,
    } satisfies TerminalInputRawEvent)
    return true
  }

  private handlePreAttachStartupProbes(term: TerminalRecord, data: string): void {
    if (term.mode !== 'codex') return
    if (term.clients.size > 0) return
    const state = term.preAttachStartupProbeState
    if (!state) return

    const { replies } = extractTerminalStartupProbes(data, state, PREATTACH_CODEX_STARTUP_PROBE_COLORS)
    if (!state.armed && !state.pending) {
      term.preAttachStartupProbeState = undefined
    }
    if (replies.length === 0) {
      return
    }

    for (const reply of replies) {
      try {
        term.pty.write(reply)
      } catch (err) {
        logger.debug({ err, terminalId: term.terminalId }, 'pre-attach codex startup probe reply failed')
        break
      }
    }
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const term = this.terminals.get(terminalId)
    if (!term || term.status !== 'running') return false
    if (term.cols === cols && term.rows === rows) return true
    term.cols = cols
    term.rows = rows
    if (term.mode === 'codex' && this.isCodexRecoveryProtected(term)) {
      this.resizePublishedCodexRecoveryCandidate(term)
      return true
    }
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
    if (term.status === 'exited') return true
    this.markCodexFinalClose(term)
    try {
      term.pty.kill()
    } catch (err) {
      logger.warn({ err, terminalId }, 'kill failed')
    }
    this.finalizeTerminalExit(term, term.exitCode ?? 0, 'user_final_close')
    return true
  }

  private markCodexWorkerCloseReason(record: TerminalRecord, reason: CodexWorkerCloseReason): void {
    const codex = record.codex
    if (!codex) return
    codex.closeReasonByGeneration.set(codex.workerGeneration, reason)
  }

  private markCodexFinalClose(record: TerminalRecord): void {
    const codex = record.codex
    if (!codex) return
    this.markCodexWorkerCloseReason(record, 'user_final_close')
    this.clearCodexInputExpiryTimer(record)
    const active = codex.activeReplacement
    if (active) {
      active.aborted = true
      if (active.readinessTimer) clearTimeout(active.readinessTimer)
      if (active.preDurableTimer) clearTimeout(active.preDurableTimer)
      if (active.backoffTimer) clearTimeout(active.backoffTimer)
      codex.closeReasonByGeneration.set(active.candidateGeneration, 'user_final_close')
      if (active.candidateSidecar && !active.candidatePublished) {
        void active.candidateSidecar.shutdown().catch(() => undefined)
      }
      if (active.candidatePty && !active.candidatePublished) {
        try { active.candidatePty.kill() } catch {}
      }
      codex.activeReplacement = undefined
    }
    codex.recoveryPolicy.clearBufferedInput()
  }

  remove(terminalId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    this.kill(terminalId)
    this.terminals.delete(terminalId)
    return true
  }

  private shutdownCodexSidecar(term: TerminalRecord): void {
    const sidecar = term.codexSidecar
    if (!sidecar) {
      return
    }
    term.codexSidecar = undefined
    void sidecar.shutdown().catch((error) => {
      logger.warn({ err: error, terminalId: term.terminalId }, 'Failed to shut down Codex sidecar')
    })
  }

  list(): Array<{
    terminalId: string
    title: string
    description?: string
    mode: TerminalMode
    resumeSessionId?: string
    createdAt: number
    lastActivityAt: number
    status: 'running' | 'exited'
    runtimeStatus?: TerminalRuntimeStatus
    hasClients: boolean
    cwd?: string
  }> {
    return Array.from(this.terminals.values()).map((t) => ({
      terminalId: t.terminalId,
      title: t.title,
      description: t.description,
      mode: t.mode,
      resumeSessionId: t.resumeSessionId,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      status: t.status,
      runtimeStatus: this.getRuntimeStatus(t),
      hasClients: t.clients.size > 0,
      cwd: t.cwd,
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
      this.markCodexFinalClose(term)
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

    logger.info({ count: running.length, forceKilled }, 'All terminals shut down')
  }
}
