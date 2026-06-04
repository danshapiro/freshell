import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CODEX_MANAGED_REMOTE_CONFIG_ARGS } from '../codex-managed-config.js'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../local-port.js'
import { logger } from '../../logger.js'
import {
  CodexAppServerClient,
  type CodexTurnEvent,
  type CodexThreadLifecycleEvent,
  type CodexThreadLifecycleLossEvent,
} from './client.js'
import type {
  CodexFsWatchResult,
  CodexInitializeResult,
  CodexThreadForkParams,
  CodexThreadHandle,
  CodexThreadReadParams,
  CodexThreadReadResult,
  CodexThreadResumeParams,
  CodexThreadStartParams,
  CodexThreadTurnReadParams,
  CodexThreadTurnReadResult,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResult,
  CodexTurnInterruptParams,
  CodexTurnStartParams,
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
  ownerServerIdentity?: WrapperIdentity
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

export type ReadyState = {
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

type ChildProcessHandle = ReturnType<typeof spawn>

type RuntimeOptions = {
  command?: string
  commandArgs?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  startupAttemptLimit?: number
  startupAttemptTimeoutMs?: number
  portAllocator?: () => Promise<LoopbackServerEndpoint>
  metadataDir?: string
  serverInstanceId?: string
  ownershipIdFactory?: () => string
  metadataWriter?: (filePath: string, metadata: CodexSidecarOwnershipMetadata) => Promise<void>
  processIdentityReader?: (pid: number) => Promise<WrapperIdentity | null>
}

export type ReapOrphanedSidecarsOptions = {
  metadataDir?: string
  serverInstanceId: string
  terminateGraceMs?: number
}

export type ReapOrphanedSidecarsResult = {
  reapedOwnershipIds: string[]
  ignoredLegacyRecords: string[]
  skippedActiveOwnershipIds: string[]
  failedOwnershipIds: string[]
}

const DEFAULT_STARTUP_ATTEMPT_LIMIT = 2
const DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS = 3_000
const STARTUP_POLL_MS = 50
const DEFAULT_TERMINATE_GRACE_MS = 1_000
const OWNERSHIP_SCHEMA_VERSION = 1
export const DEFAULT_CODEX_SIDECAR_METADATA_DIR = path.join(os.homedir(), '.freshell', 'codex-sidecars')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultMetadataDir(): string {
  return process.env.FRESHELL_CODEX_SIDECAR_DIR
    || DEFAULT_CODEX_SIDECAR_METADATA_DIR
}

function normalizeLaunchCwd(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim()
  return trimmed ? trimmed : undefined
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

type ProcessGroupIdResult =
  | { kind: 'value'; processGroupId: number }
  | { kind: 'gone' }
  | { kind: 'unreadable' }

async function readProcessGroupIdResult(pid: number | 'self'): Promise<ProcessGroupIdResult> {
  let stat: string
  try {
    stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' }
    return { kind: 'unreadable' }
  }
  const parsed = parseProcStat(stat)
  // Present but unparseable: we cannot prove the process group, so it is unprovable, not "gone".
  if (!parsed) return { kind: 'unreadable' }
  return { kind: 'value', processGroupId: parsed.pgrp }
}

async function getProcessGroupId(pid: number | 'self'): Promise<number | null> {
  const result = await readProcessGroupIdResult(pid)
  return result.kind === 'value' ? result.processGroupId : null
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

function processIdentityMatches(expected: WrapperIdentity | undefined, current: WrapperIdentity | null): boolean {
  if (!current) return false
  if (!expected) return false
  if (expected.startTimeTicks === null || current.startTimeTicks === null) return false
  if (expected.startTimeTicks !== current.startTimeTicks) return false
  if (expected.cwd === null || current.cwd === null || expected.cwd !== current.cwd) return false
  if (expected.commandLine.length === 0 || expected.commandLine.length !== current.commandLine.length) return false
  return expected.commandLine.every((arg, index) => arg === current.commandLine[index])
}

function wrapperIdentityMatches(record: CodexSidecarOwnershipMetadata, current: WrapperIdentity | null): boolean {
  return processIdentityMatches(record.wrapperIdentity, current)
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

async function isOwnerServerProcess(metadata: CodexSidecarOwnershipMetadata): Promise<boolean> {
  if (!metadata.ownerServerIdentity) return false
  const currentIdentity = await readProcessIdentity(metadata.ownerServerPid)
  return processIdentityMatches(metadata.ownerServerIdentity, currentIdentity)
}

type OwnershipProof = 'match' | 'no-match' | 'unreadable' | 'gone'

async function readProcessOwnershipProof(pid: number, ownershipId: string): Promise<OwnershipProof> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/environ`)
    return raw.toString('utf8').split('\0').includes(`FRESHELL_CODEX_SIDECAR_ID=${ownershipId}`)
      ? 'match'
      : 'no-match'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // The process vanished mid-scan: it carries no live ownership, so it is not evidence either way.
    if (code === 'ENOENT' || code === 'ESRCH') return 'gone'
    // Any other failure (e.g. EACCES) means we could not read the proof — absence of evidence, not
    // evidence of absence. We must not treat that as "not ours".
    return 'unreadable'
  }
}

async function scanProcessGroupMembers(
  processGroupId: number,
): Promise<{ members: number[]; sawUnreadable: boolean }> {
  const entries = await fsp.readdir('/proc')
  const members: number[] = []
  let sawUnreadable = false

  await Promise.all(entries.map(async (entry) => {
    if (!/^\d+$/.test(entry)) return
    const pid = Number(entry)
    const result = await readProcessGroupIdResult(pid)
    if (result.kind === 'value') {
      if (result.processGroupId === processGroupId) members.push(pid)
    } else if (result.kind === 'unreadable') {
      // A process we could not classify might be one of our members — stay conservative.
      sawUnreadable = true
    }
    // 'gone' → exited mid-scan; ignore.
  }))

  return { members: members.sort((a, b) => a - b), sawUnreadable }
}

async function processGroupMembers(processGroupId: number): Promise<number[]> {
  return (await scanProcessGroupMembers(processGroupId)).members
}

async function isProcessGroupGone(processGroupId: number): Promise<boolean> {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return true
  try {
    process.kill(-processGroupId, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
  }
  return false
}

type OwnedProcessGroupStatus = 'gone' | 'self' | 'owned' | 'foreign' | 'indeterminate'

async function classifyOwnedProcessGroup(
  metadata: CodexSidecarOwnershipMetadata,
): Promise<OwnedProcessGroupStatus> {
  if (await isProcessGroupGone(metadata.processGroupId)) return 'gone'

  // /proc/self/stat is normally always readable, but stay tri-state for consistency: if we cannot
  // read our own process group, we cannot rule out that this PGID is the server's own group, so
  // refuse conservatively rather than risk signaling ourselves.
  const selfResult = await readProcessGroupIdResult('self')
  // Any non-'value' self read (unreadable, or the normally-unreachable 'gone') stays conservative: we
  // cannot rule out that this PGID is the server's own group, so refuse rather than risk signaling
  // ourselves. This keeps the tri-state contract total over the discriminated union.
  if (selfResult.kind !== 'value') return 'indeterminate'
  if (metadata.processGroupId === selfResult.processGroupId) {
    return 'self'
  }

  // Tri-state wrapper read: 'gone' means the wrapper genuinely left the group; 'unreadable' means we
  // could not prove where it is, which must stay conservative (NOT "left the group").
  const wrapperResult = await readProcessGroupIdResult(metadata.wrapperPid)
  const wrapperInGroup =
    wrapperResult.kind === 'value' && wrapperResult.processGroupId === metadata.processGroupId
  if (wrapperInGroup) {
    const currentWrapperIdentity = await readProcessIdentity(metadata.wrapperPid)
    if (wrapperIdentityMatches(metadata, currentWrapperIdentity)) {
      return 'owned'
    }
  }

  const { members, sawUnreadable } = await scanProcessGroupMembers(metadata.processGroupId)
  let sawUnprovable = sawUnreadable || wrapperResult.kind === 'unreadable'
  for (const pid of members) {
    const proof = await readProcessOwnershipProof(pid, metadata.ownershipId)
    if (proof === 'match') return 'owned'
    if (proof === 'unreadable') sawUnprovable = true
  }

  // Cannot prove the group is not ours — stay conservative and never disown/kill it:
  //  - wrapper still resident but its identity no longer matches, or
  //  - the wrapper read, member enumeration, or a member's ownership proof was unreadable.
  if (wrapperInGroup || sawUnprovable) return 'indeterminate'

  // Wrapper has provably left the group and every readable member is provably not ours: our sidecar
  // is gone and the PGID is foreign (reused). The ownership record is stale.
  return 'foreign'
}

async function unlinkOwnershipMetadata(ownership: ActiveOwnership): Promise<void> {
  await fsp.unlink(ownership.metadataPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
  })
}

async function disownStaleOwnership(ownership: ActiveOwnership, when: string): Promise<true> {
  const { metadata } = ownership
  logger.info(
    {
      ownershipId: metadata.ownershipId,
      terminalId: metadata.terminalId,
      generation: metadata.generation,
      wsUrl: metadata.wsUrl,
      wrapperPid: metadata.wrapperPid,
      processGroupId: metadata.processGroupId,
      serverInstanceId: metadata.serverInstanceId,
    },
    `Codex app-server sidecar process group is no longer owned (${when}); cleaning up stale ownership record without signaling`,
  )
  await unlinkOwnershipMetadata(ownership)
  return true
}

// Single dispatch for every non-`owned` classification, so the decision (and its safety guarantees)
// is identical everywhere teardown re-classifies. Returns the teardown result for a terminal status,
// or `null` for `owned` (meaning: the caller may signal). `gone` is a silent success (the normal
// clean-shutdown case); `foreign` cleans up with an info log; `self`/`indeterminate` refuse.
async function concludeIfNotOwned(
  ownership: ActiveOwnership,
  status: OwnedProcessGroupStatus,
  when: string,
): Promise<boolean | null> {
  const { metadata } = ownership
  if (status === 'gone') {
    await unlinkOwnershipMetadata(ownership)
    return true
  }
  if (status === 'foreign') {
    return disownStaleOwnership(ownership, when)
  }
  if (status === 'self' || status === 'indeterminate') {
    logger.error(
      {
        ownershipId: metadata.ownershipId,
        terminalId: metadata.terminalId,
        generation: metadata.generation,
        wsUrl: metadata.wsUrl,
        wrapperPid: metadata.wrapperPid,
        processGroupId: metadata.processGroupId,
        serverInstanceId: metadata.serverInstanceId,
      },
      `Refusing to signal Codex app-server sidecar because its process-group ownership is not verified (${when})`,
    )
    return false
  }
  if (status === 'owned') return null // the caller may signal

  // Exhaustiveness guard. With the current union this is unreachable, but it makes any future
  // OwnedProcessGroupStatus a compile error here (so a new, more-uncertain status cannot silently
  // fall through to signaling) and, if somehow reached at runtime, fails CLOSED: never signal a group
  // we could not classify.
  const _exhaustive: never = status
  logger.error(
    {
      ownershipId: metadata.ownershipId,
      terminalId: metadata.terminalId,
      generation: metadata.generation,
      wsUrl: metadata.wsUrl,
      wrapperPid: metadata.wrapperPid,
      processGroupId: metadata.processGroupId,
      serverInstanceId: metadata.serverInstanceId,
      status: _exhaustive,
    },
    `Refusing to signal Codex app-server sidecar for an unknown ownership status (${when})`,
  )
  return false
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
): Promise<boolean> {
  const { metadata } = ownership

  // Gate the SIGTERM on a FRESH ownership classification rather than mere liveness: a PGID that was
  // reused after the sidecar exited classifies as `foreign`/`gone`, so it is never signaled. This
  // narrows — but cannot fully close — the residual classify->process.kill window inherent to any
  // PGID-targeted signal.
  const beforeTerm = await concludeIfNotOwned(ownership, await classifyOwnedProcessGroup(metadata), 'before SIGTERM')
  if (beforeTerm !== null) return beforeTerm
  signalProcessGroup(metadata.processGroupId, 'SIGTERM')

  if (!(await waitForProcessGroupGone(metadata.processGroupId, terminateGraceMs))) {
    // Re-verify ownership before escalating: if it exited during the grace window and the PGID was
    // reused, this re-classifies as `gone`/`foreign` and we never SIGKILL a non-owned group.
    const beforeKill = await concludeIfNotOwned(ownership, await classifyOwnedProcessGroup(metadata), 'before SIGKILL')
    if (beforeKill !== null) return beforeKill
    signalProcessGroup(metadata.processGroupId, 'SIGKILL')
  }

  const gone = await waitForProcessGroupGone(metadata.processGroupId, terminateGraceMs)
  if (!gone) {
    logger.error(
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
      'Codex app-server sidecar process group remained alive after shutdown',
    )
    return false
  }

  await unlinkOwnershipMetadata(ownership)
  return true
}

type ParsedMetadataRecord =
  | { kind: 'valid'; metadata: CodexSidecarOwnershipMetadata }
  | { kind: 'legacy' }
  | { kind: 'malformedNewSchema'; ownershipId: string }

function isWrapperIdentity(value: unknown): value is WrapperIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WrapperIdentity>
  return Array.isArray(candidate.commandLine)
    && candidate.commandLine.every((arg) => typeof arg === 'string')
    && (candidate.cwd === null || typeof candidate.cwd === 'string')
    && (candidate.startTimeTicks === null || typeof candidate.startTimeTicks === 'number')
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
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
    || (candidate.terminalId !== null && typeof candidate.terminalId !== 'string')
    || (candidate.generation !== null && !isNonNegativeInteger(candidate.generation))
    || typeof candidate.wsUrl !== 'string'
    || !isPositiveInteger(candidate.wrapperPid)
    || !isPositiveInteger(candidate.processGroupId)
    || !isWrapperIdentity(candidate.wrapperIdentity)
    || typeof candidate.createdAt !== 'string'
    || typeof candidate.updatedAt !== 'string'
  ) {
    return { kind: 'malformedNewSchema', ownershipId }
  }
  return { kind: 'valid', metadata: candidate as CodexSidecarOwnershipMetadata }
}

export async function reapOrphanedCodexAppServerSidecars(
  options: ReapOrphanedSidecarsOptions,
): Promise<ReapOrphanedSidecarsResult> {
  const metadataDir = options.metadataDir ?? defaultMetadataDir()
  const result: ReapOrphanedSidecarsResult = {
    reapedOwnershipIds: [],
    ignoredLegacyRecords: [],
    skippedActiveOwnershipIds: [],
    failedOwnershipIds: [],
  }
  let procOwnershipProofChecked = false
  const ensureProcOwnershipProof = async () => {
    if (procOwnershipProofChecked) return
    await assertProcOwnershipProofAvailable()
    procOwnershipProofChecked = true
  }
  const entries = await fsp.readdir(metadataDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
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

    await ensureProcOwnershipProof()
    const metadata = parsed.metadata

    if (await isPidAlive(metadata.ownerServerPid)) {
      if (await isOwnerServerProcess(metadata)) {
        result.skippedActiveOwnershipIds.push(metadata.ownershipId)
      } else {
        result.failedOwnershipIds.push(metadata.ownershipId)
      }
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

export async function runCodexStartupReaper(
  options: ReapOrphanedSidecarsOptions,
): Promise<ReapOrphanedSidecarsResult> {
  const result = await reapOrphanedCodexAppServerSidecars(options)
  assertCodexStartupReaperSucceeded(result)
  return result
}

export const reapOrphanedCodexAppServerSidecarsOnStartup = runCodexStartupReaper

export function assertCodexStartupReaperSucceeded(result: ReapOrphanedSidecarsResult): void {
  const failedOwnershipIds = [...new Set(result.failedOwnershipIds)]
  if (failedOwnershipIds.length === 0) return

  const reasons: string[] = []
  reasons.push(
    `failed to reap ${failedOwnershipIds.length} ownership record(s): ${failedOwnershipIds.join(', ')}`,
  )

  throw new Error(
    `Codex app-server startup reaper blocked startup: ${reasons.join('; ')}. `
    + 'Refusing to continue until failed ownership records are handled or verified gone.',
  )
}

export class CodexAppServerRuntime {
  private child: ChildProcessHandle | null = null
  private client: CodexAppServerClient | null = null
  private ready: ReadyState | null = null
  private ensureReadyPromise: Promise<ReadyState> | null = null
  private statusValue: RuntimeStatus = 'stopped'
  private ownership: ActiveOwnership | null = null
  private ownershipTeardownPromise: Promise<void> | null = null
  private ownershipTeardownFailure: Error | null = null
  private shutdownRequested = false
  private lifecycleLossHandlers = new Set<(event: CodexThreadLifecycleLossEvent) => void>()
  private readonly exitHandlers = new Set<(error?: Error, source?: CodexAppServerRuntimeFailureSource) => void>()
  private readonly threadStartedHandlers = new Set<(thread: CodexThreadHandle) => void>()
  private readonly threadLifecycleHandlers = new Set<(event: CodexThreadLifecycleEvent) => void>()
  private readonly fsChangedHandlers = new Set<(event: { watchId: string; changedPaths: string[] }) => void>()
  private readonly turnStartedHandlers = new Set<(event: CodexTurnEvent) => void>()
  private readonly turnCompletedHandlers = new Set<(event: CodexTurnEvent) => void>()

  private readonly command: string
  private readonly commandArgs: string[]
  private readonly defaultCwd?: string
  private readonly env?: NodeJS.ProcessEnv
  private readonly requestTimeoutMs?: number
  private readonly startupAttemptLimit: number
  private readonly startupAttemptTimeoutMs: number
  private readonly portAllocator: () => Promise<LoopbackServerEndpoint>
  private readonly metadataDir: string
  private readonly serverInstanceId: string
  private readonly ownershipIdFactory: () => string
  private readonly metadataWriter: (filePath: string, metadata: CodexSidecarOwnershipMetadata) => Promise<void>
  private readonly processIdentityReader: (pid: number) => Promise<WrapperIdentity | null>
  private readyCwd: string | undefined
  private ensureReadyCwd: string | undefined

  constructor(options: RuntimeOptions = {}) {
    this.command = options.command ?? (process.env.CODEX_CMD || 'codex')
    this.commandArgs = options.commandArgs ?? []
    this.defaultCwd = normalizeLaunchCwd(options.cwd)
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs
    this.startupAttemptLimit = options.startupAttemptLimit ?? DEFAULT_STARTUP_ATTEMPT_LIMIT
    this.startupAttemptTimeoutMs = options.startupAttemptTimeoutMs ?? DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS
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

  private assertCompatibleLaunchCwd(requestedCwd: string | undefined, activeCwd: string | undefined): void {
    if (!requestedCwd || requestedCwd === activeCwd) return
    throw new Error(
      activeCwd
        ? `Codex app-server sidecar is already starting or running in cwd ${activeCwd}; it cannot be reused for cwd ${requestedCwd}.`
        : `Codex app-server sidecar is already starting or running without an explicit cwd; it cannot be reused for cwd ${requestedCwd}.`,
    )
  }

  async ensureReady(cwd?: string): Promise<ReadyState> {
    if (this.shutdownRequested) {
      throw new Error('Codex app-server sidecar is shutting down.')
    }
    await this.assertNoBlockedOwnership('ensure Codex app-server sidecar readiness')
    const launchCwd = normalizeLaunchCwd(cwd) ?? this.defaultCwd
    if (this.ready) {
      this.assertCompatibleLaunchCwd(launchCwd, this.readyCwd)
      return this.ready
    }
    if (this.ensureReadyPromise) {
      this.assertCompatibleLaunchCwd(launchCwd, this.ensureReadyCwd)
      return this.ensureReadyPromise
    }

    this.ensureReadyCwd = launchCwd
    this.ensureReadyPromise = this.startRuntime(launchCwd).finally(() => {
      this.ensureReadyPromise = null
      this.ensureReadyCwd = undefined
    })

    this.ready = await this.ensureReadyPromise
    this.readyCwd = launchCwd
    this.statusValue = 'running'
    return this.ready
  }

  async startThread(
    params: Omit<CodexThreadStartParams, 'experimentalRawEvents' | 'persistExtendedHistory'>,
  ): Promise<{ threadId: string; wsUrl: string }> {
    const ready = await this.ensureReady(params.cwd ?? undefined)
    const result = await this.client!.startThread(params)
    return {
      threadId: result.thread.id,
      wsUrl: ready.wsUrl,
    }
  }

  async resumeThread(
    params: Omit<CodexThreadResumeParams, 'persistExtendedHistory'>,
  ): Promise<{ threadId: string; wsUrl: string }> {
    const ready = await this.ensureReady(params.cwd ?? undefined)
    const result = await this.client!.resumeThread(params)
    return {
      threadId: result.thread.id,
      wsUrl: ready.wsUrl,
    }
  }

  async forkThread(params: CodexThreadForkParams): Promise<{ threadId: string; wsUrl: string }> {
    const ready = await this.ensureReady()
    const result = await this.client!.forkThread(params)
    return {
      threadId: result.threadId,
      wsUrl: ready.wsUrl,
    }
  }

  async readThread(params: CodexThreadReadParams): Promise<CodexThreadReadResult> {
    await this.ensureReady()
    return this.client!.readThread(params)
  }

  async listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResult> {
    await this.ensureReady()
    return this.client!.listThreadTurns(params)
  }

  async readThreadTurn(params: CodexThreadTurnReadParams): Promise<CodexThreadTurnReadResult> {
    await this.ensureReady()
    return this.client!.readThreadTurn(params)
  }

  async startTurn(params: CodexTurnStartParams): Promise<{ turnId: string }> {
    await this.ensureReady()
    return this.client!.startTurn(params)
  }

  async interruptTurn(params: CodexTurnInterruptParams): Promise<void> {
    await this.ensureReady()
    await this.client!.interruptTurn(params)
  }

  async listLoadedThreads(): Promise<string[]> {
    await this.ensureReady()
    return this.client!.listLoadedThreads()
  }

  async updateOwnershipMetadata(input: {
    terminalId?: string | null
    generation?: number | null
    codexHome?: string
  }): Promise<void> {
    await this.assertNoBlockedOwnership('update Codex app-server ownership metadata')
    if (!this.ownership) {
      throw new Error('Cannot update Codex app-server ownership metadata because no active owned Codex app-server sidecar exists.')
    }
    this.ownership.metadata = {
      ...this.ownership.metadata,
      ...(input.terminalId !== undefined ? { terminalId: input.terminalId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.codexHome !== undefined ? { codexHome: input.codexHome } : {}),
      updatedAt: new Date().toISOString(),
    }
    await atomicWriteJson(this.ownership.metadataPath, this.ownership.metadata)
  }

  onThreadLifecycleLoss(handler: (event: CodexThreadLifecycleLossEvent) => void): () => void {
    this.lifecycleLossHandlers.add(handler)
    return () => {
      this.lifecycleLossHandlers.delete(handler)
    }
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

  onTurnStarted(handler: (event: CodexTurnEvent) => void): () => void {
    this.turnStartedHandlers.add(handler)
    return () => {
      this.turnStartedHandlers.delete(handler)
    }
  }

  onTurnCompleted(handler: (event: CodexTurnEvent) => void): () => void {
    this.turnCompletedHandlers.add(handler)
    return () => {
      this.turnCompletedHandlers.delete(handler)
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

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    try {
      const pendingReady = this.ensureReadyPromise
      this.ready = null
      this.ensureReadyPromise = null
      this.readyCwd = undefined
      this.ensureReadyCwd = undefined
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

  private async startRuntime(cwd?: string): Promise<ReadyState> {
    await assertProcOwnershipProofAvailable()
    await this.waitForOwnershipTeardown()
    await this.assertNoBlockedOwnership('start a new Codex app-server sidecar')
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= this.startupAttemptLimit; attempt += 1) {
      if (this.shutdownRequested) {
        throw new Error('Codex app-server startup was cancelled because the sidecar is shutting down.')
      }
      const endpoint = await this.portAllocator()
      if (this.shutdownRequested) {
        throw new Error('Codex app-server startup was cancelled because the sidecar is shutting down.')
      }
      const wsUrl = `ws://${endpoint.hostname}:${endpoint.port}`
      const ownershipId = this.ownershipIdFactory()
      const child = spawn(this.command, [
        ...this.commandArgs,
        ...CODEX_MANAGED_REMOTE_CONFIG_ARGS,
        'app-server',
        '--listen',
        wsUrl,
      ], {
        detached: true,
        ...(cwd ? { cwd } : {}),
        env: {
          ...process.env,
          ...this.env,
          FRESHELL_CODEX_SIDECAR_ID: ownershipId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const childErrorPromise = this.watchChildError(child)

      // Drain child stdio continuously so verbose app-server or MCP startup logs
      // cannot fill the pipe buffer and stall JSON-RPC request handling.
      child.stdout?.resume()
      child.stderr?.resume()

      this.child = child
      this.attachChildExitHandler(child)
      let attemptOwnership: ActiveOwnership | null = null

      try {
        if (!child.pid) {
          const launchError = await Promise.race([
            childErrorPromise,
            sleep(25).then(() => null),
          ])
          if (launchError) throw launchError
          throw new Error('Codex app-server sidecar spawn did not expose a wrapper PID.')
        }

        const ownerServerIdentity = await this.processIdentityReader(process.pid)
        if (!isCompleteWrapperIdentity(ownerServerIdentity)) {
          throw new Error(`Codex app-server owner identity could not be completely read for PID ${process.pid}.`)
        }

        const ownership = this.createOwnershipRecord({
          ownershipId,
          wsUrl,
          wrapperPid: child.pid,
          processGroupId: child.pid,
          ownerServerIdentity,
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
        client.onThreadLifecycleLoss((event) => {
          for (const handler of this.lifecycleLossHandlers) {
            handler(event)
          }
        })
        client.onThreadStarted((thread) => {
          for (const handler of this.threadStartedHandlers) {
            handler(thread)
          }
        })
        client.onThreadLifecycle((event) => {
          for (const handler of this.threadLifecycleHandlers) {
            handler(event)
          }
        })
        client.onFsChanged((event) => {
          for (const handler of this.fsChangedHandlers) {
            handler(event)
          }
        })
        client.onTurnStarted((event) => {
          for (const handler of this.turnStartedHandlers) {
            handler(event)
          }
        })
        client.onTurnCompleted((event) => {
          for (const handler of this.turnCompletedHandlers) {
            handler(event)
          }
        })
        client.onDisconnect((event) => {
          if (this.shutdownRequested) return
          for (const handler of this.exitHandlers) {
            handler(event.error, 'app_server_client_disconnect')
          }
        })
        this.client = client

        const initialized = await this.waitForInitialize(client, child, childErrorPromise)
        await this.updateOwnershipMetadata({ codexHome: initialized.codexHome })
        this.statusValue = 'running'
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
            if (lastError) {
              lastError = new Error(`${lastError.message}; teardown failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`)
            } else {
              lastError = teardownError instanceof Error ? teardownError : new Error(String(teardownError))
            }
            throw lastError
          })
        } else {
          await this.stopActiveChild()
        }
        if (this.shutdownRequested) break
      }
    }

    if (this.shutdownRequested) {
      throw lastError ?? new Error('Codex app-server startup was cancelled because the sidecar is shutting down.')
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
    ownerServerIdentity: WrapperIdentity
  }): ActiveOwnership {
    const now = new Date().toISOString()
    const metadata: CodexSidecarOwnershipMetadata = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      ownershipId: input.ownershipId,
      serverInstanceId: this.serverInstanceId,
      ownerServerPid: process.pid,
      ownerServerIdentity: input.ownerServerIdentity,
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
    const timeoutMs = Math.min(this.startupAttemptTimeoutMs, 1_000)
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const wrapperIdentity = await this.processIdentityReader(ownership.metadata.wrapperPid)
      if (isCompleteWrapperIdentity(wrapperIdentity)) {
        ownership.metadata = {
          ...ownership.metadata,
          wrapperIdentity,
          updatedAt: new Date().toISOString(),
        }
        return
      }
      await sleep(25)
    }

    throw new Error(
      `Codex app-server wrapper identity could not be completely read for PID ${ownership.metadata.wrapperPid}.`,
    )
  }

  private async writeOwnershipRecord(ownership: ActiveOwnership): Promise<void> {
    await this.metadataWriter(ownership.metadataPath, ownership.metadata).catch((error) => {
      throw new Error(`Codex app-server ownership metadata write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async waitForInitialize(
    client: CodexAppServerClient,
    child: ChildProcessHandle,
    childErrorPromise: Promise<Error>,
  ): Promise<CodexInitializeResult> {
    const deadline = Date.now() + this.startupAttemptTimeoutMs
    let lastError: Error | undefined

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        break
      }
      const remainingMs = Math.max(0, deadline - Date.now())

      try {
        return await Promise.race([
          client.initialize(),
          childErrorPromise.then((error) => {
            throw error
          }),
          sleep(remainingMs).then(() => {
            throw new Error(`Codex app-server did not finish initialize within ${this.startupAttemptTimeoutMs}ms.`)
          }),
        ])
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        await sleep(STARTUP_POLL_MS)
      }
    }

    throw lastError ?? new Error('Codex app-server exited before it finished initializing.')
  }

  private watchChildError(child: ChildProcessHandle): Promise<Error> {
    return new Promise((resolve) => {
      child.once('error', (error) => {
        const base = error instanceof Error ? error : new Error(String(error))
        const launchError = new Error(`Failed to launch Codex app-server sidecar: ${base.message}`)
        ;(launchError as Error & { code?: string; cause?: unknown }).code =
          (base as NodeJS.ErrnoException).code
        ;(launchError as Error & { code?: string; cause?: unknown }).cause = base
        if (this.child === child) {
          this.child = null
          this.ready = null
          this.ensureReadyPromise = null
          this.readyCwd = undefined
          this.ensureReadyCwd = undefined
          this.statusValue = 'stopped'
        }
        resolve(launchError)
      })
    })
  }

  private attachChildExitHandler(child: ChildProcessHandle): void {
    child.once('exit', () => {
      if (this.child !== child) {
        return
      }

      const ownership = this.ownership
      this.child = null
      this.ready = null
      this.ensureReadyPromise = null
      this.readyCwd = undefined
      this.ensureReadyCwd = undefined
      this.statusValue = 'stopped'

      const client = this.client
      this.client = null
      const closeClient = client?.close().catch(() => undefined)
      if (ownership) {
        void this.beginOwnershipTeardown(ownership, closeClient).catch((error) => {
          logger.error(
            {
              err: error,
              ownershipId: ownership.metadata.ownershipId,
              terminalId: ownership.metadata.terminalId,
              generation: ownership.metadata.generation,
              wsUrl: ownership.metadata.wsUrl,
              wrapperPid: ownership.metadata.wrapperPid,
              processGroupId: ownership.metadata.processGroupId,
              serverInstanceId: ownership.metadata.serverInstanceId,
            },
            'Codex app-server sidecar teardown after wrapper exit failed',
          )
        })
      } else {
        void closeClient
      }

      if (!this.shutdownRequested) {
        for (const handler of this.exitHandlers) {
          handler(undefined, 'app_server_exit')
        }
      }
    })
  }

  private async stopActiveChild(): Promise<void> {
    const ownership = this.ownership
    const child = this.child
    this.child = null
    this.ready = null
    this.ensureReadyPromise = null
    this.readyCwd = undefined
    this.ensureReadyCwd = undefined
    this.statusValue = 'stopped'

    if (!ownership) {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
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
      await unlinkOwnershipMetadata(ownership)
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
        const stopped = await teardownOwnedProcessGroup(ownership, DEFAULT_TERMINATE_GRACE_MS)
        if (!stopped) {
          throw new Error(
            `Codex app-server sidecar process-group teardown failed for ownership ${ownership.metadata.ownershipId}.`,
          )
        }
        if (stopped && this.ownership === ownership) {
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
