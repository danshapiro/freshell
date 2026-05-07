import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../local-port.js'
import { logger } from '../../logger.js'
import { convertWindowsPathToWslPath, isWslEnvironment, sanitizeUserPathInput } from '../../path-utils.js'
import { CodexAppServerClient, type CodexAppServerDisconnectEvent, type CodexThreadLifecycleEvent } from './client.js'
import type {
  CodexFsWatchResult,
  CodexInitializeResult,
  CodexThreadHandle,
  CodexThreadOperationResult,
  CodexThreadResumeParams,
  CodexThreadStartParams,
} from './protocol.js'

type RuntimeStatus = 'running' | 'stopped'
export type CodexAppServerRuntimeFailureSource =
  | 'app_server_exit'
  | 'app_server_client_disconnect'

type WrapperIdentity = {
  commandLine: string[]
  cwd: string | null
  startTimeTicks: number | null
}

export type CodexSidecarOwnershipMetadata = {
  schemaVersion: 1
  ownershipId: string
  serverInstanceId: string
  ownerServerPid: number
  terminalId: string | null
  generation: number | null
  wsUrl: string
  wrapperPid: number
  processGroupId: number
  wrapperIdentity: WrapperIdentity
  createdAt: string
  updatedAt: string
  codexHome?: string
}

type ReadyState = {
  wsUrl: string
  processPid: number
  codexHome: string
  ownershipId: string
  processGroupId: number
  metadataPath: string
}

type ActiveOwnership = {
  metadataDir: string
  metadataPath: string
  metadata: CodexSidecarOwnershipMetadata
}

type RuntimeOptions = {
  command?: string
  commandArgs?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  startupAttemptLimit?: number
  startupAttemptTimeoutMs?: number
  terminateGraceMs?: number
  portAllocator?: () => Promise<LoopbackServerEndpoint>
  metadataDir?: string
  serverInstanceId?: string
  ownershipIdFactory?: () => string
  metadataWriter?: (filePath: string, metadata: CodexSidecarOwnershipMetadata) => Promise<void>
  processIdentityReader?: (pid: number) => Promise<WrapperIdentity | null>
}

export type ReapOrphanedSidecarsResult = {
  scanned: number
  reapedOwnershipIds: string[]
  skippedActiveOwnershipIds: string[]
  ignoredLegacyRecords: string[]
  failedOwnershipIds: string[]
}

type ReapOrphanedSidecarsOptions = {
  metadataDir?: string
  serverInstanceId?: string
  terminateGraceMs?: number
}

const DEFAULT_STARTUP_ATTEMPT_LIMIT = 2
const DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS = 3_000
const DEFAULT_TERMINATE_GRACE_MS = 1_000
const STARTUP_POLL_MS = 50
const OUTPUT_TAIL_MAX_CHARS = 4 * 1024
const OUTPUT_TAIL_MAX_LINES = 40
const OWNERSHIP_SCHEMA_VERSION = 1

export const DEFAULT_CODEX_SIDECAR_METADATA_DIR = path.join(os.tmpdir(), 'freshell-codex-sidecars')

class BoundedOutputTail {
  private value = ''

  push(chunk: Buffer | string): void {
    this.value += chunk.toString()
    const lines = this.value.split(/\r?\n/)
    if (lines.length > OUTPUT_TAIL_MAX_LINES) {
      this.value = lines.slice(-OUTPUT_TAIL_MAX_LINES).join('\n')
    }
    if (this.value.length > OUTPUT_TAIL_MAX_CHARS) {
      this.value = this.value.slice(-OUTPUT_TAIL_MAX_CHARS)
    }
  }

  snapshot(): string {
    return this.value
  }
}

type RuntimeChildDiagnostics = {
  wsUrl: string
  wsPort: number
  startedAt: number
  stdoutTail: BoundedOutputTail
  stderrTail: BoundedOutputTail
  processError?: Error
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultMetadataDir(): string {
  return process.env.FRESHELL_CODEX_SIDECAR_DIR || DEFAULT_CODEX_SIDECAR_METADATA_DIR
}

function resolveAppServerCwd(cwd: string | undefined): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const candidate = sanitizeUserPathInput(cwd)
  if (!candidate) return undefined
  if (isWslEnvironment()) {
    return convertWindowsPathToWslPath(candidate) ?? candidate
  }
  return candidate
}

function assertUnixSidecarSupport(): void {
  if (process.platform !== 'linux') {
    throw new Error('Codex app-server sidecar process-group ownership requires Linux /proc support.')
  }
}

async function assertProcOwnershipProofAvailable(): Promise<void> {
  assertUnixSidecarSupport()
  let entries: string[]
  try {
    entries = await fsp.readdir('/proc')
  } catch (error) {
    throw new Error(
      `Codex app-server sidecar requires readable Linux /proc ownership proof; failed to read /proc: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!entries.some((entry) => /^\d+$/.test(entry))) {
    throw new Error('Codex app-server sidecar requires readable Linux /proc ownership proof with process entries.')
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fsp.rename(tmpPath, filePath)
}

function parseProcStat(stat: string): { pgrp: number; startTimeTicks: number } | null {
  const closeParen = stat.lastIndexOf(')')
  if (closeParen === -1) return null
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
  const pgrp = Number(fields[2])
  const startTimeTicks = Number(fields[19])
  if (!Number.isInteger(pgrp) || !Number.isFinite(startTimeTicks)) return null
  return { pgrp, startTimeTicks }
}

async function getProcessGroupId(pid: number | 'self'): Promise<number | null> {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8')
    return parseProcStat(stat)?.pgrp ?? null
  } catch {
    return null
  }
}

async function readProcessIdentity(pid: number): Promise<WrapperIdentity | null> {
  try {
    const [cmdline, cwd, stat] = await Promise.all([
      fsp.readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.from('')),
      fsp.readlink(`/proc/${pid}/cwd`).catch(() => null),
      fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const parsed = parseProcStat(stat)
    const identity = {
      commandLine: cmdline.toString('utf8').split('\0').filter(Boolean),
      cwd,
      startTimeTicks: parsed?.startTimeTicks ?? null,
    }
    return isCompleteWrapperIdentity(identity) ? identity : null
  } catch {
    return null
  }
}

function isCompleteWrapperIdentity(identity: WrapperIdentity | null): identity is WrapperIdentity {
  return !!identity
    && identity.commandLine.length > 0
    && typeof identity.cwd === 'string'
    && identity.cwd.length > 0
    && typeof identity.startTimeTicks === 'number'
    && Number.isFinite(identity.startTimeTicks)
}

function wrapperIdentityMatches(record: CodexSidecarOwnershipMetadata, current: WrapperIdentity | null): boolean {
  if (!current) return false
  const expected = record.wrapperIdentity
  if (expected.startTimeTicks === null || current.startTimeTicks === null) return false
  if (expected.startTimeTicks !== current.startTimeTicks) return false
  if (expected.cwd === null || current.cwd === null || expected.cwd !== current.cwd) return false
  if (expected.commandLine.length === 0 || expected.commandLine.length !== current.commandLine.length) return false
  return expected.commandLine.every((arg, index) => arg === current.commandLine[index])
}

function emptyWrapperIdentity(): WrapperIdentity {
  return {
    commandLine: [],
    cwd: null,
    startTimeTicks: null,
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function processHasOwnershipEnv(pid: number, ownershipId: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`)
    return raw.toString('utf8').split('\0').includes(`FRESHELL_CODEX_SIDECAR_ID=${ownershipId}`)
  } catch {
    return false
  }
}

async function processGroupMembers(processGroupId: number): Promise<number[]> {
  const entries = await fsp.readdir('/proc')
  const members: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const pgrp = await getProcessGroupId(pid)
    if (pgrp === processGroupId) members.push(pid)
  }
  return members
}

async function isProcessGroupGone(processGroupId: number): Promise<boolean> {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return true
  try {
    process.kill(-processGroupId, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function verifyOwnedProcessGroup(metadata: CodexSidecarOwnershipMetadata): Promise<boolean> {
  if (await isProcessGroupGone(metadata.processGroupId)) return true

  const currentProcessGroupId = await getProcessGroupId('self')
  if (currentProcessGroupId !== null && metadata.processGroupId === currentProcessGroupId) {
    return false
  }

  const wrapperProcessGroupId = await getProcessGroupId(metadata.wrapperPid)
  if (wrapperProcessGroupId === metadata.processGroupId) {
    const currentWrapperIdentity = await readProcessIdentity(metadata.wrapperPid)
    if (wrapperIdentityMatches(metadata, currentWrapperIdentity)) {
      return true
    }
  }

  const members = await processGroupMembers(metadata.processGroupId)
  for (const pid of members) {
    if (await processHasOwnershipEnv(pid, metadata.ownershipId)) {
      return true
    }
  }
  return false
}

function hasRecordedWrapperProof(metadata: CodexSidecarOwnershipMetadata): boolean {
  return metadata.wrapperIdentity.commandLine.length > 0
    && typeof metadata.wrapperIdentity.cwd === 'string'
    && metadata.wrapperIdentity.cwd.length > 0
    && typeof metadata.wrapperIdentity.startTimeTicks === 'number'
    && Number.isFinite(metadata.wrapperIdentity.startTimeTicks)
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error
    }
  }
}

async function waitForProcessGroupGone(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isProcessGroupGone(processGroupId)) return true
    await sleep(25)
  }
  return isProcessGroupGone(processGroupId)
}

async function teardownOwnedProcessGroup(
  ownership: ActiveOwnership,
  terminateGraceMs: number,
  options: { activeOwner?: boolean } = {},
): Promise<boolean> {
  const { metadata } = ownership
  const verified = await verifyOwnedProcessGroup(metadata)
    || (options.activeOwner === true
      && hasRecordedWrapperProof(metadata)
      && (await getProcessGroupId('self')) !== metadata.processGroupId)
  if (!verified) {
    logger.warn(
      {
        ownershipId: metadata.ownershipId,
        terminalId: metadata.terminalId,
        generation: metadata.generation,
        wsUrl: metadata.wsUrl,
        wrapperPid: metadata.wrapperPid,
        processGroupId: metadata.processGroupId,
        serverInstanceId: metadata.serverInstanceId,
      },
      'Refusing to tear down Codex app-server sidecar because ownership could not be verified',
    )
    return false
  }

  if (!(await isProcessGroupGone(metadata.processGroupId))) {
    signalProcessGroup(metadata.processGroupId, 'SIGTERM')
  }
  if (!(await waitForProcessGroupGone(metadata.processGroupId, terminateGraceMs))) {
    const stillVerified = await verifyOwnedProcessGroup(metadata)
      || (options.activeOwner === true
        && hasRecordedWrapperProof(metadata)
        && (await getProcessGroupId('self')) !== metadata.processGroupId)
    if (!stillVerified) {
      logger.warn(
        {
          ownershipId: metadata.ownershipId,
          terminalId: metadata.terminalId,
          generation: metadata.generation,
          wsUrl: metadata.wsUrl,
          wrapperPid: metadata.wrapperPid,
          processGroupId: metadata.processGroupId,
          serverInstanceId: metadata.serverInstanceId,
        },
        'Refusing SIGKILL for Codex app-server sidecar because ownership changed during shutdown',
      )
      return false
    }
    signalProcessGroup(metadata.processGroupId, 'SIGKILL')
  }

  const gone = await waitForProcessGroupGone(metadata.processGroupId, terminateGraceMs)
  if (!gone) {
    logger.warn(
      {
        ownershipId: metadata.ownershipId,
        terminalId: metadata.terminalId,
        generation: metadata.generation,
        wsUrl: metadata.wsUrl,
        wrapperPid: metadata.wrapperPid,
        processGroupId: metadata.processGroupId,
        serverInstanceId: metadata.serverInstanceId,
        remainingPids: await processGroupMembers(metadata.processGroupId),
      },
      'Codex app-server sidecar process group did not exit after SIGKILL',
    )
    return false
  }

  await fsp.unlink(ownership.metadataPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  })
  return true
}

type ParsedMetadataRecord =
  | { kind: 'valid'; metadata: CodexSidecarOwnershipMetadata }
  | { kind: 'legacy' }
  | { kind: 'malformedNewSchema'; ownershipId: string }

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function parseMetadataRecord(raw: string, metadataPath: string): ParsedMetadataRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'legacy' }
  }

  if (!parsed || typeof parsed !== 'object') return { kind: 'legacy' }
  const candidate = parsed as Partial<CodexSidecarOwnershipMetadata>
  if (candidate.schemaVersion !== OWNERSHIP_SCHEMA_VERSION) return { kind: 'legacy' }

  const ownershipId = typeof candidate.ownershipId === 'string' ? candidate.ownershipId : metadataPath
  if (
    typeof candidate.ownershipId !== 'string'
    || typeof candidate.serverInstanceId !== 'string'
    || !isPositiveInteger(candidate.ownerServerPid)
    || typeof candidate.wsUrl !== 'string'
    || !isPositiveInteger(candidate.wrapperPid)
    || !isPositiveInteger(candidate.processGroupId)
    || !candidate.wrapperIdentity
    || typeof candidate.createdAt !== 'string'
    || typeof candidate.updatedAt !== 'string'
  ) {
    return { kind: 'malformedNewSchema', ownershipId }
  }
  return { kind: 'valid', metadata: candidate as CodexSidecarOwnershipMetadata }
}

export async function reapOrphanedCodexAppServerSidecars(
  options: ReapOrphanedSidecarsOptions = {},
): Promise<ReapOrphanedSidecarsResult> {
  assertUnixSidecarSupport()
  const metadataDir = options.metadataDir ?? defaultMetadataDir()
  const result: ReapOrphanedSidecarsResult = {
    scanned: 0,
    reapedOwnershipIds: [],
    skippedActiveOwnershipIds: [],
    ignoredLegacyRecords: [],
    failedOwnershipIds: [],
  }

  const entries = await fsp.readdir(metadataDir).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  })

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    result.scanned += 1
    const metadataPath = path.join(metadataDir, entry)
    const raw = await fsp.readFile(metadataPath, 'utf8')
    const parsed = parseMetadataRecord(raw, metadataPath)
    if (parsed.kind === 'legacy') {
      result.ignoredLegacyRecords.push(metadataPath)
      await fsp.unlink(metadataPath).catch(() => undefined)
      continue
    }
    if (parsed.kind === 'malformedNewSchema') {
      result.failedOwnershipIds.push(parsed.ownershipId)
      continue
    }

    const metadata = parsed.metadata
    if (await isPidAlive(metadata.ownerServerPid)) {
      result.skippedActiveOwnershipIds.push(metadata.ownershipId)
      continue
    }

    const currentProcessGroupId = await getProcessGroupId('self')
    if (currentProcessGroupId !== null && metadata.processGroupId === currentProcessGroupId) {
      result.skippedActiveOwnershipIds.push(metadata.ownershipId)
      continue
    }

    const ownership: ActiveOwnership = { metadataDir, metadataPath, metadata }
    const reaped = await teardownOwnedProcessGroup(ownership, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS)
    if (reaped) {
      result.reapedOwnershipIds.push(metadata.ownershipId)
    } else {
      result.failedOwnershipIds.push(metadata.ownershipId)
    }
  }

  return result
}

export async function reapOrphanedCodexAppServerSidecarsOnStartup(
  options: ReapOrphanedSidecarsOptions = {},
): Promise<ReapOrphanedSidecarsResult> {
  const result = await reapOrphanedCodexAppServerSidecars(options)
  const blockedOwnershipIds = result.failedOwnershipIds
  if (blockedOwnershipIds.length === 0) return result

  throw new Error(
    `Codex app-server startup reaper failed to reap ${blockedOwnershipIds.length} ownership record(s): ${blockedOwnershipIds.join(', ')}. `
    + 'Refusing to continue until the unreaped Codex sidecar ownership is verified gone or handled explicitly.',
  )
}

export const runCodexStartupReaper = reapOrphanedCodexAppServerSidecarsOnStartup

export class CodexAppServerRuntime {
  private child: ChildProcess | null = null
  private childDiagnostics: RuntimeChildDiagnostics | null = null
  private client: CodexAppServerClient | null = null
  private ready: ReadyState | null = null
  private ensureReadyPromise: Promise<ReadyState> | null = null
  private statusValue: RuntimeStatus = 'stopped'
  private ownership: ActiveOwnership | null = null
  private ownershipTeardownPromise: Promise<void> | null = null
  private ownershipTeardownFailure: Error | null = null
  private shutdownRequested = false
  private readonly exitHandlers = new Set<(error?: Error, source?: CodexAppServerRuntimeFailureSource) => void>()
  private readonly threadStartedHandlers = new Set<(thread: CodexThreadHandle) => void>()
  private readonly threadLifecycleHandlers = new Set<(event: CodexThreadLifecycleEvent) => void>()
  private readonly fsChangedHandlers = new Set<(event: { watchId: string; changedPaths: string[] }) => void>()

  private readonly command: string
  private readonly commandArgs: string[]
  private readonly cwd?: string
  private readonly env?: NodeJS.ProcessEnv
  private readonly requestTimeoutMs?: number
  private readonly startupAttemptLimit: number
  private readonly startupAttemptTimeoutMs: number
  private readonly terminateGraceMs: number
  private readonly portAllocator: () => Promise<LoopbackServerEndpoint>
  private readonly metadataDir: string
  private readonly serverInstanceId: string
  private readonly ownershipIdFactory: () => string
  private readonly metadataWriter: (filePath: string, metadata: CodexSidecarOwnershipMetadata) => Promise<void>
  private readonly processIdentityReader: (pid: number) => Promise<WrapperIdentity | null>

  constructor(options: RuntimeOptions = {}) {
    this.command = options.command ?? (process.env.CODEX_CMD || 'codex')
    this.commandArgs = options.commandArgs ?? []
    this.cwd = resolveAppServerCwd(options.cwd)
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs
    this.startupAttemptLimit = options.startupAttemptLimit ?? DEFAULT_STARTUP_ATTEMPT_LIMIT
    this.startupAttemptTimeoutMs = options.startupAttemptTimeoutMs ?? DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS
    this.terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS
    this.portAllocator = options.portAllocator ?? allocateLocalhostPort
    this.metadataDir = options.metadataDir ?? defaultMetadataDir()
    this.serverInstanceId = options.serverInstanceId ?? process.env.FRESHELL_SERVER_INSTANCE_ID ?? `srv-${process.pid}`
    this.ownershipIdFactory = options.ownershipIdFactory ?? (() => `codex-sidecar-${randomUUID()}`)
    this.metadataWriter = options.metadataWriter ?? atomicWriteJson
    this.processIdentityReader = options.processIdentityReader ?? readProcessIdentity
  }

  status(): RuntimeStatus {
    return this.statusValue
  }

  onExit(handler: (error?: Error, source?: CodexAppServerRuntimeFailureSource) => void): () => void {
    this.exitHandlers.add(handler)
    return () => {
      this.exitHandlers.delete(handler)
    }
  }

  onThreadStarted(handler: (thread: CodexThreadHandle) => void): () => void {
    this.threadStartedHandlers.add(handler)
    return () => {
      this.threadStartedHandlers.delete(handler)
    }
  }

  onThreadLifecycle(handler: (event: CodexThreadLifecycleEvent) => void): () => void {
    this.threadLifecycleHandlers.add(handler)
    return () => {
      this.threadLifecycleHandlers.delete(handler)
    }
  }

  onFsChanged(handler: (event: { watchId: string; changedPaths: string[] }) => void): () => void {
    this.fsChangedHandlers.add(handler)
    return () => {
      this.fsChangedHandlers.delete(handler)
    }
  }

  async ensureReady(): Promise<ReadyState> {
    if (this.shutdownRequested) {
      throw new Error('Codex app-server sidecar is shutting down.')
    }
    await this.assertNoBlockedOwnership('ensure Codex app-server sidecar readiness')
    if (this.ready) return this.ready
    if (this.ensureReadyPromise) return this.ensureReadyPromise

    this.ensureReadyPromise = this.startRuntime().finally(() => {
      this.ensureReadyPromise = null
    })

    return this.publishReady(await this.ensureReadyPromise)
  }

  private publishReady(ready: ReadyState): ReadyState {
    this.ready = ready
    this.statusValue = 'running'
    return ready
  }

  async startThread(
    params: Omit<CodexThreadStartParams, 'experimentalRawEvents' | 'persistExtendedHistory'>,
  ): Promise<CodexThreadOperationResult & { wsUrl: string }> {
    const ready = await this.ensureReady()
    return {
      ...(await this.client!.startThread(params)),
      wsUrl: ready.wsUrl,
    }
  }

  async resumeThread(
    params: Omit<CodexThreadResumeParams, 'persistExtendedHistory'>,
  ): Promise<CodexThreadOperationResult & { wsUrl: string }> {
    const ready = await this.ensureReady()
    return {
      ...(await this.client!.resumeThread(params)),
      wsUrl: ready.wsUrl,
    }
  }

  async watchPath(targetPath: string, watchId: string): Promise<CodexFsWatchResult> {
    await this.ensureReady()
    return this.client!.watchPath(targetPath, watchId)
  }

  async unwatchPath(watchId: string): Promise<void> {
    await this.ensureReady()
    await this.client!.unwatchPath(watchId)
  }

  async updateOwnershipMetadata(input: {
    terminalId?: string | null
    generation?: number | null
    codexHome?: string
  }): Promise<void> {
    await this.assertNoBlockedOwnership('update Codex app-server ownership metadata')
    if (!this.ownership) {
      return
    }
    this.ownership.metadata = {
      ...this.ownership.metadata,
      ...(input.terminalId !== undefined ? { terminalId: input.terminalId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.codexHome !== undefined ? { codexHome: input.codexHome } : {}),
      updatedAt: new Date().toISOString(),
    }
    await this.writeOwnershipRecord(this.ownership)
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    try {
      const pendingReady = this.ensureReadyPromise
      this.ready = null
      this.ensureReadyPromise = null
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      if (client) {
        await client.close().catch(() => undefined)
      }

      await this.stopActiveChild()
      await pendingReady?.catch(() => undefined)
      await this.stopActiveChild()
      await this.assertNoBlockedOwnership('shut down Codex app-server sidecar')
    } finally {
      this.shutdownRequested = false
    }
  }

  async simulateChildExitForTest(): Promise<void> {
    await this.stopActiveChild()
  }

  private async startRuntime(): Promise<ReadyState> {
    await assertProcOwnershipProofAvailable()
    await this.waitForOwnershipTeardown()
    await this.assertNoBlockedOwnership('start a new Codex app-server sidecar')
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= this.startupAttemptLimit; attempt += 1) {
      if (this.shutdownRequested) {
        throw new Error('Codex app-server startup was cancelled because the sidecar is shutting down.')
      }

      const endpoint = await this.portAllocator()
      const wsUrl = `ws://${endpoint.hostname}:${endpoint.port}`
      const ownershipId = this.ownershipIdFactory()
      const child = spawn(this.command, [
        ...this.commandArgs,
        'app-server',
        '--listen',
        wsUrl,
      ], {
        detached: true,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        env: {
          ...process.env,
          ...this.env,
          FRESHELL_CODEX_SIDECAR_ID: ownershipId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const childDiagnostics: RuntimeChildDiagnostics = {
        wsUrl,
        wsPort: endpoint.port,
        startedAt: Date.now(),
        stdoutTail: new BoundedOutputTail(),
        stderrTail: new BoundedOutputTail(),
      }

      child.stdout?.on('data', (chunk) => childDiagnostics.stdoutTail.push(chunk))
      child.stderr?.on('data', (chunk) => childDiagnostics.stderrTail.push(chunk))

      this.child = child
      this.childDiagnostics = childDiagnostics
      this.attachChildErrorHandler(child, childDiagnostics)
      this.attachChildExitHandler(child, childDiagnostics)
      let attemptOwnership: ActiveOwnership | null = null

      try {
        if (!child.pid) {
          const launchError = await Promise.race([
            new Promise<Error | null>((resolve) => {
              child.once('error', (error) => resolve(error instanceof Error ? error : new Error(String(error))))
              setTimeout(() => resolve(null), 25)
            }),
          ])
          if (launchError) throw launchError
          throw new Error('Codex app-server sidecar spawn did not expose a wrapper PID.')
        }

        const ownership = this.createOwnershipRecord({
          ownershipId,
          wsUrl,
          wrapperPid: child.pid,
          processGroupId: child.pid,
        })
        this.ownership = ownership
        attemptOwnership = ownership
        await this.writeOwnershipRecord(ownership)
        await this.readWrapperIdentityInto(ownership)
        this.ownership = ownership
        await this.writeOwnershipRecord(ownership)

        const client = new CodexAppServerClient(
          { wsUrl },
          this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {},
        )
        client.onDisconnect((event) => {
          this.handleClientDisconnect(client, event)
        })
        client.onThreadLifecycle((event) => {
          for (const handler of this.threadLifecycleHandlers) {
            handler(event)
          }
        })
        client.onThreadStarted((thread) => {
          for (const handler of this.threadStartedHandlers) {
            handler(thread)
          }
        })
        client.onFsChanged((event) => {
          for (const handler of this.fsChangedHandlers) {
            handler(event)
          }
        })
        this.client = client

        const initialized = await this.waitForInitialize(client, child, childDiagnostics)
        await this.updateOwnershipMetadata({ codexHome: initialized.codexHome })
        return {
          wsUrl,
          processPid: child.pid,
          codexHome: initialized.codexHome,
          ownershipId,
          processGroupId: child.pid,
          metadataPath: ownership.metadataPath,
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        const client = this.client
        if (client) {
          await client.close().catch(() => undefined)
        }
        if (this.client === client) {
          this.client = null
        }
        if (attemptOwnership) {
          await this.beginOwnershipTeardown(attemptOwnership).catch((teardownError) => {
            lastError = new Error(`${lastError?.message ?? 'startup failed'}; teardown failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`)
            throw lastError
          })
        } else {
          await this.stopActiveChild()
        }
      }
    }

    throw new Error(
      `Failed to start Codex app-server on a loopback endpoint after ${this.startupAttemptLimit} attempts: ${lastError?.message ?? 'unknown error'}`,
    )
  }

  private createOwnershipRecord(input: {
    ownershipId: string
    wsUrl: string
    wrapperPid: number
    processGroupId: number
  }): ActiveOwnership {
    const now = new Date().toISOString()
    const metadata: CodexSidecarOwnershipMetadata = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      ownershipId: input.ownershipId,
      serverInstanceId: this.serverInstanceId,
      ownerServerPid: process.pid,
      terminalId: null,
      generation: null,
      wsUrl: input.wsUrl,
      wrapperPid: input.wrapperPid,
      processGroupId: input.processGroupId,
      wrapperIdentity: emptyWrapperIdentity(),
      createdAt: now,
      updatedAt: now,
    }
    const metadataPath = path.join(this.metadataDir, `${input.ownershipId}.json`)
    return {
      metadataDir: this.metadataDir,
      metadataPath,
      metadata,
    }
  }

  private async readWrapperIdentityInto(ownership: ActiveOwnership): Promise<void> {
    const wrapperIdentity = await this.processIdentityReader(ownership.metadata.wrapperPid)
    if (!isCompleteWrapperIdentity(wrapperIdentity)) {
      throw new Error(
        `Codex app-server wrapper identity could not be completely read for PID ${ownership.metadata.wrapperPid}.`,
      )
    }
    ownership.metadata = {
      ...ownership.metadata,
      wrapperIdentity,
      updatedAt: new Date().toISOString(),
    }
  }

  private async writeOwnershipRecord(ownership: ActiveOwnership): Promise<void> {
    await this.metadataWriter(ownership.metadataPath, ownership.metadata).catch((error) => {
      throw new Error(`Codex app-server ownership metadata write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async waitForInitialize(
    client: CodexAppServerClient,
    child: ChildProcess,
    diagnostics: RuntimeChildDiagnostics,
  ): Promise<CodexInitializeResult> {
    const deadline = Date.now() + this.startupAttemptTimeoutMs
    let lastError: Error | undefined

    while (Date.now() < deadline) {
      if (diagnostics.processError) {
        throw this.createUnexpectedExitError(
          child,
          diagnostics,
          child.exitCode,
          child.signalCode,
          `Codex app-server runtime failed to start: ${diagnostics.processError.message}`,
        )
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break
      }

      try {
        return await client.initialize()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await sleep(STARTUP_POLL_MS)
      }
    }

    throw lastError ?? new Error('Codex app-server exited before it finished initializing.')
  }

  private attachChildErrorHandler(child: ChildProcess, diagnostics: RuntimeChildDiagnostics): void {
    child.once('error', (error) => {
      diagnostics.processError = error instanceof Error ? error : new Error(String(error))
      if (this.child !== child) {
        return
      }

      const wasReady = this.ready !== null
      const ownership = this.ownership
      this.child = null
      this.childDiagnostics = null
      this.ready = null
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      const closeClient = client?.close().catch(() => undefined)
      if (ownership) {
        void this.beginOwnershipTeardown(ownership, closeClient).catch((teardownError) => {
          logger.error({ err: teardownError, ownershipId: ownership.metadata.ownershipId }, 'Codex app-server sidecar teardown after wrapper error failed')
        })
      } else {
        void closeClient
      }

      if (!wasReady || this.shutdownRequested) {
        return
      }

      const runtimeError = this.createUnexpectedExitError(
        child,
        diagnostics,
        child.exitCode,
        child.signalCode,
        `Codex app-server runtime errored unexpectedly: ${diagnostics.processError.message}`,
      )
      for (const handler of this.exitHandlers) {
        handler(runtimeError, 'app_server_exit')
      }
    })
  }

  private attachChildExitHandler(child: ChildProcess, diagnostics: RuntimeChildDiagnostics): void {
    child.once('exit', (code, signal) => {
      if (this.child !== child) {
        return
      }

      const wasReady = this.ready !== null
      const ownership = this.ownership
      this.child = null
      this.childDiagnostics = null
      this.ready = null
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      const closeClient = client?.close().catch(() => undefined)
      if (ownership) {
        void this.beginOwnershipTeardown(ownership, closeClient).catch((teardownError) => {
          logger.error({ err: teardownError, ownershipId: ownership.metadata.ownershipId }, 'Codex app-server sidecar teardown after wrapper exit failed')
        })
      } else {
        void closeClient
      }

      if (!wasReady || this.shutdownRequested) {
        return
      }

      const error = this.createUnexpectedExitError(child, diagnostics, code, signal)
      for (const handler of this.exitHandlers) {
        handler(error, 'app_server_exit')
      }
    })
  }

  private handleClientDisconnect(client: CodexAppServerClient, event: CodexAppServerDisconnectEvent): void {
    if (this.client !== client) {
      return
    }

    const child = this.child
    const diagnostics = this.childDiagnostics
    const wasReady = this.ready !== null
    this.client = null
    this.ready = null
    this.statusValue = 'stopped'

    if (!wasReady || this.shutdownRequested) {
      void this.stopActiveChild().catch(() => undefined)
      return
    }

    const error = child && diagnostics
      ? this.createUnexpectedExitError(
        child,
        diagnostics,
        child.exitCode,
        child.signalCode,
        event.reason === 'error'
          ? `Codex app-server client socket errored: ${event.error?.message ?? 'unknown error'}`
          : 'Codex app-server client socket closed unexpectedly.',
      )
      : new Error(event.reason === 'error'
          ? `Codex app-server client socket errored: ${event.error?.message ?? 'unknown error'}`
          : 'Codex app-server client socket closed unexpectedly.')
    for (const handler of this.exitHandlers) {
      handler(error, 'app_server_client_disconnect')
    }
    void this.stopActiveChild().catch(() => undefined)
  }

  private createUnexpectedExitError(
    child: ChildProcess,
    diagnostics: RuntimeChildDiagnostics,
    code: number | null,
    signal: NodeJS.Signals | null,
    prefix = 'Codex app-server runtime exited unexpectedly.',
  ): Error {
    const elapsedMs = Date.now() - diagnostics.startedAt
    const stdoutTail = diagnostics.stdoutTail.snapshot()
    const stderrTail = diagnostics.stderrTail.snapshot()
    return new Error([
      prefix,
      `pid ${child.pid ?? 'unknown'}`,
      `ws port ${diagnostics.wsPort}`,
      `ws url ${diagnostics.wsUrl}`,
      `exit code ${code ?? 'unknown'}`,
      `signal ${signal ?? 'none'}`,
      `elapsed ${elapsedMs}ms`,
      `stdout tail: ${stdoutTail || '(empty)'}`,
      `stderr tail: ${stderrTail || '(empty)'}`,
    ].join(' '))
  }

  private async stopActiveChild(): Promise<void> {
    const child = this.child
    const ownership = this.ownership
    this.child = null
    this.childDiagnostics = null
    this.ready = null
    this.statusValue = 'stopped'

    if (!ownership) {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        return
      }
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
          resolve()
        }, this.terminateGraceMs)
        child.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
      return
    }

    await this.beginOwnershipTeardown(ownership)
  }

  private async waitForOwnershipTeardown(): Promise<void> {
    const pending = this.ownershipTeardownPromise
    if (pending) await pending
    await this.assertNoBlockedOwnership('continue Codex app-server ownership lifecycle')
  }

  private async assertNoBlockedOwnership(operation: string): Promise<void> {
    const failure = this.ownershipTeardownFailure
    if (!failure) return

    const ownership = this.ownership
    if (!ownership) {
      this.ownershipTeardownFailure = null
      return
    }

    if (await isProcessGroupGone(ownership.metadata.processGroupId)) {
      await fsp.unlink(ownership.metadataPath).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      })
      if (this.ownership === ownership) {
        this.ownership = null
      }
      this.ownershipTeardownFailure = null
      return
    }

    throw new Error(
      `Cannot ${operation} because Codex app-server ownership ${ownership.metadata.ownershipId} is blocked after teardown failed: ${failure.message}`,
    )
  }

  private beginOwnershipTeardown(
    ownership: ActiveOwnership,
    beforeTeardown?: Promise<unknown>,
  ): Promise<void> {
    if (this.ownershipTeardownPromise) return this.ownershipTeardownPromise

    const teardown = (async () => {
      await beforeTeardown?.catch(() => undefined)
      try {
        const stopped = await teardownOwnedProcessGroup(ownership, this.terminateGraceMs, { activeOwner: true })
        if (!stopped) {
          throw new Error(
            `Codex app-server sidecar process-group teardown failed for ownership ${ownership.metadata.ownershipId}.`,
          )
        }
        if (this.ownership === ownership) {
          this.ownership = null
        }
        this.ownershipTeardownFailure = null
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.ownershipTeardownFailure = failure
        throw failure
      }
    })()
    const tracked = teardown.finally(() => {
      if (this.ownershipTeardownPromise === tracked) {
        this.ownershipTeardownPromise = null
      }
    })
    this.ownershipTeardownPromise = tracked
    return tracked
  }
}
