import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_RECEIPT_BYTES = 1024 * 1024
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA_RE = /^[0-9a-f]{40}$/

export type CandidateReceiptSource = {
  receipt: Record<string, any>
  receiptRunId: string
  evidenceDir: string
  sourcePath: string
  sourceSha256: string
  sourceBytes: Buffer
}

export type ReadCandidateReceiptSourceInput = {
  repoRoot: string
  candidateSha: string
  source: string
  expectedFileName: string
  kind: string
  registry?: ReceiptRunRegistry
}

type ClaimedRun = {
  candidateSha: string
  kind: string
  sourcePath: string
  sourceSha256: string
}

/**
 * A gate may read the same provider receipt for two cases, so an identical
 * reload is idempotent. Reusing the run ID for a different receipt kind,
 * candidate, path, or byte sequence is always rejected.
 */
export class ReceiptRunRegistry {
  private readonly claims = new Map<string, ClaimedRun>()

  claim(receiptRunId: string, claim: ClaimedRun): void {
    const prior = this.claims.get(receiptRunId)
    if (!prior) {
      this.claims.set(receiptRunId, claim)
      return
    }
    if (stableJson(prior) !== stableJson(claim)) {
      throw new Error('receipt run id was reused by different evidence')
    }
  }
}

/**
 * Resolve an externally supplied receipt path before any phase-specific
 * fields are trusted. Inline JSON and convenience paths are intentionally not
 * accepted: a production receipt must be the canonical file produced inside
 * its exact candidate/run evidence directory.
 */
export function readCandidateReceiptSource(
  input: ReadCandidateReceiptSourceInput,
): CandidateReceiptSource {
  if (!SHA_RE.test(input.candidateSha)) {
    throw new Error('expected candidate SHA must be a full lowercase git SHA')
  }
  if (path.basename(input.expectedFileName) !== input.expectedFileName || !input.expectedFileName.endsWith('.json')) {
    throw new Error('expected receipt filename must be one JSON basename')
  }
  const supplied = input.source.trim()
  if (!supplied) throw new Error('runtime receipt must be supplied as a path')
  if (supplied.startsWith('{') || supplied.startsWith('[')) {
    throw new Error('inline JSON is not accepted as runtime receipt evidence; supply its canonical path')
  }

  const repoRoot = fs.realpathSync(input.repoRoot)
  const sourcePath = path.resolve(repoRoot, supplied)
  const sourceStat = lstatRegular(sourcePath, 'runtime receipt')
  if ((sourceStat.mode & 0o077) !== 0) {
    throw new Error('runtime receipt permissions must be private')
  }
  if (sourceStat.size > MAX_RECEIPT_BYTES) {
    throw new Error(`runtime receipt exceeds the ${MAX_RECEIPT_BYTES}-byte size limit`)
  }
  const sourceBytes = fs.readFileSync(sourcePath)
  let parsed: unknown
  try {
    parsed = JSON.parse(sourceBytes.toString('utf8'))
  } catch {
    throw new Error('runtime receipt is not valid JSON')
  }
  const receipt = object(parsed, 'runtime receipt')
  if (receipt.candidateSha !== input.candidateSha) {
    throw new Error('runtime receipt candidate SHA does not match the expected candidate')
  }
  const receiptRunId = safeRunId(receipt.receiptRunId)
  const evidenceRun = `.runtime-evidence/${input.candidateSha}/${receiptRunId}`
  if (receipt.evidenceRun !== evidenceRun) {
    throw new Error('runtime receipt evidence run does not match its candidate SHA and run id')
  }
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', input.candidateSha, receiptRunId)
  const browserDir = path.join(evidenceDir, 'browser')
  const expectedPath = path.join(browserDir, input.expectedFileName)
  if (sourcePath !== expectedPath) {
    throw new Error('runtime receipt is not at its canonical candidate evidence path')
  }
  assertRealDirectory(path.join(repoRoot, '.runtime-evidence'), 'runtime evidence root')
  assertRealDirectory(path.join(repoRoot, '.runtime-evidence', input.candidateSha), 'candidate evidence root')
  assertRealDirectory(evidenceDir, 'receipt evidence run')
  assertRealDirectory(browserDir, 'receipt browser evidence directory')
  if (fs.realpathSync(sourcePath) !== sourcePath) {
    throw new Error('runtime receipt must not traverse a symbolic link')
  }

  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  input.registry?.claim(receiptRunId, {
    candidateSha: input.candidateSha,
    kind: input.kind,
    sourcePath,
    sourceSha256,
  })
  return { receipt, receiptRunId, evidenceDir, sourcePath, sourceSha256, sourceBytes }
}

function safeRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_RE.test(value) || value === '.' || value === '..') {
    throw new Error('runtime receipt run id is invalid')
  }
  return value
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, any>
}

function lstatRegular(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    throw new Error(`${label} is not readable`)
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  return stat
}

function assertRealDirectory(dir: string, label: string): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(dir)
  } catch {
    throw new Error(`${label} is missing`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
    throw new Error(`${label} must be a real directory, not a symbolic link`)
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
