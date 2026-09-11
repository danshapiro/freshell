import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const DIGEST_RE = /^[0-9a-f]{64}$/
const SECRET_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{20,})/i
export type LoadedPhase5Evidence = {
  evidenceDir: string
  bytes: Record<string, Buffer>
  json: Record<string, Record<string, any>>
  jsonl: Record<string, Record<string, any>[]>
}

/** Read this test's own bounded private observations, not a portable receipt. */
export function loadPhase5Evidence(evidenceDir: string, artifactFiles: Record<string, {fileName: string; format: 'json'|'jsonl'}>): LoadedPhase5Evidence {
  const bytes: Record<string, Buffer> = {}, json: Record<string, Record<string, any>> = {}, jsonl: Record<string, Record<string, any>[]> = {}
  for (const [key, descriptor] of Object.entries(artifactFiles)) {
    // Descriptor names are checked-in constants, not caller-supplied paths.
    if (path.basename(descriptor.fileName) !== descriptor.fileName) throw new Error('observation must use a local filename')
    const content = readPrivateArtifact(path.join(evidenceDir, descriptor.fileName), key)
    assertNoSecretBytes(content, key)
    bytes[key] = content
    if (descriptor.format === 'json') json[key] = parseJsonObject(content, key)
    else jsonl[key] = parseJsonlObjects(content, key)
  }
  validateCleanup(json.cleanup)
  validateBroker(jsonl.broker)
  return { evidenceDir, bytes, json, jsonl }
}

export function validateTestCounts(value: unknown, label: string): void {
  const counts = object(value, label)
  exactKeys(counts, ['total', 'passed', 'failed', 'skipped'], label)
  for (const key of ['total', 'passed', 'failed', 'skipped']) integer(counts[key], `${label}.${key}`)
  if (counts.total <= 0 || counts.passed !== counts.total || counts.failed !== 0 || counts.skipped !== 0) {
    throw new Error(`${label} must prove at least one test, all passed, with no failed or skipped tests`)
  }
}

export function validateCleanupContainsContainer(cleanup: Record<string, any>, containerId: string): void {
  if (!Array.isArray(cleanup.exactContainerIds) || !cleanup.exactContainerIds.includes(containerId)) {
    throw new Error('cleanup evidence does not contain the exact receipt-owned container')
  }
}

export function validateBrokerDestructiveTargets(
  rows: Record<string, any>[],
  containerId: string,
): void {
  if (rows.some((row) => row.destructive === true && row.containerId !== containerId)) {
    throw new Error('broker evidence contains a destructive request outside the exact receipt-owned container')
  }
}

export function exactKeys(value: Record<string, any>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  const missing = expected.filter((key) => !(key in value))
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`)
  if (missing.length) throw new Error(`${label} is missing field(s): ${missing.join(', ')}`)
}

export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, any>
}

export function array(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

export function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

export function equalString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} does not match expected value`)
}

export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value as number
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`)
  return value
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateCleanup(cleanup: Record<string, any>): void {
  exactKeys(cleanup, [
    'ok', 'errors', 'exactContainerIds', 'volumes', 'unsafeBrokerAttempts', 'completedAt',
  ], 'cleanup evidence')
  if (cleanup.ok !== true) throw new Error('cleanup evidence is not successful')
  if (!Array.isArray(cleanup.errors) || cleanup.errors.length !== 0) throw new Error('cleanup evidence contains errors')
  if (!Array.isArray(cleanup.exactContainerIds)
    || cleanup.exactContainerIds.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) {
    throw new Error('cleanup evidence contains an inexact container identity')
  }
  if (!Array.isArray(cleanup.volumes) || cleanup.volumes.some((volume: unknown) => typeof volume !== 'string' || !volume)) {
    throw new Error('cleanup evidence has an invalid volume list')
  }
  if (!Array.isArray(cleanup.unsafeBrokerAttempts) || cleanup.unsafeBrokerAttempts.length !== 0) {
    throw new Error('cleanup evidence contains unsafe broker attempts')
  }
  if (!Number.isFinite(Date.parse(nonEmptyString(cleanup.completedAt, 'cleanup completedAt')))) {
    throw new Error('cleanup completedAt is invalid')
  }
}

function validateBroker(rows: Record<string, any>[]): void {
  if (rows.length === 0) throw new Error('broker evidence contains zero events')
  for (const [index, row] of rows.entries()) {
    const label = `broker evidence row ${index + 1}`
    const required = ['at', 'method', 'url', 'decision', 'destructive', 'unsafeAttempt']
    const optional = ['reason', 'containerId']
    const unknown = Object.keys(row).filter((key) => !required.includes(key) && !optional.includes(key))
    const missing = required.filter((key) => !(key in row))
    if (unknown.length || missing.length) throw new Error(`${label} does not match the strict broker schema`)
    if (!Number.isFinite(Date.parse(nonEmptyString(row.at, `${label}.at`)))) throw new Error(`${label}.at is invalid`)
    nonEmptyString(row.method, `${label}.method`)
    nonEmptyString(row.url, `${label}.url`)
    if (!['forward', 'block', 'inject_failure'].includes(row.decision)) throw new Error(`${label}.decision is invalid`)
    if (typeof row.destructive !== 'boolean' || row.unsafeAttempt !== false) {
      throw new Error('broker evidence contains an unsafe attempt or ambiguous row')
    }
    if (row.reason !== undefined) nonEmptyString(row.reason, `${label}.reason`)
    if (row.containerId !== undefined && !/^[0-9a-f]{64}$/.test(row.containerId)) {
      throw new Error(`${label}.containerId is not exact`)
    }
  }
}

function readPrivateArtifact(filePath: string, label: string): Buffer {
  const stat = lstatRegular(filePath, label)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be private`)
  return readBounded(filePath, stat, label)
}

function readBounded(filePath: string, stat: fs.Stats, label: string): Buffer {
  if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the artifact size limit`)
  if (fs.realpathSync(filePath) !== filePath) throw new Error(`${label} must not traverse a symlink`)
  return fs.readFileSync(filePath)
}

function lstatRegular(filePath: string, label: string): fs.Stats {
  let stat: fs.Stats
  try { stat = fs.lstatSync(filePath) } catch { throw new Error(`${label} is missing or unreadable`) }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`)
  if (stat.nlink !== 1) throw new Error(`${label} must not be a hard-linked evidence file`)
  return stat
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, any> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} is not valid JSON`) }
  return object(value, label)
}

function parseJsonlObjects(bytes: Buffer, label: string): Record<string, any>[] {
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean)
  return lines.map((line, index) => {
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error(`${label} line ${index + 1} is not valid JSON`) }
    return object(value, `${label} line ${index + 1}`)
  })
}

function assertNoSecretBytes(bytes: Buffer, label: string): void {
  if (SECRET_RE.test(bytes.toString('utf8'))) throw new Error(`${label} contains unredacted secret-looking content`)
}
