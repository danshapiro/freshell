import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import {
  emptyLatestRunsFile,
  emptyReusableSuccessFile,
  holderRecordSchema,
  latestRunRecordSchema,
  latestRunsFileSchema,
  reusableSuccessFileSchema,
  reusableSuccessRecordSchema,
  type HolderRecord,
  type LatestRunRecord,
  type LatestRunsFile,
  type ReusableSuccessFile,
  type ReusableSuccessRecord,
} from './coordinator-schema.js'

const HOLDER_FILE = 'holder.json'
const COMMAND_RUNS_FILE = 'command-runs.json'
const SUITE_RUNS_FILE = 'suite-runs.json'
const REUSABLE_SUCCESS_FILE = 'reusable-success.json'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const CURRENT_PROCESS_STARTED_AT_MS = performance.timeOrigin
const processMutationQueues = new Map<string, Promise<void>>()

export function getCoordinatorStoreDir(commonDir: string): string {
  return path.join(commonDir, 'freshell-test-coordinator')
}

export async function readHolder(storeDir: string): Promise<HolderRecord | undefined> {
  const filePath = path.join(storeDir, HOLDER_FILE)
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return holderRecordSchema.parse(parsed)
  } catch {
    return undefined
  }
}

export async function writeHolder(storeDir: string, record: HolderRecord): Promise<void> {
  await writeJsonFile(storeDir, HOLDER_FILE, holderRecordSchema.parse(record))
}

export async function clearHolderIfRunIdMatches(storeDir: string, runId: string): Promise<void> {
  const holder = await readHolder(storeDir)
  if (!holder || holder.runId !== runId) {
    return
  }

  try {
    await fsp.unlink(path.join(storeDir, HOLDER_FILE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

export async function readCommandRuns(storeDir: string): Promise<LatestRunsFile> {
  return readLatestRunsFile(storeDir, COMMAND_RUNS_FILE)
}

export async function readSuiteRuns(storeDir: string): Promise<LatestRunsFile> {
  return readLatestRunsFile(storeDir, SUITE_RUNS_FILE)
}

export async function readReusableSuccesses(storeDir: string): Promise<ReusableSuccessFile> {
  const filePath = path.join(storeDir, REUSABLE_SUCCESS_FILE)
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    const parsed = reusableSuccessFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      return emptyReusableSuccessFile()
    }
    return parsed.data
  } catch {
    return emptyReusableSuccessFile()
  }
}

export async function recordCommandResult(storeDir: string, result: LatestRunRecord): Promise<void> {
  const record = latestRunRecordSchema.parse(result)
  await mutateLatestRunsFile(storeDir, COMMAND_RUNS_FILE, (latestRuns) => {
    latestRuns.byKey[record.entrypoint.commandKey] = record
  })
}

export async function recordSuiteResult(storeDir: string, result: LatestRunRecord): Promise<void> {
  const record = latestRunRecordSchema.parse(result)
  const suiteKey = record.entrypoint.suiteKey
  if (!suiteKey) return

  await mutateLatestRunsFile(storeDir, SUITE_RUNS_FILE, (latestRuns) => {
    latestRuns.byKey[suiteKey] = record
  })
}

export async function recordReusableSuccess(storeDir: string, result: ReusableSuccessRecord): Promise<void> {
  const record = reusableSuccessRecordSchema.parse(result)
  if (record.outcome !== 'success' || record.repo.isDirty !== false) {
    return
  }

  await mutateReusableSuccessFile(storeDir, (reusableSuccesses) => {
    reusableSuccesses.byReusableKey[record.reusableKey] = record
  })
}

async function readLatestRunsFile(storeDir: string, fileName: string): Promise<LatestRunsFile> {
  const filePath = path.join(storeDir, fileName)
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    const parsed = latestRunsFileSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      return emptyLatestRunsFile()
    }
    return parsed.data
  } catch {
    return emptyLatestRunsFile()
  }
}

async function writeJsonFile(storeDir: string, fileName: string, data: unknown): Promise<void> {
  await fsp.mkdir(storeDir, { recursive: true })

  const finalPath = path.join(storeDir, fileName)
  const tempPath = path.join(storeDir, `${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  const payload = JSON.stringify(data, null, 2)

  await fsp.writeFile(tempPath, payload)
  await fsp.rename(tempPath, finalPath)
}

async function mutateLatestRunsFile(
  storeDir: string,
  fileName: string,
  mutate: (latestRuns: LatestRunsFile) => void,
): Promise<void> {
  await withFileLock(path.join(storeDir, fileName), async () => {
    const latestRuns = await readLatestRunsFile(storeDir, fileName)
    mutate(latestRuns)
    await writeJsonFile(storeDir, fileName, latestRunsFileSchema.parse(latestRuns))
  })
}

async function mutateReusableSuccessFile(
  storeDir: string,
  mutate: (reusableSuccesses: ReusableSuccessFile) => void,
): Promise<void> {
  await withFileLock(path.join(storeDir, REUSABLE_SUCCESS_FILE), async () => {
    const reusableSuccesses = await readReusableSuccesses(storeDir)
    mutate(reusableSuccesses)
    await writeJsonFile(storeDir, REUSABLE_SUCCESS_FILE, reusableSuccessFileSchema.parse(reusableSuccesses))
  })
}

async function withFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  return withProcessQueue(filePath, async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    const release = await acquireFileLock(`${filePath}.lock`)
    try {
      return await action()
    } finally {
      await release()
    }
  })
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = nowMs() + LOCK_TIMEOUT_MS

  while (true) {
    try {
      const handle = await fsp.open(lockPath, 'wx')
      try {
        const acquiredAtMs = nowMs()
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date(acquiredAtMs).toISOString(),
          processStartedAtMs: CURRENT_PROCESS_STARTED_AT_MS,
          acquiredAtMs,
        }))
      } finally {
        await handle.close()
      }

      return async () => {
        try {
          await fsp.unlink(lockPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      if (await clearStaleLockIfNeeded(lockPath)) {
        continue
      }

      if (nowMs() >= deadline) {
        throw new Error(`Timed out acquiring coordinator store lock for ${path.basename(filePathFromLock(lockPath))}.`)
      }

      await delay(LOCK_RETRY_MS)
    }
  }
}

async function clearStaleLockIfNeeded(lockPath: string): Promise<boolean> {
  const stale = await isStaleLockFile(lockPath, LOCK_STALE_MS)

  if (!stale) {
    return false
  }

  try {
    await fsp.unlink(lockPath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function filePathFromLock(lockPath: string): string {
  return lockPath.endsWith('.lock') ? lockPath.slice(0, -'.lock'.length) : lockPath
}

async function isStaleLockFile(lockPath: string, staleMs: number): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath)
  if (!metadata.exists) {
    return true
  }

  if (metadata.pid === process.pid) {
    if (metadata.processStartedAtMs !== undefined) {
      return metadata.processStartedAtMs < CURRENT_PROCESS_STARTED_AT_MS
    }

    return metadata.mtimeMs !== undefined && metadata.mtimeMs < CURRENT_PROCESS_STARTED_AT_MS
  }

  if (metadata.ageMs !== undefined && metadata.ageMs > staleMs) {
    return true
  }

  if (metadata.pid !== undefined) {
    return !isProcessAlive(metadata.pid)
  }

  return false
}

async function readLockMetadata(lockPath: string): Promise<{
  exists: boolean
  pid?: number
  ageMs?: number
  mtimeMs?: number
  startedAtMs?: number
  processStartedAtMs?: number
}> {
  try {
    const stats = await fsp.stat(lockPath)
    const raw = await fsp.readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      pid?: unknown
      startedAt?: unknown
      processStartedAtMs?: unknown
      acquiredAtMs?: unknown
    }
    const acquiredAtMs = parseLockNumber(parsed.acquiredAtMs)
    const startedAtMs = parseLockTimestamp(parsed.startedAt)
    return {
      exists: true,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      startedAtMs,
      processStartedAtMs: parseLockNumber(parsed.processStartedAtMs),
      mtimeMs: stats.mtimeMs,
      ageMs: Math.max(0, nowMs() - (
        acquiredAtMs
        ?? startedAtMs
        ?? stats.mtimeMs
      )),
    }
  } catch {
    const stats = await fsp.stat(lockPath).catch(() => undefined)
    if (!stats) {
      return { exists: false }
    }
    return {
      exists: true,
      mtimeMs: stats.mtimeMs,
      ageMs: Math.max(0, nowMs() - stats.mtimeMs),
    }
  }
}

function parseLockNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

function parseLockTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return undefined
  }

  return parsed
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withProcessQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = processMutationQueues.get(key) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const queued = previous.catch(() => {}).then(() => current)
  processMutationQueues.set(key, queued)

  await previous.catch(() => {})

  try {
    return await action()
  } finally {
    releaseCurrent()
    if (processMutationQueues.get(key) === queued) {
      processMutationQueues.delete(key)
    }
  }
}

function nowMs(): number {
  return CURRENT_PROCESS_STARTED_AT_MS + (process.uptime() * 1000)
}
