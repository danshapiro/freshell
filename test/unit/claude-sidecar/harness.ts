// startRealSidecar(): the production Claude sidecar
// (crates/freshell-claude-sidecar/index.mjs) running over the CLI simulator
// (test/fixtures/claude-cli-sim/query.mjs), plugged in through the sidecar's
// FRESHELL_CLAUDE_SDK_QUERY_MODULE seam. The simulator behaves like the pinned
// SDK and CLI (claude-cli-conformance.ts keeps it honest), so a test
// written against this harness exercises the sidecar the way production does:
// no init until a prompt (T1), lifecycle and replays, real result shapes.
//
// Each sidecar gets a throwaway HOME / CLAUDE_CONFIG_DIR / workspace and a
// clean environment (nothing from the caller's environment leaks in except
// PATH). What the SDK side received - the query() options, the boot, each
// prompt with the settings it ran under, each canUseTool answer - is read from
// the simulator's ledger (FRESHELL_CLAUDE_SIM_LEDGER). The process is killed
// and its directory removed when the calling test finishes.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../../..')
export const SIDECAR_INDEX = path.join(REPO_ROOT, 'crates/freshell-claude-sidecar/index.mjs')
export const CLI_SIMULATOR = path.join(REPO_ROOT, 'test/fixtures/claude-cli-sim/query.mjs')

const DEFAULT_TIMEOUT_MS = 10_000

/** The sidecar stdio protocol the harness speaks (crates/freshell-claude-sidecar/boot.mjs). */
export const SIDECAR_PROTOCOL = 2

export type SidecarFrame = Record<string, any>

/** One row of the simulator's ledger (see the header of test/fixtures/claude-cli-sim/query.mjs). */
export interface LedgerRow {
  t: number
  pid: number
  /** The ordinal of the query() call that wrote the row (1 = the first in this sidecar). */
  query: number
  kind: 'query' | 'boot' | 'prompt' | 'can_use_tool' | 'control' | 'emission' | string
  [key: string]: any
}

/** A prompt as the simulated CLI started it. */
export interface SimPrompt {
  /** Which query() (SDK session) of this sidecar ran it: 1 unless the sidecar re-created the query. */
  generation: number
  /** The CLI session id the prompt ran in. */
  durable: string
  uuid: string | null
  text: string
  content: unknown
  model: string
  effort: string | null
  permissionMode: string
}

export interface StartRealSidecarOptions {
  /** Extra environment for the sidecar, layered over the isolated base. */
  env?: Record<string, string>
  /** A simulator program (FRESHELL_CLAUDE_SIM_PROGRAM, see test/fixtures/claude-cli-sim/program.mjs). */
  program?: { rules: unknown[] }
  /** FRESHELL_CLAUDE_SIM_TIME_SCALE. Default 1: the simulator's recorded latencies. */
  timeScale?: number
  /** Run this script instead of index.mjs (a wrapper that imports index.mjs itself). */
  entry?: string
}

type Predicate = (frame: SidecarFrame) => boolean

/**
 * The server mints a uuid for every `send` it writes (protocol v2: the uuid
 * the CLI keeps for the command and its user line). The harness plays the
 * server, so a `send` written without a `uuid` key gets a fresh one; a test
 * that means to leave it out passes the key itself (for example `uuid: null`).
 */
function withSendUuid(message: object): object {
  const request = message as Record<string, unknown>
  return request.type === 'send' && !Object.hasOwn(request, 'uuid') ? { ...request, uuid: randomUUID() } : message
}

export interface RealSidecar {
  child: ChildProcess
  /** The isolated workspace: the default `cwd` of `create`. */
  cwd: string
  /** CLAUDE_CONFIG_DIR of the simulated CLI. */
  claudeConfigDir: string
  /** Every stdout frame so far, in arrival order. */
  frames: SidecarFrame[]
  stderr(): string
  /** Write one request line (a `send` without a `uuid` gets one, as the server mints it). */
  send(message: object): void
  /**
   * Write several request lines in ONE write. They reach the sidecar in one
   * stdin chunk, so it handles all of them before any promise continuation
   * runs (the SDK's input pump, for one, pulls its next message only after).
   */
  sendLines(messages: object[]): void
  /** The first frame (already seen or future) of this type or matching this predicate. */
  waitFor(match: string | Predicate, label?: string, timeoutMs?: number): Promise<SidecarFrame>
  /**
   * A protocol-v2 `create` (cwd defaults to the workspace, boot to a fresh
   * conversation) and its answer: `created` or `create.failed`.
   */
  requestCreate(fields?: Record<string, unknown>): Promise<SidecarFrame>
  /** `requestCreate`, which must be answered `created`; returns the session id. */
  create(fields?: Record<string, unknown>): Promise<string>
  /**
   * Resolve once the sidecar has read every line written so far: a line
   * written after this resolves arrives in a later stdin chunk. (A configure
   * with no settings, which changes nothing.)
   */
  barrier(sessionId: string): Promise<void>
  ledger(): LedgerRow[]
  waitForLedger(match: (row: LedgerRow, rows: LedgerRow[]) => boolean, label: string, timeoutMs?: number): Promise<LedgerRow>
  /** The simulated CLI finished booting (initializationResult would resolve). */
  waitForBoot(): Promise<LedgerRow>
  /** The `n`th prompt the simulated CLI started (1-based). */
  waitForPrompt(n?: number): Promise<SimPrompt>
  /** How the process exited (the listener is attached at spawn, so an early exit is never missed). */
  waitExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function describeWait(what: string, sidecar: { frames: SidecarFrame[]; stderr(): string }) {
  return `timed out waiting for ${what}; frames=${JSON.stringify(sidecar.frames).slice(-4000)}; stderr=${sidecar.stderr().slice(-1500)}`
}

export async function startRealSidecar(options: StartRealSidecarOptions = {}): Promise<RealSidecar> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-claude-sidecar-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'workspace')
  const tmp = path.join(root, 'tmp')
  for (const directory of [home, cwd, tmp]) fs.mkdirSync(directory, { recursive: true })
  const claudeConfigDir = path.join(home, '.claude')
  const ledgerFile = path.join(root, 'sim-ledger.jsonl')

  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    FRESHELL_CLAUDE_SDK_QUERY_MODULE: CLI_SIMULATOR,
    FRESHELL_CLAUDE_SIM_LEDGER: ledgerFile,
    FRESHELL_CLAUDE_SIM_TIME_SCALE: String(options.timeScale ?? 1),
    ...(options.program ? { FRESHELL_CLAUDE_SIM_PROGRAM: JSON.stringify(options.program) } : {}),
    ...options.env,
  }
  const child = spawn(process.execPath, [options.entry ?? SIDECAR_INDEX], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  child.stdin!.on('error', () => { /* the sidecar exited; a late write is moot */ })

  const frames: SidecarFrame[] = []
  const listeners = new Set<() => void>()
  let stderrText = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderrText += chunk })
  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.trim()) return
    let frame: SidecarFrame
    try { frame = JSON.parse(line) } catch { frame = { type: '<non-json stdout>', line } }
    frames.push(frame)
    for (const listener of [...listeners]) listener()
  })

  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  let requests = 0
  const stderr = () => stderrText
  const write = (messages: object[]) => {
    child.stdin!.write(messages.map((message) => `${JSON.stringify(withSendUuid(message))}\n`).join(''))
  }

  const waitFor = (match: string | Predicate, label?: string, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const predicate: Predicate = typeof match === 'string' ? (frame) => frame.type === match : match
    const what = label ?? (typeof match === 'string' ? match : 'a matching frame')
    return new Promise<SidecarFrame>((resolve, reject) => {
      const check = () => {
        const hit = frames.find(predicate)
        if (!hit) return false
        clearTimeout(timer)
        listeners.delete(onFrame)
        resolve(hit)
        return true
      }
      const onFrame = () => { check() }
      const timer = setTimeout(() => {
        listeners.delete(onFrame)
        reject(new Error(describeWait(what, sidecar)))
      }, timeoutMs)
      if (!check()) listeners.add(onFrame)
    })
  }

  const ledger = (): LedgerRow[] => {
    let text: string
    try { text = fs.readFileSync(ledgerFile, 'utf8') } catch { return [] }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1)
    return complete.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerRow)
  }

  const waitForLedger = async (match: (row: LedgerRow, rows: LedgerRow[]) => boolean, label: string, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const rows = ledger()
      const hit = rows.find((row) => match(row, rows))
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`${describeWait(`ledger row: ${label}`, sidecar)}; ledger=${JSON.stringify(rows).slice(-2000)}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const sidecar: RealSidecar = {
    child,
    cwd,
    claudeConfigDir,
    frames,
    stderr,
    send: (message) => write([message]),
    sendLines: (messages) => write(messages),
    waitFor,
    requestCreate(fields = {}) {
      const requestId = typeof fields.requestId === 'string' ? fields.requestId : `create-${++requests}`
      write([{ type: 'create', protocol: SIDECAR_PROTOCOL, boot: { kind: 'fresh' }, cwd, ...fields, requestId }])
      return waitFor((frame) => (frame.type === 'created' || frame.type === 'create.failed') && frame.requestId === requestId, `the answer to create ${requestId}`)
    },
    async create(fields = {}) {
      const answer = await sidecar.requestCreate(fields)
      if (answer.type !== 'created') throw new Error(`create ${answer.requestId} failed: ${JSON.stringify(answer)}`)
      return answer.sessionId as string
    },
    async barrier(sessionId) {
      const requestId = `barrier-${++requests}`
      write([{ type: 'configure', sessionId, requestId, settings: {} }])
      await waitFor((frame) => frame.type === 'sdk.configured' && frame.requestId === requestId, `barrier ${requestId}`)
    },
    ledger,
    waitForLedger,
    waitForBoot: () => waitForLedger((row) => row.kind === 'boot', 'boot'),
    async waitForPrompt(n = 1) {
      const row = await waitForLedger((candidate, rows) => candidate.kind === 'prompt' && rows.filter((r) => r.kind === 'prompt').indexOf(candidate) === n - 1, `prompt #${n}`)
      return {
        generation: row.query,
        durable: row.sessionId,
        uuid: row.uuid,
        text: row.text,
        content: row.content,
        model: row.model,
        effort: row.effort,
        permissionMode: row.permissionMode,
      }
    },
    waitExit(timeoutMs = DEFAULT_TIMEOUT_MS) {
      return Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the sidecar did not exit within ${timeoutMs} ms; stderr=${stderrText.slice(-800)}`)), timeoutMs).unref()),
      ])
    },
  }
  return sidecar
}
