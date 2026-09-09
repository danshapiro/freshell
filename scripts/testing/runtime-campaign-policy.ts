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
  if (only !== null) {
    const seen = new Set<string>()
    for (const id of only) {
      if (!validIds.has(id)) throw new Error(`unknown campaign step: ${id}`)
      if (seen.has(id)) throw new Error(`duplicate campaign step: ${id}`)
      seen.add(id)
    }
  }
  return { list, allowDirty, only }
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
  receipts: Array<{ envName: string; before: ReceiptBefore; after: ReceiptAfter }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function countTestResult(log: string, label: 'passed' | 'skipped'): number {
  const plain = log.replace(/\u001b\[[0-9;]*m/g, '')
  let total = 0
  for (const match of plain.matchAll(new RegExp(`(?:^|\\s)(\\d+)\\s+${label}\\b`, 'g'))) {
    total += Number.parseInt(match[1], 10)
  }
  return total
}

export function validateProducerEvidence(input: ProducerEvidenceInput): string[] {
  const failures: string[] = []
  if (input.runner === 'playwright') {
    if (countTestResult(input.log, 'passed') === 0) failures.push('Playwright ran zero passing tests')
    if (countTestResult(input.log, 'skipped') > 0) failures.push('Playwright reported skipped tests')
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
}): CampaignOutcome {
  if (input.dirtyRehearsal) {
    return { status: 'BLOCKED', exitCode: 2, qualifying: false, productionApproval: false }
  }
  if (!input.stepsOk || !input.candidateOk) {
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
