import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import type { LiveWebSocket } from './ws-handler.js'
import * as pty from 'node-pty'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog, startPerfTimer } from './perf-logger.js'
import type { ServerSettings } from '../shared/settings.js'
import { convertWindowsPathToWslPath, isReachableDirectorySync } from './path-utils.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
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
import { getOpencodeEnvOverrides, resolveOpencodeLaunchModel } from './opencode-launch.js'

const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
const DEFAULT_MAX_SCROLLBACK_CHARS = Number(process.env.MAX_SCROLLBACK_CHARS || 64 * 1024)
const MIN_SCROLLBACK_CHARS = 64 * 1024
const MAX_SCROLLBACK_CHARS = 2 * 1024 * 1024
const APPROX_CHARS_PER_LINE = 200
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS || 50)
const DEFAULT_MAX_PENDING_SNAPSHOT_CHARS = 512 * 1024
const OUTPUT_FLUSH_MS = Number(process.env.OUTPUT_FLUSH_MS || process.env.MOBILE_OUTPUT_FLUSH_MS || 40)
const MAX_OUTPUT_BUFFER_CHARS = Number(process.env.MAX_OUTPUT_BUFFER_CHARS || process.env.MAX_MOBILE_OUTPUT_BUFFER_CHARS || 256 * 1024)
const MAX_OUTPUT_FRAME_CHARS = Math.max(1, Number(process.env.MAX_OUTPUT_FRAME_CHARS || 8192))
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
  launchArgs?: (sessionId: string) => string[]
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
    launchArgs: (sessionId: string) => ['--session-id', sessionId],
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

function modeSupportsExactLaunch(mode: TerminalMode): boolean {
  if (mode !== 'claude') return false
  return !!codingCliCommands.get(mode)?.launchArgs
}

type ProviderTarget = 'unix' | 'windows'

const DEFAULT_FRESHELL_ORCHESTRATION_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'freshell-orchestration')
const LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'freshell-automation-tmux-style')
const DEFAULT_FRESHELL_DEMO_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'freshell-demo-creation')
const LEGACY_FRESHELL_DEMO_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'demo-creating')
const DEFAULT_FRESHELL_CLAUDE_PLUGIN_DIR = path.join(process.cwd(), '.claude', 'plugins', 'freshell-orchestration')
const LEGACY_FRESHELL_CLAUDE_PLUGIN_DIR = path.join(process.cwd(), '.claude', 'plugins', 'freshell-automation-tmux-style')
const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex')

function firstExistingPath(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Ignore filesystem errors and fall through to the next candidate.
    }
  }
  return undefined
}

function encodeTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function firstExistingPaths(candidates: Array<string | undefined>): string[] {
  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || unique.has(candidate)) continue
    try {
      if (fs.existsSync(candidate)) unique.add(candidate)
    } catch {
      // Ignore filesystem errors and continue collecting matches.
    }
  }
  return Array.from(unique)
}

function codexSkillsDir(): string {
  const codexHome = process.env.CODEX_HOME || DEFAULT_CODEX_HOME
  return path.join(codexHome, 'skills')
}

function codexOrchestrationSkillArgs(): string[] {
  const skillsDir = codexSkillsDir()
  const skillPath = firstExistingPath([
    process.env.FRESHELL_ORCHESTRATION_SKILL_DIR,
    DEFAULT_FRESHELL_ORCHESTRATION_SKILL_DIR,
    LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR,
    path.join(skillsDir, 'freshell-orchestration'),
    path.join(skillsDir, 'freshell-automation-tmux-style'),
  ])
  if (!skillPath) return []
  const disablePaths = firstExistingPaths([
    process.env.FRESHELL_DEMO_SKILL_DIR,
    DEFAULT_FRESHELL_DEMO_SKILL_DIR,
    LEGACY_FRESHELL_DEMO_SKILL_DIR,
    path.join(skillsDir, 'demo-creating'),
    path.join(skillsDir, 'freshell-demo-creation'),
    LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR,
    path.join(skillsDir, 'freshell-automation-tmux-style'),
  ]).filter((entryPath) => entryPath !== skillPath)

  const entries: Array<{ path: string; enabled: boolean }> = [
    { path: skillPath, enabled: true },
    ...disablePaths.map((entryPath) => ({ path: entryPath, enabled: false })),
  ]
  const tomlEntries = entries.map(
    (entry) => `{path = ${encodeTomlString(entry.path)}, enabled = ${entry.enabled}}`
  )
  return ['-c', `skills.config=[${tomlEntries.join(', ')}]`]
}

function claudePluginArgs(): string[] {
  const pluginDir = firstExistingPath([
    process.env.FRESHELL_CLAUDE_PLUGIN_DIR,
    DEFAULT_FRESHELL_CLAUDE_PLUGIN_DIR,
    LEGACY_FRESHELL_CLAUDE_PLUGIN_DIR,
  ])
  if (!pluginDir) return []
  return ['--plugin-dir', pluginDir]
}

function providerNotificationArgs(mode: TerminalMode, target: ProviderTarget): string[] {
  if (mode === 'codex') {
    return [
      '-c', 'tui.notification_method=bel',
      '-c', "tui.notifications=['agent-turn-complete']",
      ...codexOrchestrationSkillArgs(),
    ]
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
    return [...claudePluginArgs(), '--settings', JSON.stringify(settings)]
  }

  return []
}

type ProviderSettings = {
  permissionMode?: string
  model?: string
  sandbox?: string
}

function resolveCodingCliCommand(
  mode: TerminalMode,
  resumeSessionId?: string,
  launchSessionId?: string,
  target: ProviderTarget = 'unix',
  providerSettings?: ProviderSettings,
) {
  if (mode === 'shell') return null
  const spec = codingCliCommands.get(mode)
  if (!spec) return null
  const command = (spec.envVar && process.env[spec.envVar]) || spec.defaultCommand
  const providerArgs = providerNotificationArgs(mode, target)
  const baseArgs = spec.args || []
  const commandEnv: Record<string, string> = { ...(spec.env || {}) }
  if (mode === 'opencode') {
    Object.assign(commandEnv, getOpencodeEnvOverrides({ ...process.env, ...commandEnv }))
  }
  let sessionArgs: string[] = []
  if (resumeSessionId) {
    if (spec.resumeArgs) {
      sessionArgs = spec.resumeArgs(resumeSessionId)
    } else {
      logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
    }
  } else if (launchSessionId) {
    if (spec.launchArgs) {
      sessionArgs = spec.launchArgs(launchSessionId)
    } else {
      logger.warn({ mode, launchSessionId }, 'Launch session requested but no launch args configured')
    }
  }
  const settingsArgs: string[] = []
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
    args: [...providerArgs, ...baseArgs, ...settingsArgs, ...sessionArgs],
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

function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = codingCliCommands.get(mode)?.label
  return label || mode.charAt(0).toUpperCase() + mode.slice(1)
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
  resumeSessionId?: string
  pendingResumeName?: string
  createdAt: number
  lastActivityAt: number
  exitedAt?: number
  status: 'running' | 'exited'
  exitCode?: number
  cwd?: string
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
}

export type BindSessionResult =
  | { ok: true; terminalId: string; sessionId: string }
  | { ok: false; reason: 'terminal_missing' | 'mode_mismatch' | 'invalid_session_id' }
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
  launchSessionId?: string,
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

      if (cwd) {
        // cwd must be a Linux path inside WSL.
        const wslCwd = isLinuxPath(cwd) ? cwd : (convertWindowsPathToWslPath(cwd) || cwd)
        args.push('--cd', wslCwd)
      }

      if (mode === 'shell') {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      const cli = resolveCodingCliCommand(mode, normalizedResume, launchSessionId, 'unix', providerSettings)
      if (!cli) {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      args.push('--exec', cli.command, ...cli.args)
      return { file: wsl, args, cwd: undefined, env: { ...env, ...cli.env } }
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
          return { file, args: ['/K', `cd /d ${quoteCmdArg(winCwd)}`], cwd: procCwd, env }
        }
        return { file, args: ['/K'], cwd: procCwd, env }
      }
      const cli = resolveCodingCliCommand(mode, normalizedResume, launchSessionId, 'windows', providerSettings)
      const cmd = cli?.command || mode
      const command = buildCmdCommand(cmd, cli?.args || [])
      const cd = winCwd ? `cd /d ${quoteCmdArg(winCwd)} && ` : ''
      return { file, args: ['/K', `${cd}${command}`], cwd: procCwd, env: cli ? { ...env, ...cli.env } : env }
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
        return { file, args: ['-NoLogo', '-NoExit', '-Command', `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}`], cwd: procCwd, env }
      }
      return { file, args: ['-NoLogo'], cwd: procCwd, env }
    }

    const cli = resolveCodingCliCommand(mode, normalizedResume, launchSessionId, 'windows', providerSettings)
    const cmd = cli?.command || mode
    const invocation = buildPowerShellCommand(cmd, cli?.args || [])
    const cd = winCwd ? `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}; ` : ''
    const command = `${cd}${invocation}`
    return {
      file,
      args: ['-NoLogo', '-NoExit', '-Command', command],
      cwd: procCwd,
      env: cli ? { ...env, ...cli.env } : env,
    }
  }
// Non-Windows: native spawn using system shell
  const systemShell = getSystemShell()
  const unixCwd = resolveUnixShellCwd(cwd)

  if (mode === 'shell') {
    return { file: systemShell, args: ['-l'], cwd: unixCwd, env }
  }

  const cli = resolveCodingCliCommand(mode, normalizedResume, launchSessionId, 'unix', providerSettings)
  const cmd = cli?.command || mode
  const args = cli?.args || []
  return { file: cmd, args, cwd: unixCwd, env: cli ? { ...env, ...cli.env } : env }
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
    // 5 permanent terminal.exit listeners (index, ws-handler, broker, codex-wiring,
    // terminal-view) plus transient per-terminal listeners during shutdown.
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

  create(opts: {
    mode: TerminalMode
    shell?: ShellType
    cwd?: string
    cols?: number
    rows?: number
    resumeSessionId?: string
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
    const launchSessionId = modeSupportsExactLaunch(opts.mode) && !resumeForSpawn
      ? randomUUID()
      : undefined

    const port = Number(process.env.PORT || 3001)
    const baseEnv = {
      FRESHELL: '1',
      FRESHELL_URL: process.env.FRESHELL_URL || `http://localhost:${port}`,
      FRESHELL_TOKEN: process.env.AUTH_TOKEN || '',
      FRESHELL_TERMINAL_ID: terminalId,
      ...(opts.envContext?.tabId ? { FRESHELL_TAB_ID: opts.envContext.tabId } : {}),
      ...(opts.envContext?.paneId ? { FRESHELL_PANE_ID: opts.envContext.paneId } : {}),
    }

    const { file, args, env, cwd: procCwd } = buildSpawnSpec(
      opts.mode,
      cwd,
      opts.shell || 'system',
      resumeForSpawn,
      opts.providerSettings,
      baseEnv,
      launchSessionId,
    )

    const endSpawnTimer = startPerfTimer(
      'terminal_spawn',
      { terminalId, mode: opts.mode, shell: opts.shell || 'system' },
      { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
    )

    logger.info({ terminalId, file, args, cwd: procCwd, mode: opts.mode, shell: opts.shell || 'system' }, 'Spawning terminal')

    const ptyProc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: procCwd,
      env: env as any,
    })
    endSpawnTimer({ cwd: procCwd })

    const title = getModeLabel(opts.mode)

    const record: TerminalRecord = {
      terminalId,
      title,
      description: undefined,
      mode: opts.mode,
      resumeSessionId: undefined,
      createdAt,
      lastActivityAt: createdAt,
      status: 'running',
      cwd,
      cols,
      rows,
      clients: new Set(),
      suppressedOutputClients: new Set(),
      pendingSnapshotClients: new Map(),

      buffer: new ChunkRingBuffer(this.scrollbackMaxChars),
      pty: ptyProc,
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

    ptyProc.onData((data) => {
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
      if (record.status === 'exited') {
        return
      }
      record.status = 'exited'
      record.exitCode = e.exitCode
      const now = Date.now()
      record.lastActivityAt = now
      record.exitedAt = now
      for (const client of record.clients) {
        this.flushOutputBuffer(client)
        this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: e.exitCode }, { terminalId, perf: record.perf })
      }
      record.clients.clear()
      record.suppressedOutputClients.clear()
      record.pendingSnapshotClients.clear()
      this.releaseBinding(terminalId, 'exit')
      this.emit('terminal.exit', { terminalId, exitCode: e.exitCode })
      this.reapExitedTerminals()
    })

    this.terminals.set(terminalId, record)
    const exactSessionId = launchSessionId ?? resumeForBinding
    if (modeSupportsResume(opts.mode) && exactSessionId) {
      const bound = this.bindSession(
        terminalId,
        opts.mode as CodingCliProviderName,
        exactSessionId,
        launchSessionId ? 'launch' : 'resume',
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
    if (term.status === 'exited') return true
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
    this.releaseBinding(terminalId, 'exit')
    this.emit('terminal.exit', { terminalId, exitCode: term.exitCode })
    this.reapExitedTerminals()
    return true
  }

  remove(terminalId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    this.kill(terminalId)
    this.terminals.delete(terminalId)
    return true
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
    explicit?: { provider?: CodingCliProviderName; sessionId?: string },
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
   * The cwd parameter is kept for API compatibility but ignored.
   */
  findTerminalsBySession(mode: TerminalMode, sessionId: string, _cwd?: string): TerminalRecord[] {
    const results: TerminalRecord[] = []
    for (const term of this.terminals.values()) {
      if (term.mode !== mode) continue
      if (term.resumeSessionId === sessionId) {
        results.push(term)
      }
    }
    return results
  }

  /**
   * Find a running terminal of the given mode that already owns the given sessionId.
   */
  findRunningTerminalBySession(mode: TerminalMode, sessionId: string): TerminalRecord | undefined {
    if (modeSupportsResume(mode)) {
      const owner = this.bindingAuthority.ownerForSession(mode as CodingCliProviderName, sessionId)
      if (owner) {
        const rec = this.terminals.get(owner)
        if (rec && rec.mode === mode && rec.status === 'running' && rec.resumeSessionId === sessionId) {
          return rec
        }
        this.releaseBinding(owner, 'stale_owner', { provider: mode as CodingCliProviderName, sessionId })
      }
    }
    for (const term of this.terminals.values()) {
      if (term.mode !== mode) continue
      if (term.status !== 'running') continue
      if (term.resumeSessionId === sessionId) return term
    }
    return undefined
  }

  getCanonicalRunningTerminalBySession(mode: TerminalMode, sessionId: string): TerminalRecord | undefined {
    if (!modeSupportsResume(mode)) return undefined

    const owner = this.bindingAuthority.ownerForSession(mode as CodingCliProviderName, sessionId)
    if (owner) {
      const rec = this.terminals.get(owner)
      if (rec && rec.mode === mode && rec.status === 'running' && rec.resumeSessionId === sessionId) {
        return rec
      }
      this.releaseBinding(owner, 'stale_owner', { provider: mode as CodingCliProviderName, sessionId })
    }

    const matches = Array.from(this.terminals.values())
      .filter((term) => term.mode === mode && term.status === 'running' && term.resumeSessionId === sessionId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

    return matches[0]
  }

  repairLegacySessionOwners(mode: TerminalMode, sessionId: string): RepairLegacySessionOwnersResult {
    if (!modeSupportsResume(mode)) {
      return { repaired: false, clearedTerminalIds: [] }
    }

    const matches = Array.from(this.terminals.values())
      .filter((term) => term.mode === mode && term.status === 'running' && term.resumeSessionId === sessionId)
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
      this.releaseBinding(owner, ownerIsDuplicate ? 'repair_duplicate' : 'stale_owner', { provider, sessionId })
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
      this.releaseBinding(duplicate.terminalId, 'repair_duplicate', { provider, sessionId })
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
  isSessionBound(provider: CodingCliProviderName, sessionId: string): boolean {
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

    // Set up exit listeners BEFORE sending signals (avoid race)
    const exitPromises = running.map(term =>
      new Promise<void>(resolve => {
        if (term.status === 'exited') { resolve(); return }
        const handler = (evt: { terminalId: string }) => {
          if (evt.terminalId === term.terminalId) {
            this.off('terminal.exit', handler)
            resolve()
          }
        }
        this.on('terminal.exit', handler)
        // Re-check after listener setup (TOCTOU guard — status may mutate between filter and here)
        if ((term.status as string) === 'exited') {
          this.off('terminal.exit', handler)
          resolve()
        }
      })
    )

    // Send SIGTERM (or plain kill on Windows where signal args are unsupported)
    const isWindows = process.platform === 'win32'
    for (const term of running) {
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
