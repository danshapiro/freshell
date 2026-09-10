import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const FULL_SHA_RE = /^[0-9a-f]{40}$/
const DIGEST_RE = /^[0-9a-f]{64}$/
const IMAGE_RE = /^sha256:[0-9a-f]{64}$/
const SECRET_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{20,})/i

export type ArtifactReference = { path: string; sha256: string }
export type RuntimeCandidateEvidence = {
  sha: string
  dirty: boolean
  diffHash: string
  statusHash: string
}

export type Phase5BaseReceipt = {
  schemaVersion: 2
  kind: string
  status: 'PASS'
  candidateSha: string
  runtimeImage: string
  receiptRunId: string
  evidenceRun: string
  candidateIntegrity: {
    before: RuntimeCandidateEvidence
    after: RuntimeCandidateEvidence
    failures: string[]
  }
  artifacts: Record<string, ArtifactReference>
  summary: unknown
}

export type LoadedPhase5Evidence = {
  receipt: Phase5BaseReceipt
  repoRoot: string
  evidenceDir: string
  evidenceRun: string
  bytes: Record<string, Buffer>
  json: Record<string, Record<string, any>>
  jsonl: Record<string, Record<string, any>[]>
  sourceReceiptSha256: string
}

export function loadPhase5Evidence(input: {
  repoRoot: string
  candidateSha: string
  runtimeImage: string
  receipt: unknown
  kind: string
  artifactFiles: Record<string, { fileName: string; format: 'json' | 'jsonl' }>
}): LoadedPhase5Evidence {
  fullSha(input.candidateSha, 'expected candidate SHA')
  runtimeImage(input.runtimeImage)
  const receipt = object(input.receipt, 'Phase 5 receipt')
  exactKeys(receipt, [
    'schemaVersion', 'kind', 'status', 'candidateSha', 'runtimeImage',
    'receiptRunId', 'evidenceRun', 'candidateIntegrity', 'artifacts', 'summary',
  ], 'Phase 5 receipt')
  if (receipt.schemaVersion !== 2) throw new Error('Phase 5 receipt must use evidence-bound schema v2')
  if (receipt.kind !== input.kind) throw new Error(`Phase 5 receipt kind must be ${input.kind}`)
  if (receipt.status !== 'PASS') throw new Error('Phase 5 receipt status is not PASS')
  equalString(receipt.candidateSha, input.candidateSha, 'Phase 5 receipt candidate SHA')
  equalString(receipt.runtimeImage, input.runtimeImage, 'Phase 5 receipt runtime image')
  const receiptRunId = safeRunId(receipt.receiptRunId)
  const evidenceRun = `.runtime-evidence/${input.candidateSha}/${receiptRunId}`
  equalString(receipt.evidenceRun, evidenceRun, 'Phase 5 receipt evidence run')
  validateCandidateIntegrity(receipt.candidateIntegrity, input.candidateSha)

  const repoRoot = fs.realpathSync(input.repoRoot)
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', input.candidateSha, receiptRunId)
  realDirectory(evidenceDir, 'Phase 5 evidence run')
  const artifacts = object(receipt.artifacts, 'Phase 5 receipt artifacts')
  exactKeys(artifacts, Object.keys(input.artifactFiles), 'Phase 5 receipt artifacts')
  const bytes: Record<string, Buffer> = {}
  const json: Record<string, Record<string, any>> = {}
  const jsonl: Record<string, Record<string, any>[]> = {}
  for (const [key, descriptor] of Object.entries(input.artifactFiles)) {
    const artifact = object(artifacts[key], `artifact ${key}`)
    exactKeys(artifact, ['path', 'sha256'], `artifact ${key}`)
    equalString(artifact.path, `${evidenceRun}/${descriptor.fileName}`, `artifact ${key} path`)
    digest(artifact.sha256, `artifact ${key} SHA-256`)
    const target = path.join(evidenceDir, descriptor.fileName)
    const content = readPrivateArtifact(target, `artifact ${key}`)
    if (sha256(content) !== artifact.sha256) throw new Error(`artifact ${key} hash mismatch`)
    assertNoSecretBytes(content, `artifact ${key}`)
    bytes[key] = content
    if (descriptor.format === 'json') json[key] = parseJsonObject(content, `artifact ${key}`)
    else jsonl[key] = parseJsonlObjects(content, `artifact ${key}`)
  }

  const startedAt = validateRunManifest(repoRoot, json.manifest, input.candidateSha, receiptRunId)
  validateArtifactFreshness(evidenceDir, input.artifactFiles, startedAt)
  validateBuild(json.build, input.candidateSha, input.runtimeImage)
  validateCleanup(json.cleanup)
  validateBroker(jsonl.broker)
  validateCapabilityInventory(repoRoot, json.capabilityInventory, bytes.capabilityInventory)
  return {
    receipt: receipt as Phase5BaseReceipt,
    repoRoot,
    evidenceDir,
    evidenceRun,
    bytes,
    json,
    jsonl,
    sourceReceiptSha256: sha256(Buffer.from(stableJson(receipt))),
  }
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

export function captureRuntimeReceiptCandidate(repoRoot: string): RuntimeCandidateEvidence {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const sha = git(['rev-parse', 'HEAD']).trim()
  fullSha(sha, 'candidate SHA')
  const diff = Buffer.from(git(['diff', '--binary', '--no-ext-diff', 'HEAD']))
  const status = Buffer.from(git(['status', '--porcelain=v1', '--untracked-files=all']))
  return {
    sha,
    dirty: status.length > 0,
    diffHash: sha256(diff),
    statusHash: sha256(status),
  }
}

export function artifactReference(
  evidenceDir: string,
  evidenceRun: string,
  fileName: string,
): ArtifactReference {
  const target = path.join(evidenceDir, fileName)
  const bytes = readPrivateArtifact(target, `artifact ${fileName}`)
  return { path: `${evidenceRun}/${fileName}`, sha256: sha256(bytes) }
}

function validateCandidateIntegrity(value: unknown, candidateSha: string): void {
  const integrity = object(value, 'candidate integrity')
  exactKeys(integrity, ['before', 'after', 'failures'], 'candidate integrity')
  const validate = (candidateValue: unknown, label: string) => {
    const candidate = object(candidateValue, label)
    exactKeys(candidate, ['sha', 'dirty', 'diffHash', 'statusHash'], label)
    equalString(candidate.sha, candidateSha, `${label}.sha`)
    if (candidate.dirty !== false) throw new Error(`${label} must prove a clean candidate`)
    digest(candidate.diffHash, `${label}.diffHash`)
    digest(candidate.statusHash, `${label}.statusHash`)
    return candidate
  }
  const before = validate(integrity.before, 'candidate integrity before')
  const after = validate(integrity.after, 'candidate integrity after')
  const emptyDigest = sha256(Buffer.alloc(0))
  if (before.diffHash !== emptyDigest || before.statusHash !== emptyDigest
    || after.diffHash !== emptyDigest || after.statusHash !== emptyDigest) {
    throw new Error('clean candidate integrity must contain the exact empty diff and status hashes')
  }
  if (stableJson(before) !== stableJson(after)) throw new Error('candidate changed while Phase 5 receipt was produced')
  if (!Array.isArray(integrity.failures) || integrity.failures.length !== 0) {
    throw new Error('candidate integrity receipt contains failures')
  }
}

function validateRunManifest(
  repoRoot: string,
  manifest: Record<string, any>,
  candidateSha: string,
  runId: string,
): number {
  const execution = object(manifest.execution, 'run manifest execution')
  exactKeys(execution, ['candidateSha', 'runId', 'startedAt'], 'run manifest execution')
  equalString(execution.candidateSha, candidateSha, 'run manifest candidate SHA')
  equalString(execution.runId, runId, 'run manifest run id')
  const startedAt = Date.parse(nonEmptyString(execution.startedAt, 'run manifest startedAt'))
  if (!Number.isFinite(startedAt)) throw new Error('run manifest startedAt is invalid')
  const source = parseJsonObject(readPrivateOrPublicRegular(
    path.join(repoRoot, 'test/runtime/gate-manifest.json'),
    'checked-in runtime gate manifest',
  ), 'checked-in runtime gate manifest')
  if (stableJson(manifest) !== stableJson({ ...source, execution })) {
    throw new Error('run manifest differs from the exact checked-in candidate manifest plus execution identity')
  }
  return startedAt
}

function validateArtifactFreshness(
  evidenceDir: string,
  artifacts: Record<string, { fileName: string }>,
  startedAt: number,
): void {
  const futureLimit = Date.now() + 5 * 60_000
  for (const descriptor of Object.values(artifacts)) {
    const stat = fs.lstatSync(path.join(evidenceDir, descriptor.fileName))
    if (stat.mtimeMs + 1 < startedAt || stat.mtimeMs > futureLimit) {
      throw new Error(`artifact ${descriptor.fileName} does not have fresh run provenance`)
    }
  }
}

function validateBuild(build: Record<string, any>, candidateSha: string, image: string): void {
  exactKeys(build, ['candidateSha', 'runtimeImage', 'rustc', 'node', 'docker', 'binaries'], 'build evidence')
  equalString(build.candidateSha, candidateSha, 'build candidate SHA')
  equalString(build.runtimeImage, image, 'build runtime image')
  for (const key of ['rustc', 'node', 'docker']) nonEmptyString(build[key], `build evidence.${key}`)
  const binaries = object(build.binaries, 'build evidence binaries')
  exactKeys(binaries, ['testSupervisor', 'testHost', 'releaseSupervisor', 'releaseHost'], 'build evidence binaries')
  for (const [key, candidate] of Object.entries(binaries)) {
    const binary = object(candidate, `build binary ${key}`)
    exactKeys(binary, ['path', 'sha256', 'bytes'], `build binary ${key}`)
    nonEmptyString(binary.path, `build binary ${key}.path`)
    digest(binary.sha256, `build binary ${key}.sha256`)
    if (integer(binary.bytes, `build binary ${key}.bytes`) === 0) {
      throw new Error(`build binary ${key} has zero bytes`)
    }
  }
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

function validateCapabilityInventory(repoRoot: string, copy: Record<string, any>, bytes: Buffer): void {
  if (copy.schemaVersion !== 1 || !Array.isArray(copy.providers)) {
    throw new Error('capability inventory has an unsupported schema')
  }
  const source = readPrivateOrPublicRegular(
    path.join(repoRoot, 'docs/development/runtime-provider-capabilities.json'),
    'checked-in capability inventory',
  )
  const parsed = parseJsonObject(source, 'checked-in capability inventory')
  if (stableJson(parsed) !== stableJson(copy) || sha256(source) !== sha256(bytes)) {
    throw new Error('capability inventory copy differs from the exact checked-in candidate source')
  }
}

function readPrivateArtifact(filePath: string, label: string): Buffer {
  const stat = lstatRegular(filePath, label)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be private`)
  return readBounded(filePath, stat, label)
}

function readPrivateOrPublicRegular(filePath: string, label: string): Buffer {
  const stat = lstatRegular(filePath, label)
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

function realDirectory(dir: string, label: string): void {
  let stat: fs.Stats
  try { stat = fs.lstatSync(dir) } catch { throw new Error(`${label} is missing`) }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
    throw new Error(`${label} must be a real directory`) }
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

function safeRunId(value: unknown): string {
  const runId = nonEmptyString(value, 'receipt run id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error('receipt run id is unsafe')
  }
  return runId
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !FULL_SHA_RE.test(value)) throw new Error(`${label} must be a full lowercase git SHA`)
  return value
}

function runtimeImage(value: unknown): string {
  if (typeof value !== 'string' || !IMAGE_RE.test(value)) throw new Error('runtime image must be pinned by SHA-256')
  return value
}
