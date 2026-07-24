import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CODEX_MANAGED_REMOTE_CONFIG_ARGS } from '../codex-managed-config.js'
import { deregisterCodexChild, registerCodexChild } from '../codex-child-registry.js'
import { allocateLocalhostPort, type LoopbackServerEndpoint } from '../../local-port.js'
import { logger } from '../../logger.js'
import { resolveLaunchCwd, type LaunchCwdConversion } from '../../launch-cwd.js'
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

type SpawnProcess = typeof spawn
type ChildProcessHandle = ReturnType<SpawnProcess>

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
  spawnProcess?: SpawnProcess
}

export type CodexAppServerProcessDiagnostics = {
  pid: number
  platform: NodeJS.Platform
  uptimeSeconds: number
  memory: NodeJS.MemoryUsage
  resourceUsage?: ReturnType<typeof process.resourceUsage>
  fdCount?: number
  processCount?: number
  loadavg?: string
  meminfo?: {
    memTotalKb?: number
    memFreeKb?: number
    memAvailableKb?: number
    swapTotalKb?: number
    swapFreeKb?: number
  }
  limits?: {
    maxProcesses?: string
    maxOpenFiles?: string
  }
  probeErrors?: Record<string, string>
}

export type CodexAppServerLaunchDiagnostics = {
  process: CodexAppServerProcessDiagnostics
  runtime: {
    command: string
    startupAttemptLimit: number
    startupAttemptTimeoutMs: number
    status: RuntimeStatus
    hasActiveChild: boolean
    activeChildPid?: number
    activeOwnershipId?: string
  }
  sidecars: {
    metadataDir: string
    metadataRecords: {
      total: number
      currentServer: number
      otherServer: number
      malformed: number
      unreadable: number
      oversized: number
      cap: number
      capReached: boolean
    }
  }
}

export type CodexAppServerLaunchErrorDetails = {
  code?: string
  retryable?: boolean
  diagnostics?: CodexAppServerLaunchDiagnostics
}

class CodexAppServerStartupError extends Error {
  code?: string
  retryable?: boolean
  diagnostics?: CodexAppServerLaunchDiagnostics

  constructor(message: string, details: CodexAppServerLaunchErrorDetails & { cause?: unknown } = {}) {
    super(message, { cause: details.cause })
    this.name = 'CodexAppServerStartupError'
    this.code = details.code
    this.retryable = details.retryable
    this.diagnostics = details.diagnostics
  }
}

export type ReapOrphanedSidecarsOptions = {
  metadataDir?: string
  serverInstanceId: string
  terminateGraceMs?: number
  /**
   * Total wall-clock budget for group teardowns (the signal-and-wait part) in one pass. The boot
   * pass runs pre-listen, so runCodexStartupReaper caps it at CODEX_REAPER_BOOT_BUDGET_MS; records
   * past the budget skip teardown and are deferred with retry state (surfaced in the summary and
   * retried by the hourly tick, which stays unbudgeted). Omit for unbudgeted behavior.
   */
  teardownBudgetMs?: number
  /**
   * Skip records whose per-record retry backoff window has not elapsed (no attempt increment, no
   * log). Passed by the hourly maintenance tick; boot passes always attempt every record.
   */
  respectRetryBackoff?: boolean
  /** Clock seam for the teardown budget (tests only). */
  nowFn?: () => number
}

export type ReapOrphanedSidecarsResult = {
  reapedOwnershipIds: string[]
  ignoredLegacyRecords: string[]
  skippedActiveOwnershipIds: string[]
  /** Records that hit an unexpected per-record error; retained in place and retried next pass. */
  failedOwnershipIds: string[]
  /** Record files that could not be read (permissions, torn write); retained in place. */
  unreadableRecords: string[]
  /** Records moved to `<metadataDir>/quarantine/` (unparseable, or malformed with no provable live group). */
  quarantinedRecords: string[]
  /** Records retried in place with backoff state in `<record>.reaper.json` (never quarantined). */
  retriedOwnershipIds: string[]
  /** Records whose group teardown was skipped because the pass's teardown time budget ran out. */
  deferredForBudget: string[]
  /** Quarantined records promoted back into the metadata dir because their process group is alive. */
  promotedFromQuarantine: string[]
  /** True when reaping was skipped this pass (metadata dir unreadable or /proc proof unavailable). */
  reapingSkipped: boolean
}

/** Backoff state persisted by the reaper (and only the reaper) in `<record>.reaper.json`. */
export type CodexReaperRetryState = {
  firstSeen: string
  attempts: number
  /**
   * Absent for records that were only ever DEFERRED for budget (R2-M2: a deferral is not an
   * attempt). A state without lastAttempt always tests as due, so the hourly unbudgeted tick
   * picks deferred records up immediately.
   */
  lastAttempt?: string
}

const DEFAULT_STARTUP_ATTEMPT_LIMIT = 2
const DEFAULT_STARTUP_ATTEMPT_TIMEOUT_MS = 3_000
const STARTUP_POLL_MS = 50
const DEFAULT_TERMINATE_GRACE_MS = 1_000
const OWNERSHIP_SCHEMA_VERSION = 1
const LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP = 100
const LAUNCH_DIAGNOSTIC_METADATA_RECORD_MAX_BYTES = 16 * 1024
export const DEFAULT_CODEX_SIDECAR_METADATA_DIR = path.join(os.homedir(), '.freshell', 'codex-sidecars')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorCause(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isRetryableSpawnCode(code: string | undefined): boolean {
  return code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE' || code === 'ENOMEM'
}

export function getCodexAppServerLaunchErrorDetails(error: unknown): CodexAppServerLaunchErrorDetails {
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const details = current as CodexAppServerLaunchErrorDetails
    const code = typeof details.code === 'string' ? details.code : undefined
    const retryable = typeof details.retryable === 'boolean' ? details.retryable : undefined
    const diagnostics = details.diagnostics
    if (code || retryable !== undefined || diagnostics) {
      return {
        ...(code ? { code } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      }
    }
    current = errorCause(current)
  }
  return {}
}

export function isRetryableCodexAppServerLaunchError(error: unknown): boolean {
  const details = getCodexAppServerLaunchErrorDetails(error)
  if (details.retryable === true) return true
  return isRetryableSpawnCode(details.code)
}

function parseMeminfo(raw: string): CodexAppServerProcessDiagnostics['meminfo'] {
  const values = new Map<string, number>()
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB/.exec(line)
    if (match) values.set(match[1], Number(match[2]))
  }
  return {
    memTotalKb: values.get('MemTotal'),
    memFreeKb: values.get('MemFree'),
    memAvailableKb: values.get('MemAvailable'),
    swapTotalKb: values.get('SwapTotal'),
    swapFreeKb: values.get('SwapFree'),
  }
}

function parseLimits(raw: string): CodexAppServerProcessDiagnostics['limits'] {
  const limits: CodexAppServerProcessDiagnostics['limits'] = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('Max processes')) limits.maxProcesses = line.trim()
    if (line.startsWith('Max open files')) limits.maxOpenFiles = line.trim()
  }
  return limits
}

async function readTextFile(pathname: string): Promise<string> {
  return fsp.readFile(pathname, 'utf8')
}

async function countDirectoryEntries(
  pathname: string,
  cap: number,
  onlyNumeric = false,
): Promise<{ count: number; capReached: boolean }> {
  let count = 0
  let capReached = false
  const dir = await fsp.opendir(pathname)
  try {
    for await (const entry of dir) {
      if (onlyNumeric && !/^\d+$/.test(entry.name)) continue
      if (count >= cap) {
        capReached = true
        break
      }
      count += 1
    }
  } finally {
    await dir.close().catch(() => undefined)
  }
  return { count, capReached }
}

export async function collectCodexAppServerProcessDiagnostics(): Promise<CodexAppServerProcessDiagnostics> {
  const probeErrors: Record<string, string> = {}
  const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (error) {
      probeErrors[name] = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  const fdCount = await safe('fdCount', async () => (await countDirectoryEntries('/proc/self/fd', 10_000)).count)
  const processCount = await safe('processCount', async () => (await countDirectoryEntries('/proc', 100_000, true)).count)
  const loadavg = await safe('loadavg', async () => (await readTextFile('/proc/loadavg')).trim())
  const meminfoRaw = await safe('meminfo', async () => readTextFile('/proc/meminfo'))
  const limitsRaw = await safe('limits', async () => readTextFile('/proc/self/limits'))

  return {
    pid: process.pid,
    platform: process.platform,
    uptimeSeconds: process.uptime(),
    memory: process.memoryUsage(),
    resourceUsage: process.resourceUsage?.(),
    ...(fdCount !== undefined ? { fdCount } : {}),
    ...(processCount !== undefined ? { processCount } : {}),
    ...(loadavg ? { loadavg } : {}),
    ...(meminfoRaw ? { meminfo: parseMeminfo(meminfoRaw) } : {}),
    ...(limitsRaw ? { limits: parseLimits(limitsRaw) } : {}),
    ...(Object.keys(probeErrors).length > 0 ? { probeErrors } : {}),
  }
}

function defaultMetadataDir(): string {
  return process.env.FRESHELL_CODEX_SIDECAR_DIR
    || DEFAULT_CODEX_SIDECAR_METADATA_DIR
}

function normalizeLaunchCwd(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim()
  return trimmed ? trimmed : undefined
}

type CodexAppServerLaunchCwd = {
  rawCwd?: string
  launchCwd?: string
  conversion: LaunchCwdConversion
}

function resolveCodexAppServerLaunchCwd(rawCwd: string | undefined): CodexAppServerLaunchCwd {
  const resolved = resolveLaunchCwd(rawCwd, { targetRuntime: 'linux-process' })
  if (rawCwd && !resolved.launchCwd) {
    throw new Error(`Codex app-server cannot use cwd "${rawCwd}" for Linux sidecar launch.`)
  }
  return {
    ...(rawCwd !== undefined ? { rawCwd } : {}),
    ...(resolved.launchCwd !== undefined ? { launchCwd: resolved.launchCwd } : {}),
    conversion: resolved.conversion,
  }
}

async function assertCodexAppServerLaunchCwdReachable(cwd: CodexAppServerLaunchCwd): Promise<void> {
  if (!cwd.launchCwd) return
  try {
    const stat = await fsp.stat(cwd.launchCwd)
    if (!stat.isDirectory()) {
      throw new Error('resolved path is not a directory')
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const conversion = cwd.conversion === 'none' ? 'without conversion' : `using ${cwd.conversion}`
    throw new Error(
      `Codex app-server launch cwd is not a reachable directory: input "${cwd.rawCwd ?? cwd.launchCwd}" resolved to "${cwd.launchCwd}" ${conversion}: ${detail}`,
    )
  }
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
  const confirmedGone = await teardownOwnedProcessGroupCore(ownership, terminateGraceMs)
  // Stage 1a (plan §6): deregister ONLY on confirmed group death (`true` also covers a provably
  // foreign/reused PGID, which means our child is gone — it must leave the registry so exit-time
  // reap can never signal the reused group). Wrapper exit does NOT deregister: live grandchildren
  // keep the group registered until teardown proves it gone.
  if (confirmedGone) deregisterCodexChild(ownership.metadata.wrapperPid)
  return confirmedGone
}

async function teardownOwnedProcessGroupCore(
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
  | { kind: 'unparseable' }
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
    // Not JSON at all: corrupt/torn write. There is nothing to retry against (no process group can
    // even be extracted), so the reaper quarantines it instead of deleting it as legacy.
    return { kind: 'unparseable' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unparseable' }
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

const QUARANTINE_DIR_NAME = 'quarantine'
const REAPER_RETRY_SIDECAR_SUFFIX = '.reaper.json'
const QUARANTINE_NOTE_SUFFIX = '.note.json'
/** r2-8: anchored match for atomicWriteJson's tmp naming -- `<file>.tmp-<pid>-<timestamp>`. */
const ATOMIC_TMP_FILE_PATTERN = /\.tmp-\d+-\d+$/
const HOUR_MS = 60 * 60 * 1000
/**
 * Retry logging escalates from info to warn once a record has been PENDING this long (wall-time,
 * plan §7.4). Never attempt-count based: tsx-watch restart storms and two instances sharing the
 * metadata dir would burn an attempt budget in minutes.
 */
export const CODEX_REAPER_LOG_ESCALATION_MS = 6 * HOUR_MS
/**
 * Total group-teardown time budget for the pre-listen BOOT reap pass (panel M2). Each stuck
 * (D-state) record costs ~2s of signal-and-wait plus two full /proc scans; without a budget every
 * restart pays that per record. Classification and the quarantine rescan (cheap) always run.
 */
export const CODEX_REAPER_BOOT_BUDGET_MS = 3_000

function reaperRetrySidecarPath(metadataPath: string): string {
  return `${metadataPath}${REAPER_RETRY_SIDECAR_SUFFIX}`
}

function quarantineDirPath(metadataDir: string): string {
  return path.join(metadataDir, QUARANTINE_DIR_NAME)
}

// Retry cadence is time-based, keyed on how long the record has been pending (firstSeen) — never on
// attempt counts — so shared prod+dev metadata dirs and `tsx watch` restart storms cannot burn the
// backoff budget. The per-boot reap attempt always runs; this only gates the hourly re-attempts.
export function codexReaperRetryIntervalMs(pendingAgeMs: number): number {
  if (pendingAgeMs < 6 * HOUR_MS) return HOUR_MS
  if (pendingAgeMs < 24 * HOUR_MS) return 3 * HOUR_MS
  return 6 * HOUR_MS
}

export function isCodexReaperRetryDue(state: CodexReaperRetryState, nowMs: number = Date.now()): boolean {
  // R2-M2: no lastAttempt means the record was deferred without ever being attempted -- always due.
  if (state.lastAttempt === undefined) return true
  const firstSeenMs = Date.parse(state.firstSeen)
  const lastAttemptMs = Date.parse(state.lastAttempt)
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(lastAttemptMs)) return true
  return nowMs - lastAttemptMs >= codexReaperRetryIntervalMs(nowMs - firstSeenMs)
}

/**
 * Wall-time log escalation (panel M4): warn only once the record has been pending for
 * CODEX_REAPER_LOG_ESCALATION_MS. `attempts` stays in the payload as informational context.
 */
export function isCodexReaperEscalationDue(state: CodexReaperRetryState, nowMs: number = Date.now()): boolean {
  const firstSeenMs = Date.parse(state.firstSeen)
  if (!Number.isFinite(firstSeenMs)) return true // unparseable anchor: escalate rather than hide
  return nowMs - firstSeenMs >= CODEX_REAPER_LOG_ESCALATION_MS
}

function isCodexReaperRetryState(value: unknown): value is CodexReaperRetryState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CodexReaperRetryState>
  return typeof candidate.firstSeen === 'string'
    && isNonNegativeInteger(candidate.attempts)
    && (candidate.lastAttempt === undefined || typeof candidate.lastAttempt === 'string')
}

async function readCodexReaperRetryStateFile(sidecarPath: string): Promise<CodexReaperRetryState | null> {
  try {
    const raw = await fsp.readFile(sidecarPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isCodexReaperRetryState(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Written only by the reaper, so it cannot race the owning server's own record rewrites. `firstSeen`
// falls back to the record's mtime so the time-based backoff has a stable anchor for records that
// predate their sidecar.
async function recordCodexReaperRetryAttempt(metadataPath: string): Promise<CodexReaperRetryState> {
  const sidecarPath = reaperRetrySidecarPath(metadataPath)
  const existing = await readCodexReaperRetryStateFile(sidecarPath)
  const now = new Date().toISOString()
  let firstSeen = existing?.firstSeen
  if (firstSeen === undefined) {
    const recordStat = await fsp.stat(metadataPath).catch(() => null)
    firstSeen = recordStat ? recordStat.mtime.toISOString() : now
  }
  const state: CodexReaperRetryState = {
    firstSeen,
    attempts: (existing?.attempts ?? 0) + 1,
    lastAttempt: now,
  }
  try {
    await atomicWriteJson(sidecarPath, state)
  } catch (error) {
    logReaperSidecarWriteFailure(sidecarPath, error)
  }
  return state
}

// r2-9: a PERSISTENTLY unwritable sidecar (e.g. a perms-skewed shared metadata dir) must be
// visible, not debug-only -- but concurrent boots legitimately race this write (rename-ENOENT =
// the other instance won) and restart storms must not spam. Warn once per sidecar path per
// process, then drop to debug. Backoff state stays advisory: losing a write never aborts record
// processing.
const warnedReaperSidecarWritePaths = new Set<string>()

function logReaperSidecarWriteFailure(sidecarPath: string, error: unknown): void {
  if (warnedReaperSidecarWritePaths.has(sidecarPath)) {
    logger.debug({ sidecarPath, err: error }, 'Codex reaper could not persist retry backoff state')
    return
  }
  warnedReaperSidecarWritePaths.add(sidecarPath)
  logger.warn({ sidecarPath, err: error }, 'Codex reaper could not persist retry backoff state')
}

// R2-M2: budget deferral must NOT consume the record's retry budget. Under a tsx-watch restart
// cadence, counting deferrals as attempts advances lastAttempt on every boot, so tail records
// would never test as "due" for the hourly UNBUDGETED tick -- permanent teardown starvation. This
// only guarantees a sidecar exists (firstSeen anchors log escalation and future backoff); it
// never creates or advances attempts/lastAttempt, so isCodexReaperRetryDue stays true.
async function recordCodexReaperDeferral(metadataPath: string): Promise<CodexReaperRetryState> {
  const sidecarPath = reaperRetrySidecarPath(metadataPath)
  const existing = await readCodexReaperRetryStateFile(sidecarPath)
  if (existing) return existing // preserve attempts and lastAttempt exactly as they were
  const recordStat = await fsp.stat(metadataPath).catch(() => null)
  const state: CodexReaperRetryState = {
    firstSeen: recordStat ? recordStat.mtime.toISOString() : new Date().toISOString(),
    attempts: 0,
  }
  try {
    // R3-m3: create-exclusive, NOT atomic-rename. A concurrent instance's
    // recordCodexReaperRetryAttempt can land between the sidecar read above and this write; a
    // rename would clobber its attempts/lastAttempt back to zero. `wx` makes the race lose
    // loudly (EEXIST), in which case the concurrent state wins and is returned as-is.
    await fsp.writeFile(sidecarPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const concurrent = await readCodexReaperRetryStateFile(sidecarPath)
      if (concurrent) return concurrent
      return state // sidecar appeared but is unreadable/invalid: stay advisory, never throw
    }
    logReaperSidecarWriteFailure(sidecarPath, error)
  }
  return state
}

function logCodexReaperRetry(
  fields: Record<string, unknown>,
  state: CodexReaperRetryState,
  why: string,
): void {
  const payload = { ...fields, firstSeen: state.firstSeen, attempts: state.attempts, lastAttempt: state.lastAttempt }
  const message = `Codex startup reaper left an ownership record in place for retry with backoff (${why})`
  if (isCodexReaperEscalationDue(state)) {
    logger.warn(payload, message)
  } else {
    logger.info(payload, message)
  }
}

function extractProcessGroupIdBestEffort(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = (parsed as { processGroupId?: unknown }).processGroupId
    return isPositiveInteger(candidate) ? candidate : null
  } catch {
    return null
  }
}

// Quarantine is reserved for records the reaper can never act on: unparseable files, or malformed
// records whose recorded process group cannot be proven alive (second-review blocking #2). Records
// embed command lines and cwds, so the move preserves 0600. Rename-ENOENT means a concurrent boot
// handled the record first; treat as success.
async function quarantineCodexOwnershipRecord(
  metadataDir: string,
  metadataPath: string,
  reason: string,
): Promise<string | null> {
  const retryState = await readCodexReaperRetryStateFile(reaperRetrySidecarPath(metadataPath))
  const recordStat = await fsp.stat(metadataPath).catch(() => null)
  if (!recordStat) return null
  const quarantineDir = quarantineDirPath(metadataDir)
  await fsp.mkdir(quarantineDir, { recursive: true })
  const quarantinePath = path.join(quarantineDir, path.basename(metadataPath))
  // m3: write the note BEFORE the rename — a cross-instance quarantine rescan can promote the
  // record the instant it lands, and a note written after the rename would be stranded as an
  // orphan. rescanCodexReaperQuarantine also unlinks any note whose record file is absent.
  await atomicWriteJson(`${quarantinePath}${QUARANTINE_NOTE_SUFFIX}`, {
    reason,
    firstSeen: retryState?.firstSeen ?? recordStat.mtime.toISOString(),
    attempts: retryState?.attempts ?? 0,
  }).catch((error) => {
    logger.warn({ quarantinePath, err: error }, 'Codex startup reaper could not write a quarantine note')
  })
  try {
    await fsp.rename(metadataPath, quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A concurrent boot handled the record first. r2-7: if the WINNER's rename landed at the
      // quarantine path, the note there now describes the winner's record -- only unlink the note
      // we pre-wrote when NO record sits at the quarantine path.
      const winnerRecordPresent = await fsp.stat(quarantinePath).then(() => true, () => false)
      if (!winnerRecordPresent) {
        await fsp.unlink(`${quarantinePath}${QUARANTINE_NOTE_SUFFIX}`).catch(() => undefined)
      }
      return null
    }
    throw error
  }
  await fsp.chmod(quarantinePath, 0o600).catch(() => undefined)
  await fsp.unlink(reaperRetrySidecarPath(metadataPath)).catch(() => undefined)
  logger.warn({ metadataPath, quarantinePath, reason }, 'Codex startup reaper quarantined an ownership record')
  return quarantinePath
}

// r2-8: best-effort purge of atomic-write tmp files stranded by a crash mid-write; anything older
// than an hour can never be renamed into place by its (dead) writer. Never throws.
async function purgeStaleAtomicTmpFiles(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!ATOMIC_TMP_FILE_PATTERN.test(entry)) continue
    try {
      const tmpPath = path.join(dir, entry)
      const tmpStat = await fsp.stat(tmpPath)
      if (Date.now() - tmpStat.mtimeMs >= HOUR_MS) await fsp.unlink(tmpPath)
    } catch {
      // best-effort cleanup only
    }
  }
}

// Safety net (second-review blocking #2): a quarantined record must never hide a live DB holder.
// Every pass promotes quarantined records whose recorded process group is still alive back into the
// metadata dir so the reaper retries them. Never throws.
export async function rescanCodexReaperQuarantine(
  metadataDir?: string,
): Promise<{ promotedRecords: string[]; quarantinedCount: number }> {
  const dir = metadataDir ?? defaultMetadataDir()
  const quarantineDir = quarantineDirPath(dir)
  const promotedRecords: string[] = []
  let quarantinedCount = 0
  let entries: string[]
  try {
    entries = await fsp.readdir(quarantineDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ quarantineDir, err: error }, 'Codex reaper quarantine rescan could not read the quarantine directory')
    }
    return { promotedRecords, quarantinedCount }
  }
  for (const entry of entries) {
    if (entry.endsWith(QUARANTINE_NOTE_SUFFIX)) {
      // m3: a note without its record is an orphan (quarantine/promote race); unlink it.
      const recordName = entry.slice(0, -QUARANTINE_NOTE_SUFFIX.length)
      const recordExists = await fsp.stat(path.join(quarantineDir, recordName)).then(() => true, () => false)
      if (!recordExists) await fsp.unlink(path.join(quarantineDir, entry)).catch(() => undefined)
      continue
    }
    if (!entry.endsWith('.json')) continue
    quarantinedCount += 1
    const quarantinePath = path.join(quarantineDir, entry)
    try {
      const raw = await fsp.readFile(quarantinePath, 'utf8')
      const processGroupId = extractProcessGroupIdBestEffort(raw)
      if (processGroupId === null) continue
      if (await isProcessGroupGone(processGroupId)) continue
      const restoredPath = path.join(dir, entry)
      try {
        await fsp.rename(quarantinePath, restoredPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // concurrent rescan won
        throw error
      }
      await fsp.chmod(restoredPath, 0o600).catch(() => undefined)
      await fsp.unlink(`${quarantinePath}${QUARANTINE_NOTE_SUFFIX}`).catch(() => undefined)
      quarantinedCount -= 1
      promotedRecords.push(restoredPath)
      logger.warn(
        { quarantinePath, restoredPath, processGroupId },
        'Codex reaper promoted a quarantined ownership record back for retry because its process group is still alive',
      )
    } catch (error) {
      logger.warn({ quarantinePath, err: error }, 'Codex reaper quarantine rescan failed for a record; leaving it quarantined')
    }
  }
  return { promotedRecords, quarantinedCount }
}

/** Read-only count of quarantined ownership records, for the codex-log-db observability line. */
export async function countCodexQuarantinedRecords(metadataDir?: string): Promise<number> {
  const dir = metadataDir ?? defaultMetadataDir()
  try {
    const entries = await fsp.readdir(quarantineDirPath(dir))
    return entries.filter((entry) => entry.endsWith('.json') && !entry.endsWith(QUARANTINE_NOTE_SUFFIX)).length
  } catch {
    return 0
  }
}

// Used by the hourly observability tick to gate re-running the reaper: the per-boot attempt always
// runs, but hourly re-attempts follow the time-based backoff above. Sidecars orphaned by a
// successful reap are cleaned up here so they cannot trigger reaper runs forever.
export async function hasDueCodexReaperRetries(metadataDir?: string, nowMs: number = Date.now()): Promise<boolean> {
  const dir = metadataDir ?? defaultMetadataDir()
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return false
  }
  let due = false
  for (const entry of entries) {
    if (entry.endsWith(REAPER_RETRY_SIDECAR_SUFFIX)) {
      const sidecarPath = path.join(dir, entry)
      const recordPath = sidecarPath.slice(0, -REAPER_RETRY_SIDECAR_SUFFIX.length)
      const recordExists = await fsp.stat(recordPath).then(() => true, () => false)
      if (!recordExists) {
        await fsp.unlink(sidecarPath).catch(() => undefined)
        continue
      }
      const state = await readCodexReaperRetryStateFile(sidecarPath)
      if (!state || isCodexReaperRetryDue(state, nowMs)) due = true
      continue
    }
    // r2-6: a record orphaned AFTER boot has no backoff sidecar yet -- without this branch the
    // hourly tick early-returns forever while the orphan sits there. Any plain .json ownership
    // record whose ownerServerPid is not provably alive needs a reaper pass (which will tear it
    // down or write backoff state). Cheap: one read + parse + signal-0 probe per such record.
    if (!entry.endsWith('.json') || ATOMIC_TMP_FILE_PATTERN.test(entry)) continue
    const recordPath = path.join(dir, entry)
    const sidecarExists = await fsp.stat(reaperRetrySidecarPath(recordPath)).then(() => true, () => false)
    if (sidecarExists) continue // due-ness governed by its sidecar, handled above
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(recordPath, 'utf8'))
      const ownerServerPid = (parsed as { ownerServerPid?: unknown } | null)?.ownerServerPid
      if (isPositiveInteger(ownerServerPid) && (await isPidAlive(ownerServerPid))) continue
      due = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // unlinked mid-scan
      due = true // unreadable/unparseable: the reaper owns the decision (retry or quarantine)
    }
  }
  return due
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
    unreadableRecords: [],
    quarantinedRecords: [],
    retriedOwnershipIds: [],
    deferredForBudget: [],
    promotedFromQuarantine: [],
    reapingSkipped: false,
  }
  // r2-5: the teardown budget measures ELAPSED time -- default to the monotonic clock so a
  // wall-clock step (NTP, suspend/resume) cannot spuriously exhaust or extend the budget. An
  // injected nowFn (tests) is used consistently for both the pass start and every check.
  const nowFn = options.nowFn ?? (() => performance.now())
  const passStartedAt = nowFn()

  // Safety net first: promote quarantined records whose process group is still alive so this same
  // pass retries them (a quarantined record must never hide a live DB holder).
  try {
    const rescan = await rescanCodexReaperQuarantine(metadataDir)
    result.promotedFromQuarantine.push(...rescan.promotedRecords)
  } catch (error) {
    logger.warn({ metadataDir, err: error }, 'Codex startup reaper quarantine rescan failed; continuing')
  }

  // r2-8: stranded atomic-write tmp files land in quarantine/ too (notes and quarantined records
  // are written atomically); sweep it with the same age gate the main-dir loop applies below.
  await purgeStaleAtomicTmpFiles(quarantineDirPath(metadataDir))

  let procOwnershipProofChecked = false
  const ensureProcOwnershipProof = async () => {
    if (procOwnershipProofChecked) return
    await assertProcOwnershipProofAvailable()
    procOwnershipProofChecked = true
  }

  let entries: string[]
  try {
    entries = await fsp.readdir(metadataDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    // Degrade and continue (I4): without the record listing we skip reaping this pass instead of
    // failing boot. Records stay in place for the hourly retry and the next boot.
    result.reapingSkipped = true
    logger.warn(
      { metadataDir, err: error },
      'Codex startup reaper could not read the sidecar metadata directory; skipping reaping this pass',
    )
    return result
  }

  for (const entry of entries) {
    // m9: purge atomic-write tmp files stranded by a crash mid-write; anything older than an hour
    // can never be renamed into place by its (dead) writer. Best-effort, never fatal.
    if (ATOMIC_TMP_FILE_PATTERN.test(entry)) {
      try {
        const tmpPath = path.join(metadataDir, entry)
        const tmpStat = await fsp.stat(tmpPath)
        if (Date.now() - tmpStat.mtimeMs >= HOUR_MS) await fsp.unlink(tmpPath)
      } catch {
        // best-effort cleanup only
      }
      continue
    }
    if (!entry.endsWith('.json') || entry.endsWith(REAPER_RETRY_SIDECAR_SUFFIX)) continue
    const metadataPath = path.join(metadataDir, entry)
    let ownershipId: string | undefined
    // Per-record isolation (I4): one bad record affects only itself, never the scan or the boot.
    try {
      // m2: hourly (non-boot) passes gate PER RECORD on the time-based backoff — a record that is
      // not yet due is skipped entirely (no attempt increment, no log), even when another record
      // being due triggered the pass.
      if (options.respectRetryBackoff) {
        const retryState = await readCodexReaperRetryStateFile(reaperRetrySidecarPath(metadataPath))
        if (retryState && !isCodexReaperRetryDue(retryState)) continue
      }
      let raw: string
      try {
        raw = await fsp.readFile(metadataPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // a concurrent boot handled it
        result.unreadableRecords.push(metadataPath)
        logger.warn(
          { metadataPath, err: error },
          'Codex startup reaper could not read an ownership record; leaving it in place (unreadable)',
        )
        continue
      }

      const parsed = parseMetadataRecord(raw, metadataPath)
      if (parsed.kind === 'legacy') {
        result.ignoredLegacyRecords.push(metadataPath)
        await fsp.unlink(metadataPath).catch(() => undefined)
        continue
      }
      if (parsed.kind === 'unparseable') {
        // Nothing to retry against: no process group can be extracted from a non-JSON record.
        const quarantinePath = await quarantineCodexOwnershipRecord(metadataDir, metadataPath, 'unparseable-record')
        if (quarantinePath) result.quarantinedRecords.push(quarantinePath)
        continue
      }
      if (parsed.kind === 'malformedNewSchema') {
        ownershipId = parsed.ownershipId
        // Narrowed quarantine (second-review blocking #2): only quarantine when the recorded
        // process group cannot be proven alive. A malformed record naming a live group is the only
        // tether to a live DB holder — retry it in place instead, never quarantine it.
        const processGroupId = extractProcessGroupIdBestEffort(raw)
        if (processGroupId !== null && !(await isProcessGroupGone(processGroupId))) {
          const state = await recordCodexReaperRetryAttempt(metadataPath)
          logCodexReaperRetry(
            { ownershipId: parsed.ownershipId, metadataPath, processGroupId },
            state,
            'malformed record with a live process group',
          )
          result.retriedOwnershipIds.push(parsed.ownershipId)
        } else {
          const quarantinePath = await quarantineCodexOwnershipRecord(metadataDir, metadataPath, 'malformed-record')
          if (quarantinePath) result.quarantinedRecords.push(quarantinePath)
        }
        continue
      }

      const metadata = parsed.metadata
      ownershipId = metadata.ownershipId

      try {
        await ensureProcOwnershipProof()
      } catch (error) {
        // Degrade and continue (I4): without the /proc ownership proof no record can be classified
        // safely (I3), so skip reaping this pass rather than abort boot.
        result.reapingSkipped = true
        logger.warn(
          { metadataDir, err: error },
          'Codex startup reaper has no usable /proc ownership proof; skipping reaping this pass',
        )
        break
      }

      if (await isPidAlive(metadata.ownerServerPid)) {
        if (await isOwnerServerProcess(metadata)) {
          result.skippedActiveOwnershipIds.push(metadata.ownershipId)
        } else {
          // Owner pid alive but identity-mismatched (pid reuse or a transient /proc race): retry in
          // place with backoff — never quarantine a record we could not disprove.
          const state = await recordCodexReaperRetryAttempt(metadataPath)
          logCodexReaperRetry(
            {
              ownershipId: metadata.ownershipId,
              metadataPath,
              ownerServerPid: metadata.ownerServerPid,
              processGroupId: metadata.processGroupId,
            },
            state,
            'owner pid is alive without a matching identity',
          )
          result.retriedOwnershipIds.push(metadata.ownershipId)
        }
        continue
      }

      const currentProcessGroupId = await getProcessGroupId('self')
      if (currentProcessGroupId !== null && metadata.processGroupId === currentProcessGroupId) {
        result.skippedActiveOwnershipIds.push(metadata.ownershipId)
        continue
      }

      const ownership: ActiveOwnership = { metadataDir, metadataPath, metadata }
      // M2: once the pass's teardown budget is exhausted, skip the signal-and-wait teardown for
      // the remaining records. They keep retry state (so they surface in the boot summary and the
      // hourly tick re-attempts them) and are marked deferred — never dropped.
      if (options.teardownBudgetMs !== undefined && nowFn() - passStartedAt > options.teardownBudgetMs) {
        // R2-M2: a deferral is not an attempt -- recordCodexReaperDeferral never bumps attempts
        // nor advances lastAttempt, so the record stays due for the hourly unbudgeted tick.
        const state = await recordCodexReaperDeferral(metadataPath)
        logCodexReaperRetry(
          {
            ownershipId: metadata.ownershipId,
            metadataPath,
            wrapperPid: metadata.wrapperPid,
            processGroupId: metadata.processGroupId,
            teardownBudgetMs: options.teardownBudgetMs,
          },
          state,
          'teardown budget exhausted this pass; deferred',
        )
        result.deferredForBudget.push(metadata.ownershipId)
        continue
      }
      const reaped = await teardownOwnedProcessGroup(ownership, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS)
      if (reaped) {
        result.reapedOwnershipIds.push(metadata.ownershipId)
        await fsp.unlink(reaperRetrySidecarPath(metadataPath)).catch(() => undefined)
      } else {
        // Owner dead but the group survived SIGTERM+SIGKILL (e.g. a codex process in D-state I/O
        // against a bloated WAL — this incident's exact signature), or ownership could not be
        // verified. NEVER quarantine: this record is the only tether to a potentially live DB
        // holder. Retry in place with backoff.
        const state = await recordCodexReaperRetryAttempt(metadataPath)
        logCodexReaperRetry(
          {
            ownershipId: metadata.ownershipId,
            metadataPath,
            wrapperPid: metadata.wrapperPid,
            processGroupId: metadata.processGroupId,
          },
          state,
          'process group survived teardown or ownership was not verified',
        )
        result.retriedOwnershipIds.push(metadata.ownershipId)
      }
    } catch (error) {
      result.failedOwnershipIds.push(ownershipId ?? metadataPath)
      logger.warn(
        { metadataPath, ownershipId, err: error },
        'Codex startup reaper failed to process an ownership record; leaving it in place for retry',
      )
    }
  }

  return result
}

// Boot entry point. Reaping is best-effort: unresolved records are surfaced as a single warning
// (below) instead of blocking startup — the fail-closed assertCodexStartupReaperSucceeded contract
// was removed by Stage 1c (I4). The index.ts call site adds a final try/catch backstop.
export async function runCodexStartupReaper(
  options: ReapOrphanedSidecarsOptions,
): Promise<ReapOrphanedSidecarsResult> {
  // Boot pass runs pre-listen: cap the total teardown time (panel M2). Callers may override.
  const result = await reapOrphanedCodexAppServerSidecars({ teardownBudgetMs: CODEX_REAPER_BOOT_BUDGET_MS, ...options })
  summarizeCodexStartupReaperResult(result)
  return result
}

// Warning aggregator (no throw): replaces the deleted fail-closed assert.
function summarizeCodexStartupReaperResult(result: ReapOrphanedSidecarsResult): void {
  const unresolved =
    result.failedOwnershipIds.length
    + result.unreadableRecords.length
    + result.quarantinedRecords.length
    + result.retriedOwnershipIds.length
    + result.deferredForBudget.length
  if (!result.reapingSkipped && unresolved === 0) return
  logger.warn(
    {
      reapingSkipped: result.reapingSkipped,
      failedOwnershipIds: [...new Set(result.failedOwnershipIds)],
      unreadableRecords: result.unreadableRecords,
      quarantinedRecords: result.quarantinedRecords,
      retriedOwnershipIds: [...new Set(result.retriedOwnershipIds)],
      deferredForBudget: [...new Set(result.deferredForBudget)],
      promotedFromQuarantine: result.promotedFromQuarantine,
    },
    'Codex startup reaper completed with unresolved ownership records; continuing boot (fail-open)',
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
  private readonly spawnProcess: SpawnProcess
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
    this.spawnProcess = options.spawnProcess ?? spawn
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
    const requestedCwd = normalizeLaunchCwd(cwd) ?? this.defaultCwd
    const launchCwd = resolveCodexAppServerLaunchCwd(requestedCwd)
    if (this.ready) {
      this.assertCompatibleLaunchCwd(launchCwd.launchCwd, this.readyCwd)
      return this.ready
    }
    if (this.ensureReadyPromise) {
      this.assertCompatibleLaunchCwd(launchCwd.launchCwd, this.ensureReadyCwd)
      return this.ensureReadyPromise
    }

    this.ensureReadyCwd = launchCwd.launchCwd
    this.ensureReadyPromise = this.startRuntime(launchCwd).finally(() => {
      this.ensureReadyPromise = null
      this.ensureReadyCwd = undefined
    })

    this.ready = await this.ensureReadyPromise
    this.readyCwd = launchCwd.launchCwd
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

  private async collectSidecarMetadataDiagnostics(): Promise<CodexAppServerLaunchDiagnostics['sidecars']['metadataRecords']> {
    let total = 0
    let currentServer = 0
    let otherServer = 0
    let malformed = 0
    let unreadable = 0
    let oversized = 0
    let capReached = false

    const dir = await fsp.opendir(this.metadataDir).catch(() => null)
    if (!dir) {
      return {
        total,
        currentServer,
        otherServer,
        malformed,
        unreadable,
        oversized,
        cap: LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP,
        capReached,
      }
    }

    try {
      for await (const entry of dir) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        // m5: reaper backoff sidecars and quarantine notes are NOT ownership records; counting
        // them as malformed would misreport the launch diagnostics.
        if (entry.name.endsWith(REAPER_RETRY_SIDECAR_SUFFIX) || entry.name.endsWith(QUARANTINE_NOTE_SUFFIX)) continue
        if (total >= LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP) {
          capReached = true
          break
        }
        total += 1

        const filePath = path.join(this.metadataDir, entry.name)
        try {
          const stat = await fsp.stat(filePath)
          if (stat.size > LAUNCH_DIAGNOSTIC_METADATA_RECORD_MAX_BYTES) {
            oversized += 1
            continue
          }
          const raw = await fsp.readFile(filePath, 'utf8')
          const parsed = JSON.parse(raw) as Partial<CodexSidecarOwnershipMetadata>
          if (parsed.schemaVersion !== OWNERSHIP_SCHEMA_VERSION || typeof parsed.serverInstanceId !== 'string') {
            malformed += 1
          } else if (parsed.serverInstanceId === this.serverInstanceId) {
            currentServer += 1
          } else {
            otherServer += 1
          }
        } catch {
          unreadable += 1
        }
      }
    } catch {
      unreadable += 1
    } finally {
      await dir.close().catch(() => undefined)
    }

    return {
      total,
      currentServer,
      otherServer,
      malformed,
      unreadable,
      oversized,
      cap: LAUNCH_DIAGNOSTIC_METADATA_RECORD_CAP,
      capReached,
    }
  }

  private async collectLaunchDiagnostics(): Promise<CodexAppServerLaunchDiagnostics> {
    return {
      process: await collectCodexAppServerProcessDiagnostics(),
      runtime: {
        command: this.command,
        startupAttemptLimit: this.startupAttemptLimit,
        startupAttemptTimeoutMs: this.startupAttemptTimeoutMs,
        status: this.statusValue,
        hasActiveChild: !!this.child,
        ...(this.child?.pid ? { activeChildPid: this.child.pid } : {}),
        ...(this.ownership?.metadata.ownershipId ? { activeOwnershipId: this.ownership.metadata.ownershipId } : {}),
      },
      sidecars: {
        metadataDir: this.metadataDir,
        metadataRecords: await this.collectSidecarMetadataDiagnostics(),
      },
    }
  }

  private async startRuntime(cwd: CodexAppServerLaunchCwd): Promise<ReadyState> {
    await assertProcOwnershipProofAvailable()
    await assertCodexAppServerLaunchCwdReachable(cwd)
    await this.waitForOwnershipTeardown()
    await this.assertNoBlockedOwnership('start a new Codex app-server sidecar')
    let lastError: Error | undefined
    let lastLaunchDetails: CodexAppServerLaunchErrorDetails = {}

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
      const child = this.spawnProcess(this.command, [
        ...this.commandArgs,
        ...CODEX_MANAGED_REMOTE_CONFIG_ARGS,
        'app-server',
        '--listen',
        wsUrl,
      ], {
        detached: true,
        ...(cwd.launchCwd ? { cwd: cwd.launchCwd } : {}),
        env: {
          ...process.env,
          ...this.env,
          FRESHELL_CODEX_SIDECAR_ID: ownershipId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const childErrorPromise = this.watchChildError(child)

      // Stage 1a (plan §6): track the sidecar's process group (pgid == wrapper pid, spawned
      // `detached: true`) for exit-time reaping. Deregistered only on CONFIRMED group death in
      // teardownOwnedProcessGroup — NOT at wrapper exit, which can leave live grandchildren.
      if (child.pid) {
        registerCodexChild({
          pid: child.pid,
          pgid: child.pid,
          kind: 'app-server',
          // R2-M1: ownership proof for the registry's dead-pid group-scan fallback -- the spawn
          // env above injects FRESHELL_CODEX_SIDECAR_ID=<ownershipId> into the whole group.
          envMarker: { name: 'FRESHELL_CODEX_SIDECAR_ID', value: ownershipId },
        })
      }

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
        const currentDetails = getCodexAppServerLaunchErrorDetails(lastError)
        if (currentDetails.code || currentDetails.retryable !== undefined || currentDetails.diagnostics) {
          lastLaunchDetails = currentDetails
        }
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

    let diagnostics: CodexAppServerLaunchDiagnostics | undefined
    try {
      diagnostics = await this.collectLaunchDiagnostics()
    } catch (diagnosticsError) {
      logger.warn(
        { err: diagnosticsError, launchErr: lastError },
        'Codex app-server startup diagnostic collection failed',
      )
    }
    const code = lastLaunchDetails.code ?? getErrorCode(lastError)
    const retryable = lastLaunchDetails.retryable ?? isRetryableCodexAppServerLaunchError(lastError)
    const retryablePrefix = retryable && code
      ? ` Last failure was retryable resource exhaustion (${code}).`
      : ''
    logger.warn(
      {
        err: lastError,
        code,
        retryable,
        ...(diagnostics ? { diagnostics } : {}),
      },
      'Codex app-server startup failed after all attempts',
    )
    throw new CodexAppServerStartupError(
      `Failed to start Codex app-server on a loopback endpoint after ${this.startupAttemptLimit} attempts:${retryablePrefix} ${lastError?.message ?? 'unknown error'}`,
      { code, retryable, ...(diagnostics ? { diagnostics } : {}), cause: lastError },
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
        const code = (base as NodeJS.ErrnoException).code
        ;(launchError as Error & { code?: string; cause?: unknown; retryable?: boolean }).code = code
        ;(launchError as Error & { code?: string; cause?: unknown; retryable?: boolean }).cause = base
        ;(launchError as Error & { code?: string; cause?: unknown; retryable?: boolean }).retryable =
          isRetryableSpawnCode(code)
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
      // m1: spawn failed before ownership was created, so teardownOwnedProcessGroup will never
      // run for this child — deregister on its exit (or now, if it already exited) to avoid a
      // permanent registry leak and a misleading codexChildren snapshot. Children WITH ownership
      // are deregistered exclusively by confirmed-group-death teardown, never here.
      const pid = child?.pid
      if (child && pid) {
        if (child.exitCode !== null || child.signalCode !== null) {
          deregisterCodexChild(pid)
        } else {
          child.once('exit', () => {
            deregisterCodexChild(pid)
          })
        }
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
      // Stage 1a (plan §6): group death is confirmed here too — drop the registration so exit-time
      // reap can never signal a reused pid/pgid.
      deregisterCodexChild(ownership.metadata.wrapperPid)
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
