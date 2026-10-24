import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** A Kilroy-flavoured production sidecar over the contract-tested CLI simulator. */
export interface KilroyLedgerEntry {
  kind: string
  pid: number
  [key: string]: any
}

export interface KilroyRuntimeOptions {
  program?: { rules: unknown[] }
  timeScale?: number
}

export interface KilroyRuntime {
  proc: ChildProcess
  cwd: string
  claudeConfigDir: string
  ledgerPath: string
  /** Write a real sidecar request. The caller supplies native create/send UUIDs. */
  send: (msg: Record<string, unknown>) => void
  /** Consume successive matching frames after this runtime's read cursor. */
  nextEvent: (
    type: string,
    pred?: (event: Record<string, any>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, any>>
  events: () => readonly Record<string, any>[]
  waitExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Gracefully close the owned sidecar/CLI, then remove their isolated files. */
  kill: () => Promise<void>
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const SIDECAR = path.join(REPO_ROOT, 'crates/freshell-claude-sidecar/index.mjs')
const SIMULATOR = path.join(REPO_ROOT, 'test/fixtures/claude-cli-sim/query.mjs')

export async function spawnKilroyRuntime(options: KilroyRuntimeOptions = {}): Promise<KilroyRuntime> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-h06-kilroy-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'workspace')
  const tmp = path.join(root, 'tmp')
  for (const directory of [home, cwd, tmp]) await fs.mkdir(directory, { recursive: true })
  const claudeConfigDir = path.join(home, '.claude')
  const ledgerPath = path.join(root, 'sim-ledger.jsonl')
  const proc = spawn(process.execPath, [SIDECAR], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '',
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: pathToFileURL(SIMULATOR).href,
      FRESHELL_CLAUDE_SIM_LEDGER: ledgerPath,
      FRESHELL_CLAUDE_SIM_TIME_SCALE: String(options.timeScale ?? 1),
      FRESHELL_CLAUDE_SIM_PROGRAM: JSON.stringify(options.program ?? { rules: [] }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }))
  })
  proc.stdin!.on('error', () => { /* an already-ended sidecar cannot accept another request */ })

  const events: Record<string, any>[] = []
  let cursor = 0
  const waiters: Array<{
    type: string
    pred?: (event: Record<string, any>) => boolean
    resolve: (event: Record<string, any>) => void
    timer: NodeJS.Timeout
  }> = []
  const rl = readline.createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    let event: Record<string, any>
    try { event = JSON.parse(line) } catch { return }
    events.push(event)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      const index = events.findIndex(
        (candidate, j) => j >= cursor && candidate.type === waiter.type && (!waiter.pred || waiter.pred(candidate)),
      )
      if (index >= 0) {
        cursor = index + 1
        waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(events[index])
      }
    }
  })
  let stderr = ''
  proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const waitExit = async (timeoutMs = 10_000) => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Kilroy sidecar did not exit: ${stderr.slice(-1000)}`)), timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  let cleanup: Promise<void> | undefined
  return {
    proc,
    cwd,
    claudeConfigDir,
    ledgerPath,
    send: (msg) => {
      if (!proc.stdin || proc.exitCode !== null || proc.signalCode !== null) throw new Error('Kilroy sidecar stdin unavailable')
      proc.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    nextEvent: (type, pred, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const existing = events.findIndex(
          (event, j) => j >= cursor && event.type === type && (!pred || pred(event)),
        )
        if (existing >= 0) {
          cursor = existing + 1
          resolve(events[existing])
          return
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`timed out waiting for Kilroy ${type}; frames=${JSON.stringify(events).slice(-3000)}; stderr=${stderr.slice(-1000)}`))
        }, timeoutMs)
        waiters.push({ type, pred, resolve, timer })
      }),
    events: () => events,
    waitExit,
    kill: () => cleanup ??= (async () => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.stdin!.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
          try { await waitExit(5_000) } catch {
            proc.kill('SIGKILL')
            await waitExit(5_000)
          }
        }
      } finally {
        rl.close()
        for (const waiter of waiters) clearTimeout(waiter.timer)
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    })(),
  }
}

/** What the actual SDK query and simulated CLI received, rather than synthetic wire requests. */
export async function readKilroyLedger(logPath: string): Promise<KilroyLedgerEntry[]> {
  let text: string
  try { text = await fs.readFile(logPath, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
