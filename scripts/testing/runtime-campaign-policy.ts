import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { candidateIntegrityFailures, auditRuntimeArtifacts, type RuntimeCandidate } from './runtime-gate-integrity.js'
import { validateProviderQualificationReceipt } from './provider-qualification-receipt.js'
import { validateFreshAgentQualificationReceipt } from './fresh-agent-qualification-receipt.js'
import { validatePhase5LossReceipt } from './runtime-phase5-loss-evidence.js'
import { validatePhase5ChaosReceipt } from './runtime-phase5-chaos-evidence.js'
import { loadRuntimeSoakReceipt } from './runtime-soak-evidence.js'
import { stableJson } from './runtime-phase5-evidence-common.js'
import { loadProviderParityLocalReceipt } from './provider-parity-receipt.js'
import { defaultReceiptFileName } from './runtime-receipts.js'
import { certifiedDurableProviders, releasedFreshAgentModes, loadCapabilityManifest,
  classifyProviderCertificationCase, providerCertificationCaseId, resolveGateOutcome } from './provider-certification.js'

export const TABS_CASE_TITLES = [
  'managed fresh-agent: already-live attach restores stale loss through real hosted HTTP truth',
  'P4-G08: controller inventory reconstructs views without duplicating souls',
] as const

export type BrowserCaseIdentity = { id: string; title: string; file: string }
export type BrowserOriginalReference = { path: string; sha256: string }
export const BROWSER_ORIGINAL_FILES = {
  manifest: 'manifest.json', build: 'build.json', lifecycle: 'lifecycle.jsonl',
  cloudLauncher: 'cloud-launcher-output.json', cleanup: 'cleanup.json', ownershipAfter: 'ownership-after.json',
} as const
export type BrowserOriginalIndex = {
  candidateSha: string
  runId: string
  runtimeImage: string
  browserImage: string
  selected: BrowserCaseIdentity[]
  executed: Array<BrowserCaseIdentity & { status: 'passed' }>
  artifacts: Record<keyof typeof BROWSER_ORIGINAL_FILES, BrowserOriginalReference>
  receiptDigests: Record<string, string>
}

export function isCanonicalPhase5BrowserReceipt(name: string): boolean {
  return name === 'FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT' || name === 'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT'
}

/** Loss and chaos keep their original owner directory because their artifacts are relative to it. */
export function phase5BrowserReceiptOriginal(input: {
  repoRoot: string; candidateSha: string; name: string; originals: BrowserOriginalIndex[]
}): BrowserOriginalReference {
  if (!isCanonicalPhase5BrowserReceipt(input.name)) throw new Error('canonical phase-five browser receipt required')
  const owners = input.originals.filter(original => original.receiptDigests?.[input.name])
  if (owners.length !== 1) throw new Error('canonical receipt requires exactly one current browser owner')
  const owner = owners[0]!
  if (owner.candidateSha !== input.candidateSha || !/^[a-f0-9-]{36}$/.test(owner.runId)) throw new Error('canonical receipt browser owner candidate or run differs')
  const reference = { path: `.runtime-evidence/${input.candidateSha}/${owner.runId}/browser/${defaultReceiptFileName(input.name)}`,
    sha256: owner.receiptDigests[input.name]! }
  const receipt = parseOriginalJson(readCampaignOriginal(input.repoRoot, reference, reference.path))
  if (receipt.receiptRunId !== owner.runId || receipt.candidateSha !== input.candidateSha
    || receipt.runtimeImage !== owner.runtimeImage || receipt.status !== 'PASS') throw new Error('canonical receipt belongs to another browser owner or workload')
  return reference
}

export type CampaignStepDescriptor = {
  id: string
  kind: 'producer' | 'gate'
  produces: readonly string[]
}

/**
 * Registration seam for provider workers adding one isolated receipt
 * producer. Extra execution metadata is preserved by the generic return type;
 * the shared policy validates the stable id and nonempty receipt contract.
 */
export function defineCampaignProducerStep<
  const T extends CampaignStepDescriptor & { kind: 'producer'; title: string },
>(step: T): T {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id)) throw new Error(`invalid producer step id: ${step.id}`)
  if (step.produces.length === 0 || new Set(step.produces).size !== step.produces.length) {
    throw new Error(`producer ${step.id} must declare unique receipt environment variables`)
  }
  for (const name of step.produces) {
    if (!/^FRESHELL_RUNTIME_[A-Z0-9_]+_RECEIPT$/.test(name)) {
      throw new Error(`producer ${step.id} has invalid receipt environment variable: ${name}`)
    }
  }
  return step
}

export type ParsedCampaignArguments = {
  list: boolean
  allowDirty: boolean
  only: string[] | null
  scope: 'default' | 'production' | null
}

export type RuntimeUuid = `${string}-${string}-${string}-${string}-${string}`

export type RuntimeGateLink = {
  gateRunId: RuntimeUuid | undefined
  campaign: { runId: string; stepId: string } | null
}

export function parseRuntimeGateLink(input: {
  gateRunId?: string
  campaignRunId?: string
  campaignStepId?: string
}): RuntimeGateLink {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (input.gateRunId !== undefined && !uuid.test(input.gateRunId)) {
    throw new Error('FRESHELL_RUNTIME_GATE_RUN_ID must be a UUID')
  }
  const hasCampaignValue = input.campaignRunId !== undefined || input.campaignStepId !== undefined
  if (!hasCampaignValue) {
    return { gateRunId: input.gateRunId as RuntimeUuid | undefined, campaign: null }
  }
  if (!input.campaignRunId || !input.campaignStepId || !uuid.test(input.campaignRunId)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.campaignStepId)) {
    throw new Error('runtime campaign provenance is incomplete or malformed')
  }
  return {
    gateRunId: input.gateRunId as RuntimeUuid | undefined,
    campaign: { runId: input.campaignRunId, stepId: input.campaignStepId },
  }
}

export function parseCampaignArguments(
  args: readonly string[],
  steps: readonly CampaignStepDescriptor[],
): ParsedCampaignArguments {
  const validIds = new Set<string>()
  for (const step of steps) {
    if (!step.id || validIds.has(step.id)) throw new Error(`invalid or duplicate campaign step id: ${step.id}`)
    validIds.add(step.id)
  }

  let list = false
  let allowDirty = false
  let only: string[] | null = null
  let scope: 'production' | null = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--list') {
      if (list) throw new Error('duplicate --list')
      list = true
      continue
    }
    if (argument === '--allow-dirty') {
      if (allowDirty) throw new Error('duplicate --allow-dirty')
      allowDirty = true
      continue
    }
    if (argument === '--scope') {
      if (scope !== null) throw new Error('duplicate --scope')
      if (args[++index] !== 'production') throw new Error('--scope requires production')
      scope = 'production'
      continue
    }
    if (argument === '--only') {
      if (only !== null) throw new Error('duplicate --only')
      only = []
      while (index + 1 < args.length && !args[index + 1].startsWith('--')) {
        only.push(args[++index])
      }
      if (only.length === 0) throw new Error('--only requires at least one step id')
      continue
    }
    throw new Error(`unrecognised campaign argument: ${argument}`)
  }

  if (list && (allowDirty || only !== null || args.length !== 1)) {
    throw new Error('--list cannot be combined with campaign execution arguments')
  }
  if (scope !== null && (list || only !== null)) throw new Error('--scope cannot be combined with --list or --only')
  if (only !== null) {
    const seen = new Set<string>()
    for (const id of only) {
      if (!validIds.has(id)) throw new Error(`unknown campaign step: ${id}`)
      if (seen.has(id)) throw new Error(`duplicate campaign step: ${id}`)
      seen.add(id)
    }
  }
  return { list, allowDirty, only, scope: list || only !== null ? null : scope ?? 'default' }
}

export function buildReceiptEnvironment(input: {
  steps: readonly CampaignStepDescriptor[]
  currentTargets: Readonly<Record<string, string>>
  priorReceipts: Readonly<Record<string, string>>
  unresolvedRoot: string
}): Record<string, string> {
  const names = new Set(input.steps.flatMap((step) => [...step.produces]))
  const environment: Record<string, string> = {}
  for (const name of [...names].sort()) {
    environment[name] = input.currentTargets[name]
      ?? input.priorReceipts[name]
      ?? `${input.unresolvedRoot.replace(/\/$/, '')}/${name.toLowerCase()}.json`
  }
  return environment
}

type ReceiptBefore = { exists: boolean }
type ReceiptAfter = {
  exists: boolean
  regularFile?: boolean
  symbolicLink?: boolean
  digestSha256?: string
  value?: unknown
}

export type ProducerEvidenceInput = {
  candidateSha: string
  runner: 'playwright' | 'receipt'
  log: string
  execution?: 'managed-external-browser'
  receipts: Array<{ envName: string; before: ReceiptBefore; after: ReceiptAfter }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function countTestResult(log: string, label: 'passed' | 'skipped' | 'failed' | 'timed out'): number {
  const plain = log.replace(/\u001b\[[0-9;]*m/g, '')
  let total = 0
  for (const match of plain.matchAll(new RegExp(`(?:^|\\s)(\\d+)\\s+${label}\\b`, 'g'))) {
    total += Number.parseInt(match[1], 10)
  }
  return total
}

/** Consume the external adapter's completed, cleanup-settled execution contract.
 * Counts are execution evidence only; original receipt validation stays separate.
 */
export function validateBrowserExecution(log: string, requireAdapter = false): string[] {
  const marker = 'managed_external_browser_passed'
  const summaries = log.split(/\r?\n/).filter((line) => line.includes(marker))
  if (requireAdapter || summaries.length > 0) {
    if (summaries.length !== 1) return ['browser adapter must emit exactly one completed execution summary']
    let event: Record<string, unknown> | null
    try { event = record(JSON.parse(summaries[0])) } catch { return ['browser adapter execution summary is malformed'] }
    const counts = record(event?.counts)
    const keys = ['selected', 'executed', 'passed', 'failed', 'skipped', 'timedOut']
    if (event?.event !== marker || !counts || keys.some((key) => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0)) {
      return ['browser adapter execution counts are missing or invalid']
    }
    if ((counts.selected as number) <= 0 || counts.executed !== counts.selected || counts.passed !== counts.selected
      || counts.failed !== 0 || counts.skipped !== 0 || counts.timedOut !== 0) {
      return ['browser adapter must prove positive matching selected/executed/passed counts with zero failures, skips or timeouts']
    }
    return []
  }
  const failures: string[] = []
  if (countTestResult(log, 'passed') === 0) failures.push('Playwright ran zero passing tests')
  if (countTestResult(log, 'skipped') > 0) failures.push('Playwright reported skipped tests')
  if (countTestResult(log, 'failed') > 0 || countTestResult(log, 'timed out') > 0) failures.push('Playwright reported failed or timed out tests')
  return failures
}

export function validateProducerEvidence(input: ProducerEvidenceInput): string[] {
  const failures: string[] = []
  if (input.runner === 'playwright') {
    failures.push(...validateBrowserExecution(input.log, input.execution === 'managed-external-browser'))
  }
  if (input.receipts.length === 0) failures.push('producer declared no receipt evidence')
  for (const receipt of input.receipts) {
    if (receipt.before.exists) failures.push(`${receipt.envName} target existed before this step`)
    if (!receipt.after.exists) {
      failures.push(`${receipt.envName} was not produced`)
      continue
    }
    if (receipt.after.symbolicLink || receipt.after.regularFile !== true) {
      failures.push(`${receipt.envName} is not a direct regular file`)
    }
    if (!/^[0-9a-f]{64}$/.test(receipt.after.digestSha256 ?? '')) {
      failures.push(`${receipt.envName} has no valid SHA-256 provenance digest`)
    }
    const value = record(receipt.after.value)
    if (!value) {
      failures.push(`${receipt.envName} is not a JSON object`)
      continue
    }
    if (value.status !== 'PASS') failures.push(`${receipt.envName} is not an explicit PASS receipt`)
    if (value.candidateSha !== input.candidateSha) failures.push(`${receipt.envName} belongs to a different candidate`)
  }
  return failures
}

export type CampaignGateExpectation = {
  gateId: string
  phase: 'phase-5'
  mode: 'landing' | 'production'
  status: 'PASS' | 'BLOCKED'
  blockedReason: string | null
  exitCode: 0 | 2
}

export function deriveProductionGateExpectation(input: {
  gateId: string
  eligible: boolean
  blockedReason: string | null
}): CampaignGateExpectation {
  return input.eligible
    ? {
        gateId: input.gateId,
        phase: 'phase-5',
        mode: 'production',
        status: 'PASS',
        blockedReason: null,
        exitCode: 0,
      }
    : {
        gateId: input.gateId,
        phase: 'phase-5',
        mode: 'production',
        status: 'BLOCKED',
        blockedReason: input.blockedReason,
        exitCode: 2,
      }
}

export function validateGateSummary(input: {
  summary: unknown
  expectation: CampaignGateExpectation
  exitCode: number
  candidateSha: string
  gateRunId: string
  campaignRunId: string
  stepId: string
}): string[] {
  const failures: string[] = []
  const summary = record(input.summary)
  if (!summary) return ['gate summary is not a JSON object']
  const expected = input.expectation
  if (input.exitCode !== expected.exitCode) failures.push(`gate exit code ${input.exitCode} did not match expected ${expected.exitCode}`)
  if (summary.gate !== expected.gateId) failures.push('gate identity did not match the requested gate')
  if (summary.phase !== expected.phase) failures.push('gate phase did not match the requested phase')
  if (summary.mode !== expected.mode) failures.push('gate mode did not match the requested mode')
  if (summary.status !== expected.status) failures.push('gate status did not match the expected outcome')
  if ((summary.blockedReason ?? null) !== expected.blockedReason) failures.push('gate blocked reason did not match the expected outcome')
  if (summary.candidateSha !== input.candidateSha) failures.push('gate summary belongs to a different candidate')
  if (summary.runId !== input.gateRunId) failures.push('gate summary belongs to a different run')
  const campaign = record(summary.campaign)
  if (campaign?.runId !== input.campaignRunId || campaign?.stepId !== input.stepId) {
    failures.push('gate summary has mismatched campaign provenance')
  }
  if (record(summary.cleanup)?.ok !== true) failures.push('gate cleanup was not verified')
  if (!Array.isArray(summary.unsafeDockerAttempts) || summary.unsafeDockerAttempts.length !== 0) {
    failures.push('gate recorded unsafe Docker attempts')
  }
  if (!Array.isArray(summary.failures) || summary.failures.length !== 0) failures.push('gate recorded failures')
  if (!Array.isArray(summary.caseResults) || summary.caseResults.length === 0) failures.push('gate has no case results')
  if (!Array.isArray(record(summary.candidateIntegrity)?.failures)
    || (record(summary.candidateIntegrity)?.failures as unknown[]).length !== 0) {
    failures.push('gate candidate integrity was not verified')
  }
  const correlatedExit = summary.status === 'PASS' ? 0 : summary.status === 'BLOCKED' ? 2 : 1
  if (input.exitCode !== correlatedExit) failures.push('gate status and exit code are inconsistent')
  return failures
}

export type CampaignOutcome = {
  status: 'PASS' | 'PARTIAL' | 'BLOCKED' | 'FAIL'
  exitCode: 0 | 1 | 2
  qualifying: boolean
  productionApproval: boolean
}

export function resolveCampaignOutcome(input: {
  full: boolean
  dirtyRehearsal: boolean
  stepsOk: boolean
  candidateOk: boolean
  productionGatePassed?: boolean
  coverageFailures?: readonly string[]
}): CampaignOutcome {
  if (input.dirtyRehearsal) {
    return { status: 'BLOCKED', exitCode: 2, qualifying: false, productionApproval: false }
  }
  if (!input.stepsOk || !input.candidateOk || input.coverageFailures?.length || (input.full && input.productionGatePassed !== true)) {
    return { status: 'FAIL', exitCode: 1, qualifying: false, productionApproval: false }
  }
  if (!input.full) {
    return { status: 'PARTIAL', exitCode: 0, qualifying: false, productionApproval: false }
  }
  return {
    status: 'PASS',
    exitCode: 0,
    qualifying: true,
    productionApproval: input.productionGatePassed === true,
  }
}

export const PRODUCTION_CAMPAIGN_STEP_IDS = [
  'provider-parity-local', 'continuity', 'fresh-agent-qualification', 'resurrection',
  'opencode-qualification', 'managed-provider-qualification', 'rehydrate', 'loss-notice',
  'chaos', 'soak', 'landing-gate', 'production-gate',
] as const

export type CompletedCampaignStep = {
  id: string
  kind: 'producer' | 'gate'
  outcome: string
  exitCode: number
  failures: string[]
  runner?: 'playwright' | 'receipt'
  log: string
  logDigest: string
  receipts?: Record<string, { path: string; digestSha256: string; candidateSha: string; campaignRunId: string; producerStepId: string }>
  gate?: { summaryPath: string; digestSha256: string; runId: string; expected: CampaignGateExpectation }
}

function parseOriginalJson(value: Buffer | string): any {
  try { return JSON.parse(typeof value === 'string' ? value : value.toString('utf8')) }
  catch { throw new Error('original JSON is malformed') }
}

function same(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

/** Reopen an exact original. Digests in the index never replace loading bytes. */
function readCampaignOriginal(root: string, reference: BrowserOriginalReference, expectedPath?: string): Buffer {
  if (!reference || !/^[a-f0-9]{64}$/.test(reference.sha256) || typeof reference.path !== 'string'
    || path.isAbsolute(reference.path) || reference.path.includes('\\')
    || reference.path.split('/').some(part => !part || part === '.' || part === '..')
    || (expectedPath !== undefined && reference.path !== expectedPath)) throw new Error('original reference path or digest is invalid')
  const target = path.resolve(root, reference.path), stat = fs.lstatSync(target)
  if (!target.startsWith(`${fs.realpathSync(root)}${path.sep}`) || fs.realpathSync(target) !== target
    || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
    || stat.size === 0 || stat.size > 16 * 1024 * 1024) throw new Error('original is not a bounded private direct file')
  const bytes = fs.readFileSync(target)
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('original digest mismatch')
  return bytes
}

/** Validate the existing owner/Cloud originals, independently of affirmative CLI counts. */
export function validateBrowserOriginalIndex(input: {
  repoRoot: string; candidateSha: string; runtimeImage: string; browserImage: string; original: BrowserOriginalIndex
}): number {
  const value = input.original
  if (!value || value.candidateSha !== input.candidateSha || value.runtimeImage !== input.runtimeImage
    || value.browserImage !== input.browserImage || !/^[a-f0-9-]{36}$/.test(value.runId)) throw new Error('browser original run, candidate or images differ')
  const evidenceRun = `.runtime-evidence/${input.candidateSha}/${value.runId}`
  const loaded = Object.fromEntries(Object.entries(BROWSER_ORIGINAL_FILES).map(([key, name]) => {
    const bytes = readCampaignOriginal(input.repoRoot, value.artifacts?.[key as keyof typeof BROWSER_ORIGINAL_FILES], `${evidenceRun}/${name}`)
    return [key, name.endsWith('.jsonl') ? bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => parseOriginalJson(line)) : parseOriginalJson(bytes)]
  }))
  if (loaded.manifest.execution?.candidateSha !== input.candidateSha || loaded.manifest.execution?.runId !== value.runId
    || loaded.build.candidateSha !== input.candidateSha || loaded.build.runtimeImage !== input.runtimeImage) throw new Error('browser original build/manifest identity differs')
  const checkedManifest = JSON.parse(fs.readFileSync(path.join(input.repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'))
  for (const name of ['testSupervisor', 'testHost', 'releaseSupervisor', 'releaseHost']) {
    const binary = loaded.build.binaries?.[name]
    if (!binary || !/^[a-f0-9]{64}$/.test(binary.sha256) || !Number.isSafeInteger(binary.bytes) || binary.bytes <= 0 || !binary.path) throw new Error('browser original candidate binaries are missing')
  }
  const { execution: _execution, ...originalManifest } = loaded.manifest
  if (!same(originalManifest, checkedManifest)) throw new Error('browser original manifest differs from candidate source')
  if (loaded.cleanup.ok !== true || !Array.isArray(loaded.cleanup.errors) || loaded.cleanup.errors.length
    || loaded.cleanup.brokerSettlementComplete !== true || loaded.cleanup.verifiedKnownResourcesAbsent !== true
    || loaded.cleanup.verifiedResourcesAbsent !== true || !Array.isArray(loaded.cleanup.brokerSettlementFailures)
    || loaded.cleanup.brokerSettlementFailures.length
    || !Array.isArray(loaded.cleanup.unsafeBrokerAttempts) || loaded.cleanup.unsafeBrokerAttempts.length
    || !Array.isArray(loaded.cleanup.exactContainerIds) || !loaded.cleanup.exactContainerIds.length
    || loaded.cleanup.exactContainerIds.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('browser original cleanup is incomplete')
  const ownership = loaded.ownershipAfter
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)
    || !Array.isArray(ownership.brokerReceipts) || !Array.isArray(ownership.brokerEvents)
    || ownership.brokerReceipts.some((receipt: any) => !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || typeof receipt.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.containerId))) throw new Error('browser original ownership is malformed')
  const cleanupIds = new Set<string>(loaded.cleanup.exactContainerIds)
  if (ownership.brokerReceipts.some((receipt: any) => !cleanupIds.has(receipt.containerId))) throw new Error('browser original owned container is missing from cleanup targets')
  const observedEvents = loaded.lifecycle.filter((row: any) => String(row.event).startsWith('managed_external_')).map((row: any) => ({ ...row.data, event: row.event }))
  const events = [...new Map(observedEvents.map((row: any) => [stableJson(row), row])).values()] as any[]
  const one = (event: string) => {
    const found = events.filter((row: any) => row.event === event)
    if (found.length !== 1 || found[0].candidateSha !== input.candidateSha || found[0].runId !== value.runId) throw new Error('browser original Cloud run authority differs')
    return found[0]
  }
  const reserved = one('managed_external_job_reserved'), created = one('managed_external_job_created')
  const execution = one('managed_external_job_execution'), cases = one('managed_external_cloud_cases'), cleanup = one('managed_external_job_cleanup')
  if (!reserved.jobName || !reserved.account || !reserved.project || !reserved.region || cleanup.ok !== true
    || [created, execution, cases, cleanup].some(row => row.jobName !== reserved.jobName)
    || !execution.executionName || !execution.executionName.startsWith(`${reserved.jobName}-`)
    || cases.executionName !== execution.executionName || created.imageDigest !== input.browserImage
    || execution.imageDigest !== input.browserImage || created.image !== execution.image) throw new Error('browser original job, execution, image or cleanup differs')
  const stdout = loaded.cloudLauncher.stdout
  if (typeof stdout !== 'string' || typeof loaded.cloudLauncher.stderr !== 'string') throw new Error('browser original launcher output is missing')
  const launcher = stdout.split(/\r?\n/).flatMap((line: string) => { try { return [JSON.parse(line)] } catch { return [] } })
  for (const row of [reserved, created, execution, cases, cleanup]) {
    if (!launcher.some((original: any) => same(original, row))) throw new Error('browser lifecycle differs from original launcher output')
  }
  if (!Array.isArray(value.selected) || !value.selected.length || !Array.isArray(value.executed)
    || value.selected.length !== value.executed.length || new Set(value.selected.map(row => row.id)).size !== value.selected.length
    || !Array.isArray(cases.cases)) throw new Error('browser original selected/executed identities are incomplete')
  for (const selected of value.selected) {
    if (!selected.id || !selected.file || !selected.title) throw new Error('browser original selected identity is invalid')
    const matches = (rows: any[]) => rows.filter(row => row.id === selected.id && row.file === selected.file && row.title === selected.title)
    for (const rows of [value.executed, cases.cases]) {
      const executed = matches(rows)
      if (executed.length !== 1 || executed[0].status !== 'passed') throw new Error('browser original selected execution differs')
    }
  }
  if (cases.cases.some((row: any) => !value.selected.some(selected => selected.id === row.id) && row.status !== 'skipped')) throw new Error('browser original contains undeclared executed cases')
  return value.selected.length
}

export function validateProductionCampaignCoverage(input: {
  selectedIds: readonly string[]
  completedSteps: readonly CompletedCampaignStep[]
  originals: { repoRoot: string; campaignRunId: string }
  candidate: { before: RuntimeCandidate; after: RuntimeCandidate | null }
  images: { runtimeImage: string; browserImage: string }
}): { complete: boolean; failures: string[] } {
  const failures: string[] = []
  if (!same(input.selectedIds, PRODUCTION_CAMPAIGN_STEP_IDS)) failures.push('production selection must contain exactly the twelve registered steps in order')
  if (!same(input.completedSteps.map(step => step.id), PRODUCTION_CAMPAIGN_STEP_IDS)) failures.push('production completed coverage is missing, extra or out of order')
  const candidateSha = input.candidate.before.sha
  if (!input.candidate.after) failures.push('production final candidate is missing')
  else failures.push(...candidateIntegrityFailures(candidateSha, input.candidate.before, input.candidate.after))
  const empty = createHash('sha256').update('').digest('hex')
  if (!/^[a-f0-9]{40}$/.test(candidateSha) || input.candidate.before.diffHash !== empty || input.candidate.before.statusHash !== empty) failures.push('production candidate must have exact clean content hashes')
  if (![input.images.runtimeImage, input.images.browserImage].every(image => /^sha256:[a-f0-9]{64}$/.test(image))) failures.push('production runtime and browser images must be exact immutable digests')
  const root = input.originals.repoRoot, runId = input.originals.campaignRunId
  const seenRuns = new Set<string>()
  const environment = (suffix: string) => `FRESHELL_RUNTIME_${suffix}_RECEIPT`
  const requiredSpecs: Record<string, string> = { continuity: 'runtime-terminal-continuity-rust.spec.ts',
    'fresh-agent-qualification': 'runtime-fresh-agent-qualification-rust.spec.ts', resurrection: 'runtime-provider-resurrection-rust.spec.ts',
    'opencode-qualification': 'runtime-opencode-provider-qualification-rust.spec.ts', 'managed-provider-qualification': 'runtime-managed-provider-qualification-rust.spec.ts',
    rehydrate: 'runtime-tabs-rehydrate-rust.spec.ts', 'loss-notice': 'runtime-lost-soul-notice-rust.spec.ts', chaos: 'runtime-chaos-rust.spec.ts' }
  const requiredReceipts: Record<string, string[]> = {
    'provider-parity-local': [environment('PROVIDER_PARITY_LOCAL')], continuity: [environment('BROWSER'), environment('OPENCODE')],
    'fresh-agent-qualification': [environment('PHASE3_FRESH_AGENT'), environment('PHASE5_FRESH_AGENT')],
    resurrection: [environment('PHASE3_BROWSER')], 'opencode-qualification': [environment('PHASE3_PROVIDER'), environment('PHASE5_PROVIDER')],
    'managed-provider-qualification': [environment('PHASE3_PROVIDER'), environment('PHASE5_PROVIDER')], rehydrate: [environment('PHASE4_BROWSER')],
    'loss-notice': [environment('PHASE5_LOSS')], chaos: [environment('PHASE5_CHAOS')], soak: [environment('PHASE5_SOAK')],
  }
  for (const step of input.completedSteps) {
    const check = () => {
      if (!(PRODUCTION_CAMPAIGN_STEP_IDS as readonly string[]).includes(step.id)) throw new Error('unregistered completed step')
      if (step.outcome !== 'PASS' || step.exitCode !== 0 || !Array.isArray(step.failures) || step.failures.length) throw new Error('completed step did not pass')
      const log = readCampaignOriginal(root, { path: step.log, sha256: step.logDigest }, `.runtime-evidence/${candidateSha}/campaigns/${runId}/logs/${step.id}.log`).toString('utf8')
      if (step.kind === 'gate') {
        if (!['landing-gate', 'production-gate'].includes(step.id) || !step.gate) throw new Error('actual gate original is missing')
        const summaryPath = `.runtime-evidence/${candidateSha}/${step.gate.runId}/summary.json`
        const summary = parseOriginalJson(readCampaignOriginal(root, { path: step.gate.summaryPath, sha256: step.gate.digestSha256 }, summaryPath))
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'test/runtime/gate-manifest.json'), 'utf8'))
        const mode = step.id === 'landing-gate' ? 'landing' as const : 'production' as const
        const expected = { gateId: manifest.certification_gates.modes[mode].id, phase: 'phase-5' as const, mode, status: 'PASS' as const, exitCode: 0 as const, blockedReason: null }
        const gateFailures = validateGateSummary({ summary, expectation: expected, exitCode: step.exitCode, candidateSha,
          gateRunId: step.gate.runId, campaignRunId: runId, stepId: step.id })
        if (gateFailures.length) throw new Error(gateFailures.join('; '))
        if (!Array.isArray(summary.cleanup.errors) || summary.cleanup.errors.length) throw new Error('gate original cleanup contains errors')
        if (summary.imageRef !== input.images.runtimeImage || !Array.isArray(summary.requiredCases) || !summary.requiredCases.length
          || new Set(summary.requiredCases).size !== summary.requiredCases.length
          || summary.requiredCases.some((id: string) => summary.caseResults.filter((row: any) => row.caseId === id && row.status === 'PASS').length !== 1)
          || summary.missingArtifacts?.length !== 0 || summary.invalidArtifacts?.length !== 0) throw new Error('gate original scope, image or actual case coverage differs')
        const phase = manifest.phases.find((row: any) => row.id === 'phase-5')
        const expectedCases = [...phase.cumulative_required_case_ids, ...manifest.certification_gates.provider_certification_case_ids, 'EVIDENCE-ARTIFACTS', 'EVIDENCE-CANDIDATE']
        if (!same(summary.requiredCases, phase.cumulative_required_case_ids)
          || !same(summary.providerCertificationCases, manifest.certification_gates.provider_certification_case_ids)
          || summary.caseResults.length !== expectedCases.length
          || expectedCases.some(id => summary.caseResults.filter((row: any) => row.caseId === id).length !== 1)) throw new Error('gate original required case scope is incomplete')
        const capabilities = loadCapabilityManifest(root)
        for (const provider of capabilities.providers) {
          const result = summary.caseResults.find((row: any) => row.caseId === providerCertificationCaseId(provider.provider))
          if (!result) continue
          const classification = classifyProviderCertificationCase(mode, provider)
          const expectedStatus = classification.status === 'REQUIRES_LIVE_RECEIPT' ? 'PASS' : classification.status
          if (result.status !== expectedStatus || (classification.reason !== null && result.reason !== classification.reason)) {
            throw new Error('gate original provider classification differs from declared policy')
          }
        }
        const outcome = resolveGateOutcome({ mode, caseResults: summary.caseResults, expectedCaseIds: expectedCases,
          cleanupOk: summary.cleanup.ok, unsafeBrokerAttempts: summary.unsafeDockerAttempts.length,
          deferred: summary.deferredProviders, deferrableProviders: capabilities.certification.landingGate.deferrableProviders })
        if (outcome.status !== 'PASS') throw new Error('gate original case outcomes differ: ' + outcome.failures.join('; '))
        if (!same(summary.candidateIntegrity.before, input.candidate.before) || !same(summary.candidateIntegrity.after, input.candidate.after)) throw new Error('gate original candidate content differs')
        const audit = auditRuntimeArtifacts(path.dirname(path.join(root, summaryPath)), [
          ...manifest.execution_contract.required_artifacts, ...phase.required_artifacts, ...manifest.certification_gates.required_artifacts,
        ])
        if (audit.missing.length || audit.invalid.length) throw new Error('gate original declared artifacts are missing or invalid')
        return
      }
      const required = requiredReceipts[step.id]
      if (!required || !same(Object.keys(step.receipts ?? {}).sort(), [...required].sort())) throw new Error('completed producer receipt set is incomplete')
      const expectedRunner = requiredSpecs[step.id] ? 'playwright' : 'receipt'
      if (step.runner !== expectedRunner) throw new Error('completed producer runner differs from its registered contract')
      let browserOriginals: BrowserOriginalIndex[] = []
      if (step.runner === 'playwright') {
        const executionFailures = validateBrowserExecution(log, true)
        if (executionFailures.length) throw new Error(executionFailures.join('; '))
        const event = JSON.parse(log.split(/\r?\n/).find(line => line.includes('managed_external_browser_passed'))!)
        if (!Array.isArray(event.originals) || !event.originals.length) throw new Error('attributable browser originals are missing')
        browserOriginals = event.originals
        let selected = 0
        for (const original of browserOriginals) {
          if (seenRuns.has(original.runId)) throw new Error('browser original run is reused across producers')
          seenRuns.add(original.runId)
          if (!original.selected.every(row => row.file === `test/e2e-browser/specs/${requiredSpecs[step.id]}`)) throw new Error('browser original selection belongs to another producer spec')
          selected += validateBrowserOriginalIndex({ repoRoot: root, candidateSha, ...input.images, original })
        }
        if (selected !== event.counts.selected) throw new Error('browser original coverage differs from completed execution counts')
        if (step.id === 'rehydrate') {
          const requiredTitles = TABS_CASE_TITLES.map(title => `Phase 4 managed-runtime tab rehydration › ${title}`)
          const selectedTitles = browserOriginals.flatMap(original => original.selected.map(row => row.title))
          if (browserOriginals.length !== requiredTitles.length || browserOriginals.some(original => original.selected.length !== 1)
            || !same([...selectedTitles].sort(), [...requiredTitles].sort())) throw new Error('browser original required rehydrate cases are incomplete or lack separate owners')
        }
      }
      for (const name of required) {
        const reference = step.receipts![name]
        if (reference.candidateSha !== candidateSha || reference.campaignRunId !== runId || reference.producerStepId !== step.id) throw new Error('receipt provenance belongs to another campaign or producer')
        const expectedPath = isCanonicalPhase5BrowserReceipt(name)
          ? phase5BrowserReceiptOriginal({ repoRoot: root, candidateSha, name, originals: browserOriginals }).path
          : `.runtime-evidence/${candidateSha}/campaigns/${runId}/receipts/${step.id}/${name.toLowerCase()}.json`
        const bytes = readCampaignOriginal(root, { path: reference.path, sha256: reference.digestSha256 }, expectedPath)
        const receipt = parseOriginalJson(bytes)
        if (receipt.status !== 'PASS' || receipt.candidateSha !== candidateSha) throw new Error('receipt original status or candidate differs')
        if (step.runner === 'playwright' && !browserOriginals.some(original => original.receiptDigests?.[name] === reference.digestSha256)) throw new Error('receipt digest is not attributed to its actual browser owner')
        if (receipt.receiptRunId && step.runner === 'playwright' && !browserOriginals.some(original => original.runId === receipt.receiptRunId)) throw new Error('receipt original run differs from actual browser owner')
        if (step.id === 'provider-parity-local') loadProviderParityLocalReceipt(path.join(root, expectedPath), candidateSha)
        else if (step.id === 'opencode-qualification' || step.id === 'managed-provider-qualification') {
          const validated = validateProviderQualificationReceipt({ repoRoot: root, candidateSha, expectedRuntimeImage: input.images.runtimeImage, receipt })
          const providers = step.id === 'opencode-qualification' ? ['opencode'] : certifiedDurableProviders(loadCapabilityManifest(root))
          if (!same(validated.providers.map(row => row.provider), providers)) throw new Error('combined provider original rows are incomplete or reordered')
        } else if (step.id === 'fresh-agent-qualification') {
          const validated = validateFreshAgentQualificationReceipt({ repoRoot: root, candidateSha, expectedRuntimeImage: input.images.runtimeImage, receipt })
          if (!same(validated.rows.map(row => row.mode), releasedFreshAgentModes(loadCapabilityManifest(root)).map(row => row.mode))) throw new Error('combined fresh original rows are incomplete or reordered')
        } else if (step.id === 'loss-notice') validatePhase5LossReceipt({ repoRoot: root, candidateSha, runtimeImage: input.images.runtimeImage, receipt })
        else if (step.id === 'chaos') validatePhase5ChaosReceipt({ repoRoot: root, candidateSha, runtimeImage: input.images.runtimeImage, receipt })
        else if (step.id === 'soak') loadRuntimeSoakReceipt({ repoRoot: root, candidateSha, runtimeImage: input.images.runtimeImage, receipt })
        else if (receipt.runtimeImage !== input.images.runtimeImage) throw new Error('browser receipt runtime image differs')
      }
    }
    try { check() } catch (error) { failures.push(`${step.id}: ${error instanceof Error ? error.message : 'original validation failed'}`) }
  }
  return { complete: failures.length === 0, failures }
}
