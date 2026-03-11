import fsp from 'node:fs/promises'
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
  const latestRuns = await readCommandRuns(storeDir)
  latestRuns.byKey[record.entrypoint.commandKey] = record
  await writeJsonFile(storeDir, COMMAND_RUNS_FILE, latestRunsFileSchema.parse(latestRuns))
}

export async function recordSuiteResult(storeDir: string, result: LatestRunRecord): Promise<void> {
  const record = latestRunRecordSchema.parse(result)
  const suiteKey = record.entrypoint.suiteKey
  if (!suiteKey) return

  const latestRuns = await readSuiteRuns(storeDir)
  latestRuns.byKey[suiteKey] = record
  await writeJsonFile(storeDir, SUITE_RUNS_FILE, latestRunsFileSchema.parse(latestRuns))
}

export async function recordReusableSuccess(storeDir: string, result: ReusableSuccessRecord): Promise<void> {
  const record = reusableSuccessRecordSchema.parse(result)
  if (record.outcome !== 'success' || record.repo.isDirty !== false) {
    return
  }

  const reusableSuccesses = await readReusableSuccesses(storeDir)
  reusableSuccesses.byReusableKey[record.reusableKey] = record
  await writeJsonFile(storeDir, REUSABLE_SUCCESS_FILE, reusableSuccessFileSchema.parse(reusableSuccesses))
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
  const tempPath = path.join(storeDir, `${fileName}.${process.pid}.${Date.now()}.tmp`)
  const payload = JSON.stringify(data, null, 2)

  await fsp.writeFile(tempPath, payload)
  await fsp.rename(tempPath, finalPath)
}
