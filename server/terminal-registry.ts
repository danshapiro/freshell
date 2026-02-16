import { nanoid } from 'nanoid'
import type WebSocket from 'ws'
import * as pty from 'node-pty'
import os from 'os'
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
const perfConfig = getPerfConfig()

// Re-exported from extracted modules for backward compatibility
export type { ShellType } from './platform-utils.js'
export { isWsl, isWindowsLike, getSystemShell, isLinuxPath } from './platform-utils.js'
export { ChunkRingBuffer } from './chunk-ring-buffer.js'
export type { TerminalMode } from './spawn-spec.js'
export { CODING_CLI_COMMANDS, modeSupportsResume, escapeCmdExe, buildSpawnSpec } from './spawn-spec.js'

import { ChunkRingBuffer } from './chunk-ring-buffer.js'
import { isWindows } from './platform-utils.js'
import { buildSpawnSpec, getModeLabel, normalizeResumeSessionId } from './spawn-spec.js'
import type { TerminalMode } from './spawn-spec.js'
import type { ShellType } from './platform-utils.js'

type PendingSnapshotQueue = {
  chunks: string[]
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

function getDefaultCwd(settings?: AppSettings): string | undefined {
  const candidate = settings?.defaultCwd
  if (!candidate) return undefined
  const { ok, resolvedPath } = isReachableDirectorySync(candidate)
  return ok ? resolvedPath : undefined
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
        this.safeSend(client, { type: 'terminal.output', terminalId, data }, { terminalId, perf: record.perf })
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
      this.safeSend(client, { type: 'terminal.output', terminalId, data }, { terminalId, perf: term.perf })
    }
  }

  detach(terminalId: string, client: WebSocket): boolean {
    const term = this.terminals.get(terminalId)
    if (!term) return false
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
