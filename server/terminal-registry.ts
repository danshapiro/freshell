import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import * as pty from 'node-pty'
import os from 'os'
import path from 'path'
import { logger } from './logger'
import type { AppSettings } from './config-store'

const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 2 * 1024 * 1024)
const DEFAULT_MAX_SCROLLBACK_CHARS = Number(process.env.MAX_SCROLLBACK_CHARS || 64 * 1024)
const MAX_TERMINALS = Number(process.env.MAX_TERMINALS || 50)

export type TerminalMode = 'shell' | 'claude' | 'codex'
export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

export type TerminalRecord = {
  terminalId: string
  title: string
  description?: string
  mode: TerminalMode
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
 * Priority: $SHELL → platform fallback → /bin/sh
 */
function getSystemShell(): string {
  const shell = process.env.SHELL
  if (shell) return shell

  if (process.platform === 'darwin') {
    // macOS: prefer zsh (default since Catalina)
    return '/bin/zsh'
  }
  // Linux: prefer bash
  return '/bin/bash'
}

function buildSpawnSpec(mode: TerminalMode, cwd: string | undefined, shell: ShellType, resumeSessionId?: string) {
  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
  }

  // Resolve shell for the current platform
  const effectiveShell = resolveShell(shell)

  if (isWindows()) {
    // Use protocol-specified shell, falling back to env var for backwards compatibility
    const windowsMode = effectiveShell !== 'system'
      ? effectiveShell
      : (process.env.WINDOWS_SHELL || 'wsl').toLowerCase()

    // Option A: WSL (default) — recommended for Claude/Codex on Windows.
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

      if (mode === 'claude') {
        const cmd = process.env.CLAUDE_CMD || 'claude'
        const cmdArgs: string[] = []
        if (resumeSessionId) cmdArgs.push('--resume', resumeSessionId)
        args.push('--exec', cmd, ...cmdArgs)
        return { file: wsl, args, cwd: undefined, env }
      }

      const cmd = process.env.CODEX_CMD || 'codex'
      args.push('--exec', cmd)
      return { file: wsl, args, cwd: undefined, env }
    }

    // Option B: Native Windows shells (PowerShell/cmd)
    const escapePowershell = (s: string) => s.replace(/`/g, '``').replace(/"/g, '`"')
    const quote = (s: string) => `"${escapePowershell(s)}"`

    if (windowsMode === 'cmd') {
      const file = 'cmd.exe'
      if (mode === 'shell') {
        return { file, args: ['/K'], cwd, env }
      }
      const cmd = mode === 'claude' ? (process.env.CLAUDE_CMD || 'claude') : (process.env.CODEX_CMD || 'codex')
      const resume = mode === 'claude' && resumeSessionId ? ` --resume ${resumeSessionId}` : ''
      const cd = cwd ? `cd /d ${cwd} && ` : ''
      return { file, args: ['/K', `${cd}${cmd}${resume}`], cwd, env }
    }

    // default to PowerShell
    const file = process.env.POWERSHELL_EXE || 'powershell.exe'
    if (mode === 'shell') {
      return { file, args: ['-NoLogo'], cwd, env }
    }

    const cmd = mode === 'claude' ? (process.env.CLAUDE_CMD || 'claude') : (process.env.CODEX_CMD || 'codex')
    const resumeArgs = mode === 'claude' && resumeSessionId ? ` --resume ${resumeSessionId}` : ''
    const cd = cwd ? `Set-Location -LiteralPath ${quote(cwd)}; ` : ''
    const command = `${cd}${cmd}${resumeArgs}`
    return { file, args: ['-NoLogo', '-NoExit', '-Command', command], cwd, env }
  }
// Non-Windows: native spawn using system shell
  const systemShell = getSystemShell()

  if (mode === 'shell') {
    return { file: systemShell, args: ['-l'], cwd, env }
  }

  if (mode === 'claude') {
    const cmd = process.env.CLAUDE_CMD || 'claude'
    const args: string[] = []
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    return { file: cmd, args, cwd, env }
  }

  const cmd = process.env.CODEX_CMD || 'codex'
  return { file: cmd, args: [], cwd, env }
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

    const title = opts.mode === 'shell' ? 'Shell' : opts.mode === 'claude' ? 'Claude' : 'Codex'

    const record: TerminalRecord = {
      terminalId,
      title,
      description: undefined,
      mode: opts.mode,
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
