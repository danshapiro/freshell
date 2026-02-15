import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import * as pty from 'node-pty'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog, startPerfTimer } from './perf-logger.js'
import type { AppSettings } from './config-store.js'
import { isReachableDirectorySync } from './path-utils.js'
import { isValidClaudeSessionId } from './claude-session-id.js'

const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
const DEFAULT_MAX_SCROLLBACK_CHARS = Number(process.env.MAX_SCROLLBACK_CHARS || 64 * 1024)
const MIN_SCROLLBACK_CHARS = 64 * 1024
const MAX_SCROLLBACK_CHARS = 2 * 1024 * 1024
const APPROX_CHARS_PER_LINE = 200
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS || 50)
const DEFAULT_MAX_PENDING_SNAPSHOT_CHARS = 512 * 1024
const MOBILE_OUTPUT_FLUSH_MS = Number(process.env.MOBILE_OUTPUT_FLUSH_MS || 40)
const MAX_MOBILE_OUTPUT_BUFFER_CHARS = Number(process.env.MAX_MOBILE_OUTPUT_BUFFER_CHARS || 256 * 1024)
const perfConfig = getPerfConfig()

// TerminalMode includes 'shell' for regular terminals, plus coding CLI providers.
// Provider command defaults are configurable via env vars; resume semantics
// are only configured for providers that define resume args.
export type TerminalMode = 'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'
export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

type CodingCliCommandSpec = {
  label: string
  envVar: string
  defaultCommand: string
  resumeArgs?: (sessionId: string) => string[]
}

const CODING_CLI_COMMANDS: Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec> = {
  claude: {
    label: 'Claude',
    envVar: 'CLAUDE_CMD',
    defaultCommand: 'claude',
    resumeArgs: (sessionId) => ['--resume', sessionId],
  },
  codex: {
    label: 'Codex',
    envVar: 'CODEX_CMD',
    defaultCommand: 'codex',
    resumeArgs: (sessionId) => ['resume', sessionId],
  },
  opencode: {
    label: 'OpenCode',
    envVar: 'OPENCODE_CMD',
    defaultCommand: 'opencode',
  },
  gemini: {
    label: 'Gemini',
    envVar: 'GEMINI_CMD',
    defaultCommand: 'gemini',
  },
  kimi: {
    label: 'Kimi',
    envVar: 'KIMI_CMD',
    defaultCommand: 'kimi',
  },
}

/**
 * Check if a terminal mode supports session resume.
 * Only modes with configured resumeArgs in CODING_CLI_COMMANDS support resume.
 */
export function modeSupportsResume(mode: TerminalMode): boolean {
  if (mode === 'shell') return false
  return !!CODING_CLI_COMMANDS[mode]?.resumeArgs
}

type ProviderTarget = 'unix' | 'windows'

function providerNotificationArgs(mode: TerminalMode, target: ProviderTarget): string[] {
  if (mode === 'codex') {
    return [
      '-c', 'tui.notification_method=bel',
      '-c', "tui.notifications=['agent-turn-complete']",
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
    return ['--settings', JSON.stringify(settings)]
  }

  return []
}

function resolveCodingCliCommand(mode: TerminalMode, resumeSessionId?: string, target: ProviderTarget = 'unix') {
  if (mode === 'shell') return null
  const spec = CODING_CLI_COMMANDS[mode]
  const command = process.env[spec.envVar] || spec.defaultCommand
  const providerArgs = providerNotificationArgs(mode, target)
  let resumeArgs: string[] = []
  if (resumeSessionId) {
    if (spec.resumeArgs) {
      resumeArgs = spec.resumeArgs(resumeSessionId)
    } else {
      logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
    }
  }
  return { command, args: [...providerArgs, ...resumeArgs], label: spec.label }
}

function normalizeResumeSessionId(mode: TerminalMode, resumeSessionId?: string): string | undefined {
  if (!resumeSessionId) return undefined
  if (mode !== 'claude') return resumeSessionId
  if (isValidClaudeSessionId(resumeSessionId)) return resumeSessionId
  logger.warn({ resumeSessionId }, 'Ignoring invalid Claude resumeSessionId')
  return undefined
}

function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = CODING_CLI_COMMANDS[mode]?.label
  return label || mode.toUpperCase()
}

type PendingSnapshotQueue = {
  chunks: string[]
  queuedChars: number
}

type PendingMobileOutput = {
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
  createdAt: number
  lastActivityAt: number
  exitedAt?: number
  status: 'running' | 'exited'
  exitCode?: number
  cwd?: string
  cols: number
  rows: number
  clients: Set<WebSocket>
  pendingSnapshotClients: Map<WebSocket, PendingSnapshotQueue>
  warnedIdle?: boolean
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

function getDefaultCwd(settings?: AppSettings): string | undefined {
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

/**
 * Get a sensible default working directory for Windows shells.
 * On native Windows: user's home directory (C:\Users\<username>)
 * In WSL: Windows user profile converted to WSL path, falling back to C:\
 *
 * This avoids UNC paths (\\wsl.localhost\...) which cmd.exe doesn't support.
 * Respects custom WSL mount configurations via WSL_WINDOWS_SYS32.
 */
function getWindowsDefaultCwd(): string {
  if (isWindows()) {
    return os.homedir()
  }
  // In WSL, we need a Windows-accessible path
  const mountPrefix = getWslMountPrefix()

  // Try USERPROFILE if it's shared via WSLENV, convert to WSL mount path
  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    // Convert Windows path (C:\Users\name) to WSL path (/mnt/c/Users/name)
    const match = userProfile.match(/^([A-Za-z]):\\(.*)$/)
    if (match) {
      const drive = match[1].toLowerCase()
      const rest = match[2].replace(/\\/g, '/')
      return `${mountPrefix}/${drive}/${rest}`
    }
  }
  // Fallback: use C:\ root
  return `${mountPrefix}/c`
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

export function buildSpawnSpec(mode: TerminalMode, cwd: string | undefined, shell: ShellType, resumeSessionId?: string) {
  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
  }

  const normalizedResume = normalizeResumeSessionId(mode, resumeSessionId)

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
        args.push('--cd', cwd)
      }

      if (mode === 'shell') {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      const cli = resolveCodingCliCommand(mode, normalizedResume, 'unix')
      if (!cli) {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      args.push('--exec', cli.command, ...cli.args)
      return { file: wsl, args, cwd: undefined, env }
    }

    // Option B: Native Windows shells (PowerShell/cmd)

    if (windowsMode === 'cmd') {
      const file = getWindowsExe('cmd')
      // In WSL, we can't pass Linux paths as cwd to Windows executables (they become UNC paths)
      // Instead, pass no cwd and use cd /d inside the command
      const inWsl = isWsl()
      const winCwd = inWsl ? getWindowsDefaultCwd() : (isLinuxPath(cwd) ? undefined : cwd)
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
      const cli = resolveCodingCliCommand(mode, normalizedResume, 'windows')
      const cmd = cli?.command || mode
      const command = buildCmdCommand(cmd, cli?.args || [])
      const cd = winCwd ? `cd /d ${quoteCmdArg(winCwd)} && ` : ''
      return { file, args: ['/K', `${cd}${command}`], cwd: procCwd, env }
    }

    // default to PowerShell
    const file = getWindowsExe('powershell')
    // In WSL, we can't pass Linux paths as cwd to Windows executables (they become UNC paths)
    const inWsl = isWsl()
    const winCwd = inWsl ? getWindowsDefaultCwd() : (isLinuxPath(cwd) ? undefined : cwd)
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

    const cli = resolveCodingCliCommand(mode, normalizedResume, 'windows')
    const cmd = cli?.command || mode
    const invocation = buildPowerShellCommand(cmd, cli?.args || [])
    const cd = winCwd ? `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}; ` : ''
    const command = `${cd}${invocation}`
    return { file, args: ['-NoLogo', '-NoExit', '-Command', command], cwd: procCwd, env }
  }
// Non-Windows: native spawn using system shell
  const systemShell = getSystemShell()

  if (mode === 'shell') {
    return { file: systemShell, args: ['-l'], cwd, env }
  }

  const cli = resolveCodingCliCommand(mode, normalizedResume, 'unix')
  const cmd = cli?.command || mode
  const args = cli?.args || []
  return { file: cmd, args, cwd, env }
}

export class TerminalRegistry extends EventEmitter {
  private terminals = new Map<string, TerminalRecord>()
  private settings: AppSettings | undefined
  private idleTimer: NodeJS.Timeout | null = null
  private perfTimer: NodeJS.Timeout | null = null
  private maxTerminals: number
  private maxExitedTerminals: number
  private scrollbackMaxChars: number
  private maxPendingSnapshotChars: number
  private mobileOutputBuffers = new Map<WebSocket, PendingMobileOutput>()

  constructor(settings?: AppSettings, maxTerminals?: number, maxExitedTerminals?: number) {
    super()
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

  setSettings(settings: AppSettings) {
    this.settings = settings
    this.scrollbackMaxChars = this.computeScrollbackMaxChars(settings)
    for (const t of this.terminals.values()) {
      t.buffer.setMaxChars(this.scrollbackMaxChars)
    }
  }

  private computeScrollbackMaxChars(settings?: AppSettings): number {
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
    const rawWarnMinutes = settings.safety.warnBeforeKillMinutes
    const warnMinutes =
      typeof rawWarnMinutes === 'number' && Number.isFinite(rawWarnMinutes) && rawWarnMinutes > 0 && rawWarnMinutes < killMinutes
        ? rawWarnMinutes
        : 0

    const now = Date.now()

    for (const term of this.terminals.values()) {
      if (term.status !== 'running') continue
      if (term.clients.size > 0) continue // only detached

      const idleMs = now - term.lastActivityAt
      const idleMinutes = idleMs / 60000

      if (warnMinutes > 0) {
        const warnAtMinutes = killMinutes - warnMinutes
        if (idleMinutes >= warnAtMinutes && idleMinutes < killMinutes && !term.warnedIdle) {
          term.warnedIdle = true
          this.emit('terminal.idle.warning', {
            terminalId: term.terminalId,
            killMinutes,
            warnMinutes,
            lastActivityAt: term.lastActivityAt,
          })
        }
      }

      if (idleMinutes >= killMinutes) {
        logger.info({ terminalId: term.terminalId }, 'Auto-killing idle detached terminal')
        this.kill(term.terminalId)
      }
    }
  }

  // Exposed for unit tests to validate idle warning/kill behavior without relying on timers.
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

  create(opts: { mode: TerminalMode; shell?: ShellType; cwd?: string; cols?: number; rows?: number; resumeSessionId?: string }): TerminalRecord {
    this.reapExitedTerminals()
    if (this.runningCount() >= this.maxTerminals) {
      throw new Error(`Maximum terminal limit (${this.maxTerminals}) reached. Please close some terminals before creating new ones.`)
    }

    const terminalId = nanoid()
    const createdAt = Date.now()
    const cols = opts.cols || 120
    const rows = opts.rows || 30

    const cwd = opts.cwd || getDefaultCwd(this.settings) || (isWindows() ? undefined : os.homedir())
    const normalizedResume = normalizeResumeSessionId(opts.mode, opts.resumeSessionId)

    const { file, args, env, cwd: procCwd } = buildSpawnSpec(opts.mode, cwd, opts.shell || 'system', normalizedResume)

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
      resumeSessionId: normalizedResume,
      createdAt,
      lastActivityAt: createdAt,
      status: 'running',
      cwd,
      cols,
      rows,
      clients: new Set(),
      pendingSnapshotClients: new Map(),
      warnedIdle: false,
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
      record.warnedIdle = false
      record.buffer.append(data)
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
        const pending = record.pendingSnapshotClients.get(client)
        if (pending) {
          const nextChars = pending.queuedChars + data.length
          if (data.length > this.maxPendingSnapshotChars || nextChars > this.maxPendingSnapshotChars) {
            // If a terminal spews output while we're sending a snapshot, queueing unboundedly can OOM the server.
            // Prefer explicit resync: drop the client and let it reconnect/reattach for a fresh snapshot.
            try {
              ;(client as any).close?.(4008, 'Attach snapshot queue overflow')
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
        this.flushMobileOutput(client)
        this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: e.exitCode }, { terminalId, perf: record.perf })
      }
      record.clients.clear()
      record.pendingSnapshotClients.clear()
      this.emit('terminal.exit', { terminalId, exitCode: e.exitCode })
      this.reapExitedTerminals()
    })

    this.terminals.set(terminalId, record)
    this.emit('terminal.created', record)
    return record
  }

  attach(terminalId: string, client: WebSocket, opts?: { pendingSnapshot?: boolean }): TerminalRecord | null {
    const term = this.terminals.get(terminalId)
    if (!term) return null
    term.clients.add(client)
    term.warnedIdle = false
    if (opts?.pendingSnapshot) term.pendingSnapshotClients.set(client, { chunks: [], queuedChars: 0 })
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
    this.flushMobileOutput(client)
    this.clearMobileOutput(client)
    term.clients.delete(client)
    term.pendingSnapshotClients.delete(client)
    return true
  }

  input(terminalId: string, data: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term || term.status !== 'running') return false
    const now = Date.now()
    term.lastActivityAt = now
    term.warnedIdle = false
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
    return true
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const term = this.terminals.get(terminalId)
    if (!term || term.status !== 'running') return false
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
      this.flushMobileOutput(client)
      this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: term.exitCode })
    }
    term.clients.clear()
    term.pendingSnapshotClients.clear()
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

  private isMobileClient(client: WebSocket): boolean {
    return (client as any).isMobileClient === true
  }

  private clearMobileOutput(client: WebSocket): void {
    const pending = this.mobileOutputBuffers.get(client)
    if (!pending) return
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    this.mobileOutputBuffers.delete(client)
  }

  private flushMobileOutput(client: WebSocket): void {
    const pending = this.mobileOutputBuffers.get(client)
    if (!pending) return

    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }

    if (pending.queuedChars <= 0) {
      this.mobileOutputBuffers.delete(client)
      return
    }

    for (const [terminalId, chunks] of pending.chunksByTerminal) {
      if (chunks.length === 0) continue
      const data = chunks.join('')
      const perf = pending.perfByTerminal.get(terminalId)
      this.safeSend(client, { type: 'terminal.output', terminalId, data }, { terminalId, perf })
    }
    this.mobileOutputBuffers.delete(client)
  }

  private sendTerminalOutput(client: WebSocket, terminalId: string, data: string, perf?: TerminalRecord['perf']): void {
    if (!this.isMobileClient(client)) {
      this.safeSend(client, { type: 'terminal.output', terminalId, data }, { terminalId, perf })
      return
    }

    let pending = this.mobileOutputBuffers.get(client)
    if (!pending) {
      pending = {
        timer: null,
        chunksByTerminal: new Map(),
        perfByTerminal: new Map(),
        queuedChars: 0,
      }
      this.mobileOutputBuffers.set(client, pending)
    }

    const nextSize = pending.queuedChars + data.length
    if (nextSize > MAX_MOBILE_OUTPUT_BUFFER_CHARS) {
      this.flushMobileOutput(client)
      this.safeSend(client, { type: 'terminal.output', terminalId, data }, { terminalId, perf })
      return
    }

    const chunks = pending.chunksByTerminal.get(terminalId) || []
    chunks.push(data)
    pending.chunksByTerminal.set(terminalId, chunks)
    pending.perfByTerminal.set(terminalId, perf)
    pending.queuedChars = nextSize

    if (!pending.timer) {
      pending.timer = setTimeout(() => {
        this.flushMobileOutput(client)
      }, MOBILE_OUTPUT_FLUSH_MS)
    }
  }

  safeSend(client: WebSocket, msg: unknown, context?: { terminalId?: string; perf?: TerminalRecord['perf'] }) {
    // Backpressure guard.
    // @ts-ignore
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
        ;(client as any).close?.(4008, 'Backpressure')
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
    for (const term of this.terminals.values()) {
      if (term.mode !== mode) continue
      if (term.status !== 'running') continue
      if (term.resumeSessionId === sessionId) return term
    }
    return undefined
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
  setResumeSessionId(terminalId: string, sessionId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    if (term.mode === 'claude' && !isValidClaudeSessionId(sessionId)) {
      logger.warn({ sessionId, terminalId }, 'Ignoring invalid Claude resumeSessionId')
      return false
    }
    term.resumeSessionId = sessionId
    return true
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
