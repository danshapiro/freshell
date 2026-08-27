import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type DispositionDecision = 'retained' | 'deleted'

export type DispositionReceipt = {
  status: string
  count: number
  source?: string
  command?: string
}

export type NodeTestDispositionRow = {
  oldPath: string
  title: string
  subject: string
  decision: DispositionDecision
  replacementRequired: boolean
  survivingTest: string | null
  requiredLane: string
  selector: string | null
  latestReceipt: string | DispositionReceipt
}

export type NodeTestDispositionLedger = {
  version: 1
  universe: string
  candidateCount: number
  candidatePaths?: string[]
  historicalPaths?: string[]
  rows: NodeTestDispositionRow[]
}

export type VerifyDispositionOptions = {
  root?: string
  expectedCandidateCount?: number
}

const RECEIPT_STRING_RE = /^(PASS|SUPPLEMENTAL|SKIPPED|DELETED)\b/i
const VALID_RECEIPT_STATUSES = new Set(['passed', 'pass', 'supplemental', 'skipped', 'deleted'])
const NONE_VALUES = new Set(['', 'none', 'n/a', 'not-applicable', 'not applicable', 'null'])
const KNOWN_HISTORICAL_PATHS = new Set(['test/e2e/update-flow.test.ts'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRelativePath(value: string): boolean {
  return value.length > 0
    && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:[\\/]/.test(value)
    && value !== '..'
    && !value.startsWith('../')
    && !value.includes('\\')
}

function normalizeReceipt(value: unknown): DispositionReceipt | undefined {
  if (typeof value === 'string') {
    const match = value.match(RECEIPT_STRING_RE)
    if (!match) return undefined
    const status = match[1].toLowerCase()
    return {
      status,
      count: status === 'pass' || status === 'supplemental' ? 1 : 0,
      source: value,
    }
  }
  if (!isRecord(value) || typeof value.status !== 'string' || typeof value.count !== 'number') {
    return undefined
  }
  return {
    status: value.status.toLowerCase(),
    count: value.count,
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
  }
}

function rowKey(row: NodeTestDispositionRow): string {
  return `${row.oldPath}\u0000${row.subject}`
}

function error(errors: string[], row: Partial<NodeTestDispositionRow>, message: string): void {
  const location = typeof row.oldPath === 'string' && row.oldPath ? row.oldPath : '<row>'
  const subject = typeof row.subject === 'string' && row.subject ? ` [${row.subject}]` : ''
  errors.push(`${location}${subject}: ${message}`)
}

function validateRowShape(candidate: unknown, errors: string[], index: number): candidate is NodeTestDispositionRow {
  if (!isRecord(candidate)) {
    errors.push(`row ${index}: expected an object`)
    return false
  }
  const row = candidate as Partial<NodeTestDispositionRow>
  if (typeof row.oldPath !== 'string' || !isRelativePath(row.oldPath)) error(errors, row, 'oldPath must be a repository-relative POSIX path')
  if (typeof row.title !== 'string' || !row.title.trim()) error(errors, row, 'title is unresolved')
  if (typeof row.subject !== 'string' || !row.subject.trim()) error(errors, row, 'subject is unresolved')
  if (row.decision !== 'retained' && row.decision !== 'deleted') error(errors, row, 'decision must be retained or deleted')
  if (typeof row.replacementRequired !== 'boolean') error(errors, row, 'replacementRequired must be boolean')
  if (row.survivingTest !== null && (typeof row.survivingTest !== 'string' || !row.survivingTest.trim())) error(errors, row, 'survivingTest is malformed')
  if (typeof row.requiredLane !== 'string' || !row.requiredLane.trim()) error(errors, row, 'requiredLane is unresolved')
  if (row.selector !== null && (typeof row.selector !== 'string' || !row.selector.trim())) error(errors, row, 'selector is malformed')
  if (!normalizeReceipt(row.latestReceipt)) error(errors, row, 'latestReceipt is missing or has an unknown status')
  return true
}

function validateReplacement(row: NodeTestDispositionRow, errors: string[]): void {
  const receipt = normalizeReceipt(row.latestReceipt)
  if (!receipt) return

  if (row.decision === 'retained' && !row.replacementRequired) {
    error(errors, row, 'retained subject must require a replacement')
  }
  if (row.decision === 'deleted' && row.replacementRequired) {
    error(errors, row, 'deleted subject cannot require a replacement')
  }

  if (!row.replacementRequired) {
    if (row.requiredLane === 'none' && row.selector !== null) error(errors, row, 'non-replacement row has a selector')
    return
  }

  if (!row.survivingTest || NONE_VALUES.has(row.survivingTest.trim().toLowerCase())) error(errors, row, 'replacement test is unresolved')
  if (!row.selector || NONE_VALUES.has(row.selector.trim().toLowerCase())) error(errors, row, 'replacement selector is unresolved')
  if (row.requiredLane === 'none' || row.requiredLane === 'supplemental-t2') {
    error(errors, row, 'optional/supplemental lane cannot satisfy a required replacement')
  }
  if (!VALID_RECEIPT_STATUSES.has(receipt.status)) error(errors, row, `receipt status ${JSON.stringify(receipt.status)} is unknown`)
  if (receipt.status !== 'passed' && receipt.status !== 'pass') {
    error(errors, row, `replacement receipt is not positive (${receipt.status})`)
  }
  if (!Number.isInteger(receipt.count) || receipt.count <= 0) error(errors, row, 'replacement receipt selected zero tests')
  if (!(receipt.source ?? receipt.command ?? '').trim()) error(errors, row, 'replacement receipt has no provenance')
}

/**
 * Validate the deletion ledger without relying on the source files still being
 * present. The old paths are intentionally historical after Task 10; the
 * optional root check only verifies surviving replacement tests.
 */
export async function verifyNodeTestDisposition(
  candidate: unknown,
  options: VerifyDispositionOptions = {},
): Promise<string[]> {
  const errors: string[] = []
  if (!isRecord(candidate)) return ['ledger: expected an object']
  const ledger = candidate as Partial<NodeTestDispositionLedger>
  const expectedCandidateCount = options.expectedCandidateCount ?? 346

  if (ledger.version !== 1) errors.push('ledger: version must be 1')
  if (typeof ledger.universe !== 'string' || !ledger.universe.trim()) errors.push('ledger: universe is unresolved')
  if (ledger.candidateCount !== expectedCandidateCount) errors.push(`ledger: candidateCount must be ${expectedCandidateCount}`)
  if (!Array.isArray(ledger.rows)) {
    errors.push('ledger: rows must be an array')
    return errors
  }

  const candidatePaths = ledger.candidatePaths
  const candidatePathSet = new Set<string>()
  if (candidatePaths !== undefined) {
    if (!Array.isArray(candidatePaths)) {
      errors.push('ledger: candidatePaths must be an array')
    } else {
      for (const [index, candidatePath] of candidatePaths.entries()) {
        if (typeof candidatePath !== 'string' || !isRelativePath(candidatePath)) {
          errors.push(`candidatePaths[${index}]: expected a repository-relative POSIX path`)
          continue
        }
        if (candidatePathSet.has(candidatePath)) errors.push(`duplicate candidate path: ${candidatePath}`)
        candidatePathSet.add(candidatePath)
      }
      if (candidatePaths.length !== ledger.candidateCount) errors.push(`ledger: candidatePaths has ${candidatePaths.length} entries, expected ${ledger.candidateCount}`)
    }
  }

  const historicalPaths = ledger.historicalPaths
  const historicalPathSet = new Set<string>()
  if (historicalPaths !== undefined) {
    if (!Array.isArray(historicalPaths)) {
      errors.push('ledger: historicalPaths must be an array')
    } else {
      for (const [index, historicalPath] of historicalPaths.entries()) {
        if (typeof historicalPath !== 'string' || !isRelativePath(historicalPath)) {
          errors.push(`historicalPaths[${index}]: expected a repository-relative POSIX path`)
          continue
        }
        if (!KNOWN_HISTORICAL_PATHS.has(historicalPath)) {
          errors.push(`historicalPaths[${index}]: path is not an approved prior-task deletion: ${historicalPath}`)
        }
        if (historicalPathSet.has(historicalPath)) errors.push(`duplicate historical path: ${historicalPath}`)
        historicalPathSet.add(historicalPath)
      }
    }
  }

  const rowsByKey = new Map<string, NodeTestDispositionRow>()
  const pathsWithRows = new Set<string>()
  for (const [index, candidateRow] of ledger.rows.entries()) {
    if (!validateRowShape(candidateRow, errors, index)) continue
    const row = candidateRow
    const key = rowKey(row)
    if (rowsByKey.has(key)) errors.push(`duplicate disposition row: ${row.oldPath} [${row.subject}]`)
    rowsByKey.set(key, row)
    pathsWithRows.add(row.oldPath)
    if (candidatePathSet.size > 0 && !candidatePathSet.has(row.oldPath) && !historicalPathSet.has(row.oldPath)) {
      error(errors, row, 'oldPath is not in the closed candidate universe')
    }
    validateReplacement(row, errors)
  }

  if (ledger.rows.length < ledger.candidateCount) errors.push(`ledger: only ${ledger.rows.length} rows for ${ledger.candidateCount} candidate files`)
  const candidateRows = [...pathsWithRows].filter((oldPath) => candidatePathSet.size === 0 || candidatePathSet.has(oldPath))
  if (candidateRows.length !== ledger.candidateCount) errors.push(`ledger: ${candidateRows.length} unique candidate old paths for ${ledger.candidateCount} candidate files`)
  for (const oldPath of pathsWithRows) {
    if (candidatePathSet.size > 0 && !candidatePathSet.has(oldPath) && !historicalPathSet.has(oldPath)) {
      errors.push(`row path is neither a candidate nor an explicitly historical path: ${oldPath}`)
    }
  }
  for (const historicalPath of historicalPathSet) {
    if (!pathsWithRows.has(historicalPath)) errors.push(`historical path without disposition: ${historicalPath}`)
  }
  if (candidatePathSet.size > 0) {
    for (const candidatePath of candidatePathSet) {
      if (!pathsWithRows.has(candidatePath)) errors.push(`stale candidate path without disposition: ${candidatePath}`)
    }
  }

  if (options.root) {
    for (const row of rowsByKey.values()) {
      if (!row.replacementRequired || !row.survivingTest) continue
      try {
        await readFile(path.join(options.root, ...row.survivingTest.split('/')))
      } catch {
        error(errors, row, `surviving test is absent: ${row.survivingTest}`)
      }
    }
  }

  return [...new Set(errors)].sort()
}

export async function loadNodeTestDisposition(root: string): Promise<NodeTestDispositionLedger> {
  const file = path.join(root, 'scripts/retirement/node-test-disposition.json')
  return JSON.parse(await readFile(file, 'utf8')) as NodeTestDispositionLedger
}

async function main(): Promise<void> {
  const root = path.resolve(process.cwd())
  const ledger = await loadNodeTestDisposition(root)
  const errors = await verifyNodeTestDisposition(ledger, { root })
  if (errors.length > 0) {
    for (const item of errors) process.stderr.write(`${item}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(JSON.stringify({
    severity: 'info',
    event: 'node_test_disposition_verified',
    candidateCount: ledger.candidateCount,
    rowCount: ledger.rows.length,
    retainedRows: ledger.rows.filter((row) => row.decision === 'retained').length,
    deletedRows: ledger.rows.filter((row) => row.decision === 'deleted').length,
  }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
