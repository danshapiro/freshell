import fs from 'node:fs'
import path from 'node:path'

export const PROVIDER_PARITY_CASE_IDS = [
  'PC-PARITY-CLAUDE',
  'PC-PARITY-CODEX',
  'PC-PARITY-OPENCODE',
  'PC-PARITY-AMPLIFIER',
  'FA-PARITY-FRESHCLAUDE',
  'FA-PARITY-FRESHCODEX',
  'FA-PARITY-FRESHOPENCODE',
] as const

export type ProviderParityCaseId = typeof PROVIDER_PARITY_CASE_IDS[number]
export type ProviderVisibleTrace = {
  argv: string[]
  env: Record<string, unknown>
  config: unknown
  plugins: string[]
  mcp: { exposed: boolean; tools: string[]; call: unknown }
  operations: unknown[]
  nativeSessionId: string
  [key: string]: unknown
}
export type ProviderParityRow = {
  caseId: ProviderParityCaseId
  direct: ProviderVisibleTrace
  managed: ProviderVisibleTrace
  secretHygiene: { registry: boolean; supervisor: boolean; eventJournal: boolean; docker: boolean }
  onecli: {
    approvedReference: boolean
    unapprovedReferenceRejected: boolean
    referenceProfile: string
    childEnvironmentKey: string
    childValueSha256: string
  }
  recovery: { replacementObserved: boolean; sameNativeSession: boolean }
}
export type ProviderParityReceipt = {
  schemaVersion: 1
  kind: 'provider-parity-local'
  status: 'PASS'
  candidateSha?: string
  rows: ProviderParityRow[]
}

const ids = new Set<string>(PROVIDER_PARITY_CASE_IDS)

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function equal(left: unknown, right: unknown, label: string): void {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]))
    }
    return value
  }
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) {
    throw new Error(`${label} differs between direct and managed routes`)
  }
}

export function validateProviderParityReceipt(value: unknown): ProviderParityReceipt {
  const receipt = record(value, 'provider parity receipt')
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'provider-parity-local' || receipt.status !== 'PASS') {
    throw new Error('provider parity receipt requires schema v1, provider-parity-local kind, and PASS')
  }
  if (!Array.isArray(receipt.rows)) throw new Error('provider parity receipt has no rows')
  const found = new Set<string>()
  for (const [index, raw] of receipt.rows.entries()) {
    const row = record(raw, `provider parity row ${index}`) as unknown as ProviderParityRow
    if (!ids.has(row.caseId) || found.has(row.caseId)) throw new Error(`unknown or duplicate parity case ${row.caseId}`)
    found.add(row.caseId)
    for (const route of ['direct', 'managed'] as const) {
      const trace = record(row[route], `${row.caseId}.${route}`)
      if (!Array.isArray(trace.argv) || !Array.isArray(trace.plugins) || !Array.isArray(trace.operations)
        || typeof trace.nativeSessionId !== 'string' || !trace.nativeSessionId
        || !trace.env || !trace.config) throw new Error(`${row.caseId}.${route} is missing provider-visible evidence`)
      if (row.caseId.startsWith('FA-PARITY-')
        && (trace.argv.length === 0 || Object.keys(record(trace.env, `${row.caseId}.${route}.env`)).length === 0)) {
        throw new Error(`${row.caseId}.${route} is missing provider-visible argv or environment evidence`)
      }
      const mcp = record(trace.mcp, `${row.caseId}.${route}.mcp`)
      if (typeof mcp.exposed !== 'boolean' || !Array.isArray(mcp.tools)
        || (mcp.exposed && mcp.call == null) || (!mcp.exposed && (mcp.tools.length || mcp.call != null))) {
        throw new Error(`${row.caseId}.${route}.mcp must record a call or explicit absence`)
      }
    }
    for (const field of ['argv', 'env', 'config', 'plugins', 'mcp', 'operations', 'nativeSessionId'] as const) {
      equal(row.direct[field], row.managed[field], `${row.caseId}.${field}`)
    }
    const hygiene = record(row.secretHygiene, `${row.caseId}.secretHygiene`)
    for (const field of ['registry', 'supervisor', 'eventJournal', 'docker']) {
      if (hygiene[field] !== true) throw new Error(`${row.caseId}.secretHygiene.${field} is not proven`)
    }
    const onecli = record(row.onecli, `${row.caseId}.onecli`)
    if (onecli.approvedReference !== true || onecli.unapprovedReferenceRejected !== true) {
      throw new Error(`${row.caseId} OneCLI reference validation is not proven`)
    }
    const expectedProvider = row.caseId.replace(/^PC-PARITY-|^FA-PARITY-FRESH/, '').toLowerCase()
    if (typeof onecli.referenceProfile !== 'string'
      || !onecli.referenceProfile.startsWith(`${expectedProvider}_onecli_`)
      || typeof onecli.childEnvironmentKey !== 'string' || !onecli.childEnvironmentKey
      || typeof onecli.childValueSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(onecli.childValueSha256)) {
      throw new Error(`${row.caseId} OneCLI reference and redacted child effect are missing`)
    }
    const recovery = record(row.recovery, `${row.caseId}.recovery`)
    if (recovery.replacementObserved !== true || recovery.sameNativeSession !== true) {
      throw new Error(`${row.caseId} exact replacement and native resume are not proven`)
    }
  }
  for (const caseId of PROVIDER_PARITY_CASE_IDS) {
    if (!found.has(caseId)) throw new Error(`missing local provider parity case ${caseId}`)
  }
  return value as ProviderParityReceipt
}

/** A row is written only after its behavioral fixture's assertions pass. */
export function writeProviderParityRow(directory: string, row: ProviderParityRow): void {
  if (!ids.has(row.caseId)) throw new Error(`unknown parity case ${row.caseId}`)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${row.caseId}.json`)
  fs.writeFileSync(file, JSON.stringify(row), { flag: 'wx', mode: 0o600 })
  fs.appendFileSync(path.join(directory, 'events.jsonl'), `${JSON.stringify({
    severity: 'info', event: 'provider.parity.case.passed', caseId: row.caseId,
    direct: row.direct, managed: row.managed, recovery: row.recovery,
    secretHygiene: row.secretHygiene, onecli: row.onecli,
  })}\n`, { mode: 0o600 })
}

export function readProviderParityReceipt(directory: string): ProviderParityReceipt {
  const rows = PROVIDER_PARITY_CASE_IDS.map(caseId => {
    const file = path.join(directory, `${caseId}.json`)
    if (!fs.existsSync(file)) throw new Error(`missing local provider parity case ${caseId}`)
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProviderParityRow
  })
  return validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows })
}

export function loadProviderParityLocalReceipt(file: string, candidateSha: string): ProviderParityReceipt {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error('local parity receipt must be a private regular file under 16 MiB')
  }
  const receipt = validateProviderParityReceipt(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (receipt.candidateSha !== candidateSha) throw new Error('local parity receipt candidate SHA differs')
  return receipt
}
