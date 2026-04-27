import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import * as pty from 'node-pty'
import WebSocket, { WebSocketServer } from 'ws'

import { allocateLocalhostPort } from '../../../server/local-port.js'

const execFileAsync = promisify(execFile)
const NOTE_PATH = path.resolve(
  process.cwd(),
  'docs/lab-notes/2026-04-20-coding-cli-session-contract.md',
)

type NoteCleanupFacts = {
  liveProcessAuditCommand: string
  ownershipReportFields: string[]
  safeToStopRequires: string[]
  safeExamples: string[]
  unsafeExamples: string[]
}

type CodexFacts = {
  executable: string
  resolvedPath: string
  version: string
  freshRemoteBootstrapCommand: string
  freshRemoteBootstrapEventsBeforeUserTurn: string[]
  remoteResumeBootstrapStablePrefix: string[]
  remoteResumeBootstrapFollowupMethods: string[]
  freshRemoteAllocatesThreadBeforeUserTurn: boolean
  shellSnapshotGlob: string
  durableArtifactGlob: string
  freshInteractiveCreatesShellSnapshotBeforeTurn: boolean
  freshInteractiveCreatesDurableSessionBeforeTurn: boolean
  appServerThreadPathAvailableBeforeArtifact: boolean
  appServerMissingPathWatchAccepted: boolean
  appServerMissingParentWatchAccepted: boolean
  appServerWatchEchoesCallerWatchId: boolean
  appServerArtifactMaterializesAtReportedPath: boolean
  appServerChangedPathsMentionRolloutPath: boolean
  resumeCommandTemplate: string
  mutableNameSurface: 'absent'
}

type ClaudeFacts = {
  executable: string
  resolvedPath: string
  isolatedBinaryPath: string
  version: string
  exactIdCommandTemplate: string
  namedResumeCommandTemplate: string
  transcriptGlob: string
  canonicalIdentity: 'uuid-transcript'
  namedResumeWorksInPrintMode: boolean
  renameMutatesMetadataOnly: boolean
  oldTitleStopsResolvingAfterRename: boolean
  oldTitleErrorFragment: string
}

type OpencodeFacts = {
  executable: string
  resolvedPath: string
  version: string
  runCommandTemplate: string
  serveCommandTemplate: string
  globalHealthPath: string
  sessionStatusPath: string
  canonicalIdentity: 'session-id'
  runEventSessionIdMatchesDbId: boolean
  busyStatusUsesAuthoritativeSessionId: boolean
  titleOnResumeMutatesStoredTitle: boolean
  sessionSubcommands: string[]
}

export type CodingCliSessionContractNote = {
  capturedOn: string
  planCreatedOn: string
  dateReason: string
  cleanup: NoteCleanupFacts
  providers: {
    codex: CodexFacts
    claude: ClaudeFacts
    opencode: OpencodeFacts
  }
}

export type ResolvedProviderBinary = {
  executable: string
  resolvedPath: string | null
  version: string | null
}

type ProcessTreeRow = {
  pid: number
  ppid: number
  command: string
}

export type OwnershipReportEntry = {
  pid: number
  ppid: number
  cwd: string | null
  tempHome: string | null
  sentinelPath: string | null
  safeToStop: boolean
  command: string
}

export type CodexRpcNotification = {
  method: string
  params: any
}

export type CodexThreadHandle = {
  id: string
  path: string | null
  ephemeral: boolean
}

export type CodexFsChangedNotification = {
  watchId: string
  changedPaths: string[]
}

type TrackedRootHandle = {
  pid: number
  stop: () => Promise<void>
}

type PendingRpcRequest = {
  method: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

type ExitSummary = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type TrackedProcess = {
  pid: number
  stdout: () => string
  stderr: () => string
  stop: () => Promise<void>
  waitForExit: (timeoutMs?: number) => Promise<ExitSummary>
  child: ChildProcessWithoutNullStreams
}

export type TrackedPtyProcess = {
  pid: number
  output: () => string
  write: (chars: string) => void
  stop: () => Promise<void>
  waitForExit: (timeoutMs?: number) => Promise<ExitSummary>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value !== undefined) {
      return value
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label} within ${timeoutMs}ms.`)
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  if (!(await pathExists(rootDir))) {
    return []
  }

  const entries = await fsp.readdir(rootDir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(entryPath))
      continue
    }
    files.push(entryPath)
  }
  return files
}

async function waitForHttpJson(url: string, timeoutMs = 30_000): Promise<unknown> {
  return waitFor(`HTTP JSON at ${url}`, async () => {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        return undefined
      }
      return response.json()
    } catch {
      return undefined
    }
  }, timeoutMs, 200)
}

function parseJsonLines(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

async function readProcEnviron(pid: number): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`)
    return raw
      .toString('utf8')
      .split('\u0000')
      .filter((entry) => entry.length > 0)
      .reduce<Record<string, string>>((acc, entry) => {
        const separator = entry.indexOf('=')
        if (separator === -1) {
          return acc
        }
        acc[entry.slice(0, separator)] = entry.slice(separator + 1)
        return acc
      }, {})
  } catch {
    return {}
  }
}

async function readProcCwd(pid: number): Promise<string | null> {
  try {
    return await fsp.realpath(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

async function listProcesses(): Promise<ProcessTreeRow[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,cmd=', '--sort=pid'], {
    cwd: process.cwd(),
  })

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) {
        throw new Error(`Could not parse ps output row: ${line}`)
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      }
    })
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function killPid(pid: number, timeoutMs = 5_000): Promise<void> {
  if (!(await processExists(pid))) {
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {}

  const terminated = await waitFor(`pid ${pid} exit`, async () => {
    return (await processExists(pid)) ? undefined : true
  }, timeoutMs, 100).catch(() => false)

  if (terminated) {
    return
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {}

  await waitFor(`pid ${pid} forced exit`, async () => {
    return (await processExists(pid)) ? undefined : true
  }, timeoutMs, 100)
}

async function copyFileStrict(sourcePath: string, targetPath: string, label: string): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Missing required ${label} at ${sourcePath}.`)
  }
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  await fsp.copyFile(sourcePath, targetPath)
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Timed out running ${command} ${args.join(' ')} after ${timeoutMs}ms.`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout,
        stderr,
      })
    })
  })
}

export async function loadCodingCliSessionContractNote(): Promise<CodingCliSessionContractNote> {
  const markdown = await fsp.readFile(NOTE_PATH, 'utf8')
  const match = markdown.match(/## Machine-readable contract\s+```json\r?\n([\s\S]*?)\r?\n```/)
  if (!match) {
    throw new Error(`Could not find the machine-readable contract block in ${NOTE_PATH}.`)
  }
  return JSON.parse(match[1]) as CodingCliSessionContractNote
}

export async function readCodingCliSessionContractMarkdown(): Promise<string> {
  return fsp.readFile(NOTE_PATH, 'utf8')
}

export async function resolveProviderBinary(
  executable: string,
  versionArgs: string[] = ['--version'],
): Promise<ResolvedProviderBinary> {
  const resolution = await runCommand('bash', ['-lc', `command -v -- ${executable}`], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
  if (resolution.code !== 0) {
    return {
      executable,
      resolvedPath: null,
      version: null,
    }
  }

  const resolvedPath = resolution.stdout.trim().split(/\r?\n/)[0] ?? null
  if (!resolvedPath) {
    return {
      executable,
      resolvedPath: null,
      version: null,
    }
  }

  const versionResult = await runCommand(resolvedPath, versionArgs, {
    cwd: process.cwd(),
    timeoutMs: 15_000,
  })
  const version = `${versionResult.stdout}${versionResult.stderr}`.trim().split(/\r?\n/)[0] ?? null
  return {
    executable,
    resolvedPath,
    version,
  }
}

export async function resolveProviderBinaries(
  executables: readonly string[],
): Promise<Record<string, ResolvedProviderBinary>> {
  const entries = await Promise.all(
    executables.map(async (executable) => [executable, await resolveProviderBinary(executable)] as const),
  )
  return Object.fromEntries(entries)
}

export class ProbeWorkspace {
  readonly provider: string
  readonly tempRoot: string
  readonly sentinelPath: string

  private readonly trackedRoots: TrackedRootHandle[] = []

  private constructor(provider: string, tempRoot: string, sentinelPath: string) {
    this.provider = provider
    this.tempRoot = tempRoot
    this.sentinelPath = sentinelPath
  }

  static async create(provider: string): Promise<ProbeWorkspace> {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `freshell-${provider}-contract-`))
    const sentinelPath = path.join(tempRoot, 'probe-owned.json')
    const workspace = new ProbeWorkspace(provider, tempRoot, sentinelPath)

    await fsp.writeFile(
      sentinelPath,
      JSON.stringify(
        {
          provider,
          tempRoot,
          sentinelPath,
          createdAt: new Date().toISOString(),
          probeRunId: randomUUID(),
        },
        null,
        2,
      ),
      'utf8',
    )

    return workspace
  }

  taggedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      FRESHELL_PROBE_HOME: this.tempRoot,
      FRESHELL_PROBE_SENTINEL: this.sentinelPath,
      FRESHELL_PROBE_PROVIDER: this.provider,
      ...extra,
    }
  }

  inTemp(...segments: string[]): string {
    return path.join(this.tempRoot, ...segments)
  }

  async spawnProcess(
    command: string,
    args: string[],
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
    } = {},
  ): Promise<TrackedProcess> {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: this.taggedEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const waitForExit = (timeoutMs = 30_000) =>
      new Promise<ExitSummary>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for process ${command} (${child.pid}) to exit.`))
        }, timeoutMs)

        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearTimeout(timeout)
          resolve({
            code,
            signal,
          })
        })
      })

    const stop = async () => {
      if (child.pid === undefined) {
        return
      }
      await killPid(child.pid)
    }

    if (child.pid !== undefined) {
      this.trackedRoots.push({
        pid: child.pid,
        stop,
      })
    }

    return {
      pid: child.pid ?? -1,
      stdout: () => stdout,
      stderr: () => stderr,
      stop,
      waitForExit,
      child,
    }
  }

  spawnPty(
    command: string,
    args: string[],
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      cols?: number
      rows?: number
    } = {},
  ): TrackedPtyProcess {
    const processHandle = pty.spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: this.taggedEnv(options.env),
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      name: 'xterm-color',
    })

    let output = ''
    let exitSummary: ExitSummary | null = null
    const exitPromise = new Promise<ExitSummary>((resolve) => {
      processHandle.onData((chunk) => {
        output += chunk
      })
      processHandle.onExit(({ exitCode, signal }) => {
        exitSummary = {
          code: exitCode,
          signal: signal ? 'SIGTERM' : null,
        }
        resolve(exitSummary)
      })
    })

    const stop = async () => {
      processHandle.kill()
      await exitPromise.catch(() => undefined)
    }

    this.trackedRoots.push({
      pid: processHandle.pid,
      stop,
    })

    return {
      pid: processHandle.pid,
      output: () => output,
      write: (chars: string) => {
        processHandle.write(chars)
      },
      stop,
      waitForExit: async (timeoutMs = 30_000) => {
        return Promise.race([
          exitPromise,
          sleep(timeoutMs).then(() => {
            throw new Error(`Timed out waiting for PTY ${command} (${processHandle.pid}) to exit.`)
          }),
        ])
      },
    }
  }

  async buildOwnershipReport(): Promise<OwnershipReportEntry[]> {
    const processRows = await listProcesses()
    const processMap = new Map(processRows.map((row) => [row.pid, row]))
    const childrenByParent = new Map<number, number[]>()

    for (const row of processRows) {
      const siblings = childrenByParent.get(row.ppid) ?? []
      siblings.push(row.pid)
      childrenByParent.set(row.ppid, siblings)
    }

    const candidatePids = new Set<number>()
    const stack = this.trackedRoots
      .map((root) => root.pid)
      .filter((pid) => processMap.has(pid))

    while (stack.length > 0) {
      const pid = stack.pop()
      if (pid === undefined || candidatePids.has(pid)) {
        continue
      }
      candidatePids.add(pid)
      const children = childrenByParent.get(pid) ?? []
      for (const childPid of children) {
        stack.push(childPid)
      }
    }

    const report: OwnershipReportEntry[] = []
    for (const pid of [...candidatePids].sort((left, right) => left - right)) {
      const row = processMap.get(pid)
      if (!row) {
        continue
      }
      const cwd = await readProcCwd(pid)
      const environ = await readProcEnviron(pid)
      const tempHome = environ.FRESHELL_PROBE_HOME ?? null
      const sentinelPath = environ.FRESHELL_PROBE_SENTINEL ?? null
      report.push({
        pid,
        ppid: row.ppid,
        cwd,
        tempHome,
        sentinelPath,
        safeToStop: tempHome === this.tempRoot && sentinelPath === this.sentinelPath,
        command: row.command,
      })
    }

    return report
  }

  async cleanup(): Promise<OwnershipReportEntry[]> {
    const report = await this.buildOwnershipReport()
    const unsafe = report.filter((entry) => !entry.safeToStop)
    if (unsafe.length > 0) {
      const rendered = unsafe
        .map((entry) => JSON.stringify(entry))
        .join('\n')
      throw new Error(`Refusing cleanup because one or more candidate processes are not probe-owned.\n${rendered}`)
    }

    const livePids = report.map((entry) => entry.pid).sort((left, right) => right - left)
    for (const pid of livePids) {
      await killPid(pid).catch(() => undefined)
    }

    await fsp.rm(this.tempRoot, { recursive: true, force: true })
    return report
  }
}

export async function seedCodexHome(workspace: ProbeWorkspace): Promise<string> {
  const codexHome = workspace.inTemp('.codex')
  await copyFileStrict(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'), 'Codex auth.json')
  await copyFileStrict(path.join(os.homedir(), '.codex', 'config.toml'), path.join(codexHome, 'config.toml'), 'Codex config.toml')
  return codexHome
}

export async function seedClaudeHome(workspace: ProbeWorkspace): Promise<string> {
  const homeRoot = workspace.tempRoot
  await copyFileStrict(
    path.join(os.homedir(), '.claude', '.credentials.json'),
    path.join(homeRoot, '.claude', '.credentials.json'),
    'Claude .credentials.json',
  )
  return homeRoot
}

export async function seedOpencodeHomes(workspace: ProbeWorkspace): Promise<{
  dataHome: string
  configHome: string
  dbPath: string
}> {
  const dataHome = workspace.inTemp('.local', 'share')
  const configHome = workspace.inTemp('.config')
  await fsp.mkdir(path.join(dataHome, 'opencode'), { recursive: true })
  await fsp.mkdir(path.join(configHome, 'opencode'), { recursive: true })
  return {
    dataHome,
    configHome,
    dbPath: path.join(dataHome, 'opencode', 'opencode.db'),
  }
}

export async function findCodexShellSnapshots(workspace: ProbeWorkspace): Promise<string[]> {
  const snapshotRoot = workspace.inTemp('.codex', 'shell_snapshots')
  const files = await listFilesRecursive(snapshotRoot)
  return files.filter((filePath) => filePath.endsWith('.sh'))
}

export async function findCodexSessionArtifacts(workspace: ProbeWorkspace): Promise<string[]> {
  const sessionsRoot = workspace.inTemp('.codex', 'sessions')
  const files = await listFilesRecursive(sessionsRoot)
  return files.filter((filePath) => filePath.endsWith('.jsonl'))
}

export async function waitForCodexShellSnapshot(workspace: ProbeWorkspace): Promise<string> {
  return waitFor('Codex shell snapshot', async () => {
    const files = await findCodexShellSnapshots(workspace)
    return files[0]
  }, 30_000, 250)
}

export async function waitForCodexSessionArtifact(workspace: ProbeWorkspace): Promise<string> {
  return waitFor('Codex durable session artifact', async () => {
    const files = await findCodexSessionArtifacts(workspace)
    return files[0]
  }, 60_000, 250)
}

export function extractCodexResumeId(artifactPath: string): string {
  const match = path.basename(artifactPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
  if (!match) {
    throw new Error(`Could not extract a Codex resume id from ${artifactPath}.`)
  }
  return match[1]
}

export async function startCodexAppServer(
  workspace: ProbeWorkspace,
  codexPath: string,
): Promise<{
  wsUrl: string
  process: TrackedProcess
}> {
  const endpoint = await allocateLocalhostPort()
  const wsUrl = `ws://${endpoint.hostname}:${endpoint.port}`
  const processHandle = await workspace.spawnProcess(codexPath, ['app-server', '--listen', wsUrl], {
    env: {
      CODEX_HOME: workspace.inTemp('.codex'),
    },
  })

  await waitFor(`Codex app-server websocket ${wsUrl}`, async () => {
    const stderr = processHandle.stderr()
    if (stderr.includes('EADDRINUSE')) {
      throw new Error(`Codex app-server could not bind ${wsUrl}: ${stderr}`)
    }

    return new Promise<boolean | undefined>((resolve) => {
      const socket = new WebSocket(wsUrl)
      const cleanup = () => {
        socket.removeAllListeners()
      }
      socket.once('open', () => {
        cleanup()
        socket.close()
        resolve(true)
      })
      socket.once('error', () => {
        cleanup()
        resolve(undefined)
      })
    })
  }, 30_000, 200)

  await sleep(500)
  return {
    wsUrl,
    process: processHandle,
  }
}

export class CodexRpcProbeClient {
  private readonly socket: WebSocket
  private readonly pendingRequests = new Map<number, PendingRpcRequest>()
  private readonly notifications: CodexRpcNotification[] = []
  private nextRequestId = 1

  private constructor(socket: WebSocket) {
    this.socket = socket
    this.socket.on('message', (raw) => this.handleMessage(raw))
    this.socket.on('close', () => this.handleClose())
    this.socket.on('error', () => this.handleClose())
  }

  static async connect(wsUrl: string): Promise<CodexRpcProbeClient> {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const connection = new WebSocket(wsUrl)
      const cleanup = () => {
        connection.off('error', onError)
        connection.off('open', onOpen)
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onOpen = () => {
        cleanup()
        resolve(connection)
      }
      connection.once('error', onError)
      connection.once('open', onOpen)
    })

    return new CodexRpcProbeClient(socket)
  }

  async initialize(): Promise<any> {
    return this.request('initialize', {
      clientInfo: { name: 'freshell-contract-probe', version: '1.0.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['thread/started'],
      },
    })
  }

  async startThread(cwd: string): Promise<any> {
    return this.request('thread/start', {
      cwd,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })
  }

  async resumeThread(threadId: string, cwd: string): Promise<any> {
    return this.request('thread/resume', {
      threadId,
      cwd,
      persistExtendedHistory: true,
    })
  }

  async fsWatch(targetPath: string, watchId: string): Promise<{ path: string }> {
    return this.request('fs/watch', {
      path: targetPath,
      watchId,
    })
  }

  async fsUnwatch(watchId: string): Promise<void> {
    await this.request('fs/unwatch', {
      watchId,
    })
  }

  async startTurn(threadId: string, text: string): Promise<any> {
    return this.request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text,
        },
      ],
    })
  }

  async waitForNotification(
    method: string,
    predicate: (notification: CodexRpcNotification) => boolean = () => true,
    timeoutMs = 60_000,
  ): Promise<CodexRpcNotification> {
    return waitFor(`Codex notification ${method}`, () => {
      return this.notifications.find((notification) => (
        notification.method === method && predicate(notification)
      ))
    }, timeoutMs, 100)
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex websocket closed before ${pending.method} completed.`))
    }
    this.pendingRequests.clear()

    await new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }

  private async request(method: string, params: any, timeoutMs = 30_000): Promise<any> {
    const id = this.nextRequestId
    this.nextRequestId += 1

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Timed out waiting for Codex RPC ${method}.`))
      }, timeoutMs)

      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeout,
      })

      this.socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }))
    })
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let message: any
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id)
      if (!pending) {
        return
      }
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(message.id)
      if (message.error) {
        pending.reject(new Error(`Codex RPC ${pending.method} failed: ${JSON.stringify(message.error)}`))
        return
      }
      pending.resolve(message.result)
      return
    }

    if (typeof message.method === 'string') {
      this.notifications.push({
        method: message.method,
        params: message.params ?? null,
      })
    }
  }

  private handleClose(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex websocket closed before ${pending.method} completed.`))
    }
    this.pendingRequests.clear()
  }
}

export async function captureCodexBootstrapEvents(
  workspace: ProbeWorkspace,
  codexPath: string,
): Promise<string[]> {
  const endpoint = await allocateLocalhostPort()
  const events: string[] = ['connection']
  const wss = new WebSocketServer({
    host: endpoint.hostname,
    port: endpoint.port,
  })

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as {
        id?: number
        method?: string
        params?: unknown
      }
      if (message.method) {
        events.push(message.method)
      }

      if (message.id === undefined || !message.method) {
        return
      }

      const sendResult = (result: unknown) => {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result,
        }))
      }

      if (message.method === 'initialize') {
        sendResult({
          userAgent: 'freshell-contract-probe/1.0.0',
          codexHome: workspace.inTemp('.codex'),
          platformFamily: 'unix',
          platformOs: process.platform,
        })
        return
      }

      if (message.method === 'account/read') {
        sendResult({
          requiresOpenaiAuth: false,
          account: {
            type: 'chatgpt',
            email: 'probe@example.com',
            planType: 'plus',
          },
        })
        return
      }

      if (message.method === 'model/list') {
        sendResult({
          data: [
            {
              id: 'gpt-5-codex',
              model: 'gpt-5-codex',
              displayName: 'GPT-5 Codex',
              description: 'Probe model',
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: 'high',
              supportedReasoningEfforts: [
                {
                  reasoningEffort: 'minimal',
                  description: 'Minimal reasoning',
                },
                {
                  reasoningEffort: 'high',
                  description: 'High reasoning',
                },
              ],
              inputModalities: ['text', 'image'],
              additionalSpeedTiers: [],
              supportsPersonality: false,
              availabilityNux: null,
              upgrade: null,
              upgradeInfo: null,
            },
          ],
          nextCursor: null,
        })
        return
      }

      if (message.method === 'thread/start') {
        sendResult({
          thread: {
            id: 'thread-bootstrap-1',
          },
          cwd: process.cwd(),
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          instructionSources: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: {
            type: 'dangerFullAccess',
          },
        })
      }
    })
  })

  const remote = workspace.spawnPty(codexPath, ['--remote', `ws://${endpoint.hostname}:${endpoint.port}`, '--no-alt-screen'], {
    env: {
      CODEX_HOME: workspace.inTemp('.codex'),
    },
  })

  try {
    await waitFor('Codex bootstrap thread/start', async () => {
      return events.includes('thread/start') ? true : undefined
    }, 30_000, 100)
    return [...events]
  } finally {
    await remote.stop().catch(() => undefined)
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}

export async function captureCodexResumeBootstrapEvents(
  workspace: ProbeWorkspace,
  codexPath: string,
  resumeId: string,
): Promise<string[]> {
  const upstream = await startCodexAppServer(workspace, codexPath)
  const endpoint = await allocateLocalhostPort()
  const proxyUrl = `ws://${endpoint.hostname}:${endpoint.port}`
  const events: string[] = ['connection']
  const wss = new WebSocketServer({
    host: endpoint.hostname,
    port: endpoint.port,
  })

  wss.on('connection', (client) => {
    const upstreamSocket = new WebSocket(upstream.wsUrl)
    const pendingMessages: string[] = []

    const flushPending = () => {
      while (pendingMessages.length > 0 && upstreamSocket.readyState === WebSocket.OPEN) {
        const message = pendingMessages.shift()
        if (message) {
          upstreamSocket.send(message)
        }
      }
    }

    client.on('message', (raw) => {
      const serialized = raw.toString()
      try {
        const message = JSON.parse(serialized)
        if (typeof message.method === 'string') {
          events.push(message.method)
        }
      } catch {}

      if (upstreamSocket.readyState === WebSocket.OPEN) {
        upstreamSocket.send(serialized)
        return
      }
      pendingMessages.push(serialized)
    })

    upstreamSocket.on('open', flushPending)
    upstreamSocket.on('message', (raw) => {
      client.send(raw.toString())
    })
    client.on('close', () => {
      upstreamSocket.close()
    })
    upstreamSocket.on('close', () => {
      client.close()
    })
  })

  const remote = workspace.spawnPty(
    codexPath,
    ['--remote', proxyUrl, '--no-alt-screen', 'resume', resumeId],
    {
      env: {
        CODEX_HOME: workspace.inTemp('.codex'),
      },
    },
  )

  try {
    await waitFor('Codex bootstrap thread/resume', async () => {
      return events.includes('thread/resume') ? true : undefined
    }, 60_000, 100)
    await sleep(2_000)
    return [...events]
  } finally {
    await remote.stop().catch(() => undefined)
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await upstream.process.stop().catch(() => undefined)
  }
}

export async function findClaudeTranscript(
  workspace: ProbeWorkspace,
  sessionId: string,
): Promise<string> {
  return waitFor(`Claude transcript ${sessionId}`, async () => {
    const files = await listFilesRecursive(workspace.inTemp('.claude', 'projects'))
    return files.find((filePath) => filePath.endsWith(`${sessionId}.jsonl`))
  }, 30_000, 200)
}

export async function readClaudeTranscriptLines(transcriptPath: string): Promise<string[]> {
  return (await fsp.readFile(transcriptPath, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
}

export function queryOpencodeSessionRow(dbPath: string, sessionId: string): {
  id: string
  title: string
  directory: string
} | null {
  const database = new DatabaseSync(dbPath)
  try {
    return database
      .prepare('select id, title, directory from session where id = ? limit 1')
      .get(sessionId) as {
        id: string
        title: string
        directory: string
      } | null
  } finally {
    database.close()
  }
}

export async function waitForOpencodeDbSession(dbPath: string, sessionId: string): Promise<{
  id: string
  title: string
  directory: string
}> {
  return waitFor(`OpenCode DB row ${sessionId}`, async () => {
    if (!(await pathExists(dbPath))) {
      return undefined
    }
    return queryOpencodeSessionRow(dbPath, sessionId) ?? undefined
  }, 30_000, 250)
}

export async function waitForJsonLine(
  processHandle: TrackedProcess,
  predicate: (value: any) => boolean,
  timeoutMs = 30_000,
): Promise<any> {
  return waitFor('JSON line output', async () => {
    const lines = parseJsonLines(processHandle.stdout())
    return lines.find(predicate)
  }, timeoutMs, 100)
}

export async function waitForSubstring(
  readText: () => string,
  needle: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitFor(`substring ${needle}`, () => {
    return readText().includes(needle) ? true : undefined
  }, timeoutMs, 100)
}

export async function waitForFileSizeIncrease(filePath: string, previousSize: number, timeoutMs = 30_000): Promise<number> {
  const stat = await waitFor(`file size increase for ${filePath}`, async () => {
    if (!(await pathExists(filePath))) {
      return undefined
    }
    const current = await fsp.stat(filePath)
    return current.size > previousSize ? current.size : undefined
  }, timeoutMs, 200)
  return stat
}

export async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Expected a successful response from ${url}, received ${response.status}.`)
  }
  return response.json()
}

export async function waitForHttpBusyStatus(url: string, sessionId: string): Promise<Record<string, { type: string }>> {
  return waitFor(`OpenCode busy status for ${sessionId}`, async () => {
    const payload = await fetchJson(url).catch(() => undefined)
    if (!payload || typeof payload !== 'object') {
      return undefined
    }
    const record = payload as Record<string, { type: string }>
    return record[sessionId]?.type === 'busy' ? record : undefined
  }, 30_000, 200)
}

export async function waitForAnyHttpBusyStatus(
  url: string,
): Promise<{ sessionId: string; payload: Record<string, { type: string }> }> {
  return waitFor('OpenCode busy status', async () => {
    const payload = await fetchJson(url).catch(() => undefined)
    if (!payload || typeof payload !== 'object') {
      return undefined
    }
    const record = payload as Record<string, { type: string }>
    const match = Object.entries(record).find(([, status]) => status?.type === 'busy')
    if (!match) return undefined
    return {
      sessionId: match[0],
      payload: record,
    }
  }, 30_000, 200)
}

export async function waitForHttpHealthy(url: string): Promise<any> {
  return waitForHttpJson(url, 30_000)
}
