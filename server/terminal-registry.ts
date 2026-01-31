import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import * as pty from 'node-pty'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { logger } from './logger.js'
import type { AppSettings } from './config-store.js'

const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
const DEFAULT_MAX_SCROLLBACK_CHARS = Number(process.env.MAX_SCROLLBACK_CHARS || 64 * 1024)
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS || 50)

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

function resolveCodingCliCommand(mode: TerminalMode, resumeSessionId?: string) {
  if (mode === 'shell') return null
  const spec = CODING_CLI_COMMANDS[mode]
  const command = process.env[spec.envVar] || spec.defaultCommand
  let args: string[] = []
  if (resumeSessionId) {
    if (spec.resumeArgs) {
      args = spec.resumeArgs(resumeSessionId)
    } else {
      logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
    }
  }
  return { command, args, label: spec.label }
}

function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = CODING_CLI_COMMANDS[mode]?.label
  return label || mode.toUpperCase()
}

export type TerminalRecord = {
  terminalId: string
  title: string
  description?: string
  mode: TerminalMode
  resumeSessionId?: string
  createdAt: number
  lastActivityAt: number
  status: 'running' | 'exited'
  exitCode?: number
  cwd?: string
  cols: number
  rows: number
  clients: Set<WebSocket>
  warnedIdle?: boolean
  buffer: ChunkRingBuffer
  pty: pty.IPty
}

export class ChunkRingBuffer {
  private chunks: string[] = []
  private size = 0
  constructor(private maxChars: number) {}

  append(chunk: string) {
    if (!chunk) return
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.maxChars && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.size -= removed.length
    }
    // If a single chunk is enormous, truncate it.
    if (this.size > this.maxChars && this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks[0] = only.slice(-this.maxChars)
      this.size = this.chunks[0].length
    }
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
  return settings?.defaultCwd || undefined
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Resolve the effective shell based on platform and requested shell type.
 * - Windows: 'system' → 'cmd', others pass through
 * - macOS/Linux: always normalize to 'system' (use $SHELL or fallback)
 */
function resolveShell(requested: ShellType): ShellType {
  if (isWindows()) {
    // On Windows, 'system' maps to cmd (or ComSpec)
    return requested === 'system' ? 'cmd' : requested
  }
  // On macOS/Linux, always use 'system' shell
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

export function buildSpawnSpec(mode: TerminalMode, cwd: string | undefined, shell: ShellType, resumeSessionId?: string) {
  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
  }

  // Resolve shell for the current platform
  const effectiveShell = resolveShell(shell)

  if (isWindows()) {
    // If the cwd is a Linux path, force WSL mode since native Windows shells can't use it
    const forceWsl = isLinuxPath(cwd)

    // Use protocol-specified shell, falling back to env var for backwards compatibility
    const windowsMode = forceWsl
      ? 'wsl'
      : effectiveShell !== 'system'
        ? effectiveShell
        : (process.env.WINDOWS_SHELL || 'wsl').toLowerCase()

    // Option A: WSL (default) — recommended for coding CLIs on Windows.
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

      const cli = resolveCodingCliCommand(mode, resumeSessionId)
      if (!cli) {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      args.push('--exec', cli.command, ...cli.args)
      return { file: wsl, args, cwd: undefined, env }
    }

    // Option B: Native Windows shells (PowerShell/cmd)
    const escapePowershell = (s: string) => s.replace(/`/g, '``').replace(/"/g, '`"')
    const quote = (s: string) => `"${escapePowershell(s)}"`

    if (windowsMode === 'cmd') {
      const file = 'cmd.exe'
      // Don't use Linux paths as cwd on native Windows
      const winCwd = isLinuxPath(cwd) ? undefined : cwd
      if (mode === 'shell') {
        return { file, args: ['/K'], cwd: winCwd, env }
      }
      const cli = resolveCodingCliCommand(mode, resumeSessionId)
      const cmd = cli?.command || mode
      const resume = cli?.args.length ? ` ${cli.args.join(' ')}` : ''
      const cd = winCwd ? `cd /d ${winCwd} && ` : ''
      return { file, args: ['/K', `${cd}${cmd}${resume}`], cwd: winCwd, env }
    }

    // default to PowerShell
    const file = process.env.POWERSHELL_EXE || 'powershell.exe'
    // Don't use Linux paths as cwd on native Windows
    const winCwd = isLinuxPath(cwd) ? undefined : cwd
    if (mode === 'shell') {
      return { file, args: ['-NoLogo'], cwd: winCwd, env }
    }

    const cli = resolveCodingCliCommand(mode, resumeSessionId)
    const cmd = cli?.command || mode
    const resumeArgs = cli?.args.length ? ` ${cli.args.join(' ')}` : ''
    const cd = winCwd ? `Set-Location -LiteralPath ${quote(winCwd)}; ` : ''
    const command = `${cd}${cmd}${resumeArgs}`
    return { file, args: ['-NoLogo', '-NoExit', '-Command', command], cwd: winCwd, env }
  }
// Non-Windows: native spawn using system shell
  const systemShell = getSystemShell()

  if (mode === 'shell') {
    return { file: systemShell, args: ['-l'], cwd, env }
  }

  const cli = resolveCodingCliCommand(mode, resumeSessionId)
  const cmd = cli?.command || mode
  const args = cli?.args || []
  return { file: cmd, args, cwd, env }
}

export class TerminalRegistry {
  private terminals = new Map<string, TerminalRecord>()
  private settings: AppSettings | undefined
  private idleTimer: NodeJS.Timeout | null = null
  private maxTerminals: number

  constructor(settings?: AppSettings, maxTerminals?: number) {
    this.settings = settings
    this.maxTerminals = maxTerminals ?? MAX_TERMINALS
    this.startIdleMonitor()
  }

  setSettings(settings: AppSettings) {
    this.settings = settings
  }

  private startIdleMonitor() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = setInterval(() => {
      this.enforceIdleKills().catch((err) => logger.warn({ err }, 'Idle monitor error'))
    }, 30_000)
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

  create(opts: { mode: TerminalMode; shell?: ShellType; cwd?: string; cols?: number; rows?: number; resumeSessionId?: string }): TerminalRecord {
    if (this.terminals.size >= this.maxTerminals) {
      throw new Error(`Maximum terminal limit (${this.maxTerminals}) reached. Please close some terminals before creating new ones.`)
    }

    const terminalId = nanoid()
    const createdAt = Date.now()
    const cols = opts.cols || 120
    const rows = opts.rows || 30

    const cwd = opts.cwd || getDefaultCwd(this.settings) || (isWindows() ? undefined : os.homedir())

    const { file, args, env, cwd: procCwd } = buildSpawnSpec(opts.mode, cwd, opts.shell || 'system', opts.resumeSessionId)

    logger.info({ terminalId, file, args, cwd: procCwd, mode: opts.mode, shell: opts.shell || 'system' }, 'Spawning terminal')

    const ptyProc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: procCwd,
      env: env as any,
    })

    const title = getModeLabel(opts.mode)

    const record: TerminalRecord = {
      terminalId,
      title,
      description: undefined,
      mode: opts.mode,
      resumeSessionId: opts.resumeSessionId,
      createdAt,
      lastActivityAt: createdAt,
      status: 'running',
      cwd,
      cols,
      rows,
      clients: new Set(),
      buffer: new ChunkRingBuffer(DEFAULT_MAX_SCROLLBACK_CHARS),
      pty: ptyProc,
    }

    ptyProc.onData((data) => {
      record.lastActivityAt = Date.now()
      record.buffer.append(data)
      for (const client of record.clients) {
        this.safeSend(client, { type: 'terminal.output', terminalId, data })
      }
    })

    ptyProc.onExit((e) => {
      record.status = 'exited'
      record.exitCode = e.exitCode
      record.lastActivityAt = Date.now()
      for (const client of record.clients) {
        this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: e.exitCode })
      }
      record.clients.clear()
    })

    this.terminals.set(terminalId, record)
    return record
  }

  attach(terminalId: string, client: WebSocket): TerminalRecord | null {
    const term = this.terminals.get(terminalId)
    if (!term) return null
    term.clients.add(client)
    return term
  }

  detach(terminalId: string, client: WebSocket): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
    term.clients.delete(client)
    return true
  }

  input(terminalId: string, data: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term || term.status !== 'running') return false
    term.lastActivityAt = Date.now()
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
    try {
      term.pty.kill()
    } catch (err) {
      logger.warn({ err, terminalId }, 'kill failed')
    }
    term.status = 'exited'
    term.exitCode = term.exitCode ?? 0
    for (const client of term.clients) {
      this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: term.exitCode })
    }
    term.clients.clear()
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

  safeSend(client: WebSocket, msg: unknown) {
    // Backpressure guard.
    // @ts-ignore
    const buffered = client.bufferedAmount as number | undefined
    if (typeof buffered === 'number' && buffered > MAX_WS_BUFFERED_AMOUNT) {
      // Drop output to prevent unbounded memory.
      return
    }
    try {
      client.send(JSON.stringify(msg))
    } catch {
      // ignore
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
   * Find claude-mode terminals that have no resumeSessionId (waiting to be associated)
   * and whose cwd matches the given path. Results sorted by createdAt (oldest first).
   */
  findUnassociatedClaudeTerminals(cwd: string): TerminalRecord[] {
    const results: TerminalRecord[] = []
    // Platform-aware normalization: case-insensitive on Windows, case-sensitive on Unix
    const normalize = (p: string) => {
      const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '')
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized
    }
    const targetCwd = normalize(cwd)

    for (const term of this.terminals.values()) {
      if (term.mode !== 'claude') continue
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
   * Set the resumeSessionId on a terminal (one-time association).
   * Returns false if terminal not found.
   */
  setResumeSessionId(terminalId: string, sessionId: string): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
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

    // Kill all terminals
    const terminalIds = Array.from(this.terminals.keys())
    for (const terminalId of terminalIds) {
      this.kill(terminalId)
    }

    logger.info({ count: terminalIds.length }, 'All terminals shut down')
  }
}
