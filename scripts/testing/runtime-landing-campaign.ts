/**
 * Candidate-bound Durable Souls qualification campaign.
 *
 * Every invocation owns a UUID-scoped evidence directory. Producer receipts
 * use isolated step targets or their canonical browser owner originals, and become
 * reusable by a later `--only <gate>` run only after provenance validation.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildReceiptEnvironment,
  isCanonicalPhase5BrowserReceipt,
  phase5BrowserReceiptOriginal,
  defineCampaignProducerStep,
  deriveProductionGateExpectation,
  parseCampaignArguments,
  resolveCampaignOutcome,
  validateGateSummary,
  validateProducerEvidence,
  validateProductionCampaignCoverage,
  type CompletedCampaignStep,
  type CampaignGateExpectation,
  type CampaignStepDescriptor,
  type BrowserOriginalIndex,
} from './runtime-campaign-policy.js'
import {
  candidateIntegrityFailures,
  captureRuntimeCandidate,
  type RuntimeCandidate,
} from './runtime-gate-integrity.js'
import {
  loadCapabilityManifest,
  productionCertificationStatus,
  certifiedDurableProviders,
  releasedFreshAgentModes,
} from './provider-certification.js'
import { QUALIFICATION_PROVIDER_SELECTION_ENV } from './provider-qualification-selection.js'
import { FRESH_AGENT_QUALIFICATION_MODES_ENV } from './fresh-agent-qualification-selection.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024
const MAX_POLICY_LOG_BYTES = 8 * 1024 * 1024

type ProducerRunner = 'playwright' | 'receipt'

type ProducerStep = CampaignStepDescriptor & {
  kind: 'producer'
  title: string
  qualificationProviders?: readonly string[]
  qualificationModes?: readonly string[]
  explicitLiveOnly?: boolean
  requiredLiveEnv?: string
  runner: ProducerRunner
  run: (env: NodeJS.ProcessEnv, logPath: string, execute: typeof runLogged) => Promise<number>
}

type GateStep = CampaignStepDescriptor & {
  kind: 'gate'
  title: string
  gateArgs: string[]
  expectation: () => CampaignGateExpectation
}

type Step = ProducerStep | GateStep

type ReceiptSnapshot = {
  exists: boolean
  regularFile?: boolean
  symbolicLink?: boolean
  digestSha256?: string
  value?: unknown
  size?: number
}

type ReceiptProvenance = {
  path: string
  digestSha256: string
  candidateSha: string
  campaignRunId: string
  producerStepId: string
  verifiedAt: string
}

type StepResult = {
  kind: 'producer' | 'gate'
  runner?: ProducerRunner
  logDigest: string
  id: string
  title: string
  outcome: 'PASS' | 'BLOCKED' | 'FAIL'
  exitCode: number
  log: string
  startedAt: string
  finishedAt: string
  failures: string[]
  qualificationProviders?: readonly string[]
  receipts?: Record<string, ReceiptProvenance>
  gate?: {
    expected: CampaignGateExpectation
    summaryPath: string
    digestSha256: string
    runId: string
    status?: unknown
    blockedReason?: unknown
  }
}

export function playwright(spec: string, extraEnv: Record<string, string>, execute = runLogged) {
  return (env: NodeJS.ProcessEnv, logPath: string, childExecute = execute): Promise<number> => childExecute(
    'pnpm',
    ['exec', 'tsx', 'scripts/testing/runtime-external-browser.ts', '--spec', spec],
    { ...env, ...extraEnv },
    logPath,
  )
}

export function campaignGate(
  gateArgs: readonly string[], env: NodeJS.ProcessEnv, logPath: string, execute = runLogged,
): Promise<number> {
  return execute('pnpm', ['run', 'test:runtime', ...gateArgs], env, logPath)
}

const gateManifest = readJsonFile(path.join(repoRoot, 'test/runtime/gate-manifest.json')) as any
const capabilities = loadCapabilityManifest(repoRoot)
const productionReadiness = productionCertificationStatus(capabilities)

const STEPS: Step[] = [
  defineCampaignProducerStep({
    id: 'provider-parity-local',
    kind: 'producer',
    title: 'Deterministic direct and managed provider parity',
    produces: ['FRESHELL_RUNTIME_PROVIDER_PARITY_LOCAL_RECEIPT'],
    runner: 'receipt',
    run: (env: NodeJS.ProcessEnv, logPath: string, execute: typeof runLogged) => execute(
      mise,
      ['exec', 'node@22', '--', 'node_modules/.bin/tsx', 'scripts/testing/run-provider-parity-local.ts'],
      env,
      logPath,
    ),
  }),
  defineCampaignProducerStep({
    id: 'continuity',
    kind: 'producer',
    title: 'Phase 2 real browser + authenticated OpenAI-backed OpenCode continuity',
    produces: ['FRESHELL_RUNTIME_BROWSER_RECEIPT', 'FRESHELL_RUNTIME_OPENCODE_RECEIPT'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts', {}),
  }),
  defineCampaignProducerStep({
    id: 'fresh-agent-qualification',
    kind: 'producer',
    title: 'Authentic hosted qualification for release-enabled fresh-agent modes',
    produces: [
      'FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT',
    ],
    qualificationModes: releasedFreshAgentModes(capabilities).map(row => row.mode),
    explicitLiveOnly: true,
    requiredLiveEnv: 'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE',
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts', {}),
  }),
  defineCampaignProducerStep({
    id: 'resurrection',
    kind: 'producer',
    title: 'Phase 3 live provider resurrection with a real permission prompt',
    produces: ['FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts', {
      FRESHELL_RUNTIME_PHASE3_LIVE: '1',
    }),
  }),
  defineCampaignProducerStep({
    id: 'opencode-qualification',
    kind: 'producer',
    title: 'OpenCode free-tier provider certification receipt',
    produces: ['FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT'],
    qualificationProviders: ['opencode'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts', {
      FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE: '1',
    }),
  }),
  defineCampaignProducerStep({
    id: 'managed-provider-qualification',
    kind: 'producer',
    title: 'Combined receipt for certified durable terminal providers',
    produces: ['FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT'],
    qualificationProviders: certifiedDurableProviders(capabilities),
    explicitLiveOnly: true,
    requiredLiveEnv: 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE',
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts', {}),
  }),
  defineCampaignProducerStep({
    id: 'rehydrate',
    kind: 'producer',
    title: 'Phase 4 tab/view rehydration',
    produces: ['FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts', {}),
  }),
  defineCampaignProducerStep({
    id: 'loss-notice',
    kind: 'producer',
    title: 'Phase 5 real isolated OpenCode loss notice',
    produces: ['FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts', {
      FRESHELL_RUNTIME_PHASE5_LIVE: '1',
    }),
  }),
  defineCampaignProducerStep({
    id: 'chaos',
    kind: 'producer',
    title: 'Phase 5 100-web/20-controller chaos',
    produces: ['FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-chaos-rust.spec.ts', {
      FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE: '1',
    }),
  }),
  defineCampaignProducerStep({
    id: 'soak',
    kind: 'producer',
    title: '>=30 minute, >=50 soul CPU/memory/PID pressure soak',
    produces: ['FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT'],
    runner: 'receipt',
    run: (env: NodeJS.ProcessEnv, logPath: string, execute: typeof runLogged) => execute(
      mise,
      ['exec', 'node@22', '--', 'node_modules/.bin/tsx', 'scripts/testing/runtime-phase5-soak.ts'],
      env,
      logPath,
    ),
  }),
  {
    id: 'landing-gate',
    kind: 'gate',
    title: 'Landing / pre-certification gate',
    produces: [],
    gateArgs: ['gate', 'landing', '--require-live'],
    expectation: () => ({
      gateId: gateManifest.certification_gates.modes.landing.id,
      phase: 'phase-5',
      mode: 'landing',
      status: 'PASS',
      blockedReason: null,
      exitCode: 0,
    }),
  },
  {
    id: 'production-gate',
    kind: 'gate',
    title: 'Full production Gate 5',
    produces: [],
    gateArgs: ['gate', 'phase-5', '--require-live'],
    expectation: () => deriveProductionGateExpectation({
      gateId: gateManifest.certification_gates.modes.production.id,
      eligible: productionReadiness.status === 'ELIGIBLE',
      blockedReason: productionReadiness.reason,
    }),
  },
]

async function runLogged(command: string, args: string[], env: NodeJS.ProcessEnv, logPath: string): Promise<number> {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const header = Buffer.from(`startedAt=${new Date().toISOString()}\ncommand=${JSON.stringify([command, ...args])}\n`)
  const descriptor = fs.openSync(logPath, 'wx', 0o600)
  let written = 0
  let truncated = false
  const write = (chunk: Buffer | string) => {
    if (truncated) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = MAX_POLICY_LOG_BYTES - written
    if (remaining <= 0) {
      truncated = true
      return
    }
    const accepted = bytes.subarray(0, remaining)
    fs.writeSync(descriptor, accepted)
    written += accepted.length
    if (accepted.length !== bytes.length) truncated = true
  }
  write(header)
  try {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', write)
    child.stderr.on('data', write)
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false
      const finish = (value: number) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      child.once('error', (error) => {
        write(`\nspawnError=${String(error)}\n`)
        finish(1)
      })
      child.once('close', (code, signal) => {
        if (signal) write(`\nsignal=${signal}\n`)
        finish(code ?? 1)
      })
    })
    if (truncated) {
      // The cap is an evidence property, not a reason to kill the producer.
      // Receipt verification still determines whether the completed step ran.
      fs.writeSync(descriptor, Buffer.from('\n[campaign log truncated at 8 MiB]\n'))
    }
    return exitCode
  } finally {
    fs.closeSync(descriptor)
  }
}

function readJsonFile(file: string): unknown {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} is not a direct regular file`)
  if (stat.size === 0 || stat.size > MAX_CONTROL_FILE_BYTES) throw new Error(`${file} has an invalid control-file size`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readBoundedLog(file: string): string {
  const stat = fs.statSync(file)
  const length = Math.min(stat.size, MAX_POLICY_LOG_BYTES)
  const descriptor = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(descriptor, buffer, 0, length, stat.size - length)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(descriptor)
  }
}

function receiptSnapshot(file: string): ReceiptSnapshot {
  try {
    const stat = fs.lstatSync(file)
    const symbolicLink = stat.isSymbolicLink()
    const regularFile = stat.isFile()
    if (symbolicLink || !regularFile || stat.size === 0 || stat.size > MAX_CONTROL_FILE_BYTES) {
      return { exists: true, symbolicLink, regularFile, size: stat.size }
    }
    const bytes = fs.readFileSync(file)
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { value = undefined }
    return {
      exists: true,
      symbolicLink: false,
      regularFile: true,
      size: stat.size,
      digestSha256: createHash('sha256').update(bytes).digest('hex'),
      value,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

function relativeEvidencePath(target: string, root = repoRoot): string {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`evidence escaped repository root: ${target}`)
  }
  return relative
}

function currentReceiptTargets(step: ProducerStep, campaignRoot: string): Record<string, string> {
  return Object.fromEntries(step.produces.map((name) => [
    name,
    path.join(campaignRoot, 'receipts', step.id, `${name.toLowerCase()}.json`),
  ]))
}

function canonicalPhase5ReceiptFromLog(root: string, candidateSha: string, name: string, log: string) {
  const events = log.split(/\r?\n/).filter(line => line.includes('managed_external_browser_passed')).map(line => JSON.parse(line))
  if (events.length !== 1) throw new Error('canonical receipt requires one completed browser execution')
  return phase5BrowserReceiptOriginal({ repoRoot: root, candidateSha, name, originals: events[0].originals as BrowserOriginalIndex[] })
}

function verifiedPriorReceipts(candidateSha: string, campaignsRoot: string, root = repoRoot): Record<string, ReceiptProvenance> {
  if (!fs.existsSync(campaignsRoot)) return {}
  const manifests = fs.readdirSync(campaignsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(campaignsRoot, entry.name, 'campaign.json'))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  const found: Record<string, ReceiptProvenance> = {}
  for (const manifestPath of manifests) {
    let manifest: any
    try { manifest = readJsonFile(manifestPath) } catch { continue }
    if (manifest.candidateSha !== candidateSha || manifest.candidateQualified !== true
      || !['PASS', 'PARTIAL'].includes(manifest.status)) continue
    for (const [envName, provenance] of Object.entries(manifest.receipts ?? {}) as Array<[string, ReceiptProvenance]>) {
      if (found[envName] || provenance.candidateSha !== candidateSha || provenance.campaignRunId !== manifest.runId) continue
      const absolute = path.resolve(root, provenance.path)
      const allowedRoot = `${path.resolve(campaignsRoot)}${path.sep}`
      if (!absolute.startsWith(allowedRoot)) {
        if (!isCanonicalPhase5BrowserReceipt(envName)) continue
        try {
          const step = manifest.steps?.find((row: StepResult) => row.id === provenance.producerStepId)
          if (step?.log !== `.runtime-evidence/${candidateSha}/campaigns/${manifest.runId}/logs/${provenance.producerStepId}.log`
            || createHash('sha256').update(fs.readFileSync(path.resolve(root, step.log))).digest('hex') !== step.logDigest) continue
          const log = readBoundedLog(path.resolve(root, step.log))
          const original = canonicalPhase5ReceiptFromLog(root, candidateSha, envName, log)
          if (original.path !== provenance.path || original.sha256 !== provenance.digestSha256) continue
        } catch { continue }
      }
      const snapshot = receiptSnapshot(absolute)
      const value = snapshot.value as any
      if (snapshot.regularFile !== true || snapshot.symbolicLink || snapshot.digestSha256 !== provenance.digestSha256
        || value?.candidateSha !== candidateSha || value?.status !== 'PASS') continue
      found[envName] = provenance
    }
  }
  return found
}

function writeCampaign(campaignRoot: string, campaign: unknown): void {
  fs.mkdirSync(campaignRoot, { recursive: true })
  const target = path.join(campaignRoot, 'campaign.json')
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite campaign evidence: ${target}`)
  fs.writeFileSync(target, JSON.stringify(campaign, null, 2), { mode: 0o600 })
}

function blockedPreflight(
  startedAt: string,
  runId: string,
  campaignRoot: string,
  candidate: RuntimeCandidate,
  selectedSteps: readonly Step[],
  reason: string,
): number {
  const campaign = {
    schemaVersion: 2,
    runId,
    candidateSha: candidate.sha,
    startedAt,
    finishedAt: new Date().toISOString(),
    selection: 'blocked-preflight',
    selectedSteps: selectedSteps.map((step) => step.id),
    candidateBefore: candidate,
    candidateAfter: null,
    candidateIntegrityFailures: [reason],
    candidateQualified: false,
    dirtyRehearsal: false,
    receipts: {},
    steps: [],
    status: 'BLOCKED',
    qualifying: false,
    productionApproval: false,
  }
  writeCampaign(campaignRoot, campaign)
  console.error(JSON.stringify({ severity: 'warn', event: 'runtime_campaign_preflight_refused', runId, candidateSha: candidate.sha, reason }))
  console.error(JSON.stringify(campaign, null, 2))
  return 2
}

export type CampaignRunnerOptions = {
  repoRoot?: string
  environment?: NodeJS.ProcessEnv
  captureCandidate?: typeof captureRuntimeCandidate
  execute?: typeof runLogged
}

/** The CLI and focused integration tests share the same filesystem/child loop. */
export async function runCampaign(args: readonly string[], options: CampaignRunnerOptions = {}): Promise<number> {
  const root = options.repoRoot ?? repoRoot
  const environment = options.environment ?? process.env
  const captureCandidate = options.captureCandidate ?? captureRuntimeCandidate
  const execute = options.execute ?? runLogged
  const evidencePath = (target: string) => relativeEvidencePath(target, root)
  const startedAt = new Date().toISOString()
  let parsed
  try {
    parsed = parseCampaignArguments(args, STEPS)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(`valid step ids: ${STEPS.map((step) => step.id).join(', ')}`)
    return 1
  }
  if (parsed.list) {
    for (const step of STEPS) console.log(`${step.id}\t${step.title}`)
    return 0
  }

  const selectedSteps = parsed.scope === 'production' ? STEPS
    : parsed.only === null ? STEPS.filter((step) => step.kind !== 'producer' || !step.explicitLiveOnly)
      : parsed.only.map((id) => STEPS.find((step) => step.id === id)!)
  const candidateBefore = captureCandidate(root)
  const candidateSha = candidateBefore.sha
  const runId = randomUUID()
  const campaignsRoot = path.join(root, '.runtime-evidence', candidateSha, 'campaigns')
  const campaignRoot = path.join(campaignsRoot, runId)
  const logDir = path.join(campaignRoot, 'logs')
  const unresolvedRoot = path.join(campaignRoot, 'unproduced')

  try {
    fs.mkdirSync(campaignsRoot, { recursive: true })
    fs.mkdirSync(campaignRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error(`FAIL: refusing to overwrite existing campaign evidence run ${runId}`)
      return 1
    }
    throw error
  }

  if (candidateBefore.dirty && !parsed.allowDirty) {
    return blockedPreflight(
      startedAt,
      runId,
      campaignRoot,
      candidateBefore,
      selectedSteps,
      'candidate contains tracked or untracked modifications; commit before qualification or use --allow-dirty for a non-qualifying rehearsal',
    )
  }
  if (parsed.scope === 'production') {
    const missing = STEPS.filter((step): step is ProducerStep => step.kind === 'producer' && Boolean(step.requiredLiveEnv))
      .filter((step) => environment[step.requiredLiveEnv!] !== '1')
    if (missing.length) return blockedPreflight(startedAt, runId, campaignRoot, candidateBefore, selectedSteps,
      `production scope requires ${missing.map((step) => `${step.requiredLiveEnv}=1`).join(' and ')} before dispatch`)
  }
  const dirtyRehearsal = candidateBefore.dirty
  const prior = dirtyRehearsal ? {} : verifiedPriorReceipts(candidateSha, campaignsRoot, root)
  const catalogue: Record<string, ReceiptProvenance> = { ...prior }
  const results: StepResult[] = []

  for (const step of selectedSteps) {
    const stepStartedAt = new Date().toISOString()
    const logPath = path.join(logDir, `${step.id}.log`)
    console.log(`\n### ${step.id}: ${step.title}\nlog: ${evidencePath(logPath)}`)
    const priorPaths = Object.fromEntries(Object.entries(catalogue).map(([name, row]) => [name, path.resolve(root, row.path)]))

    if (step.kind === 'producer') {
      const targets = currentReceiptTargets(step, campaignRoot)
      const before = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, receiptSnapshot(target)]))
      const receiptEnvironment = buildReceiptEnvironment({
        steps: STEPS,
        currentTargets: targets,
        priorReceipts: priorPaths,
        unresolvedRoot,
      })
      let exitCode = 2
      const failures: string[] = []
      if (step.requiredLiveEnv && environment[step.requiredLiveEnv] !== '1') {
        const message = `step ${step.id} requires ${step.requiredLiveEnv}=1; a skipped live qualification is never a pass`
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, `${message}\n`, { mode: 0o600 })
        failures.push(message)
      } else if (Object.values(before).some((snapshot) => snapshot.exists)) {
        failures.push('one or more isolated receipt targets already existed before the producer')
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, `${failures[0]}\n`, { mode: 0o600 })
        exitCode = 1
      } else {
        const producerEnvironment = { ...environment, ...receiptEnvironment }
        if (parsed.scope === 'production') {
          if (step.qualificationProviders) producerEnvironment[QUALIFICATION_PROVIDER_SELECTION_ENV] = step.qualificationProviders.join(',')
          if (step.qualificationModes) producerEnvironment[FRESH_AGENT_QUALIFICATION_MODES_ENV] = step.qualificationModes.join(',')
        }
        for (const name of step.produces.filter(isCanonicalPhase5BrowserReceipt)) delete producerEnvironment[name]
        exitCode = await step.run(producerEnvironment, logPath, execute)
      }
      const producerLog = readBoundedLog(logPath)
      for (const name of step.produces.filter(isCanonicalPhase5BrowserReceipt)) {
        try {
          const original = canonicalPhase5ReceiptFromLog(root, candidateSha, name, producerLog)
          targets[name] = path.resolve(root, original.path)
        } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : 'canonical original missing'}`) }
      }
      const after = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, receiptSnapshot(target)]))
      failures.push(...validateProducerEvidence({
        candidateSha,
        runner: step.runner,
        ...(step.runner === 'playwright' ? { execution: 'managed-external-browser' as const } : {}),
        log: producerLog,
        receipts: step.produces.map((envName) => ({ envName, before: before[envName], after: after[envName] })),
      }))
      if (exitCode !== 0) failures.push(`producer exited ${exitCode}`)
      const outcome = failures.length === 0 ? 'PASS' : exitCode === 2 ? 'BLOCKED' : 'FAIL'
      const receipts: Record<string, ReceiptProvenance> = {}
      if (outcome === 'PASS') {
        for (const [envName, target] of Object.entries(targets)) {
          const provenance: ReceiptProvenance = {
            path: evidencePath(target),
            digestSha256: after[envName].digestSha256!,
            candidateSha,
            campaignRunId: runId,
            producerStepId: step.id,
            verifiedAt: new Date().toISOString(),
          }
          receipts[envName] = provenance
          catalogue[envName] = provenance
        }
      }
      results.push({
        id: step.id,
        kind: 'producer',
        runner: step.runner,
        logDigest: createHash('sha256').update(fs.readFileSync(logPath)).digest('hex'),
        title: step.title,
        outcome,
        exitCode,
        log: evidencePath(logPath),
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        failures,
        receipts,
        ...(step.qualificationProviders ? { qualificationProviders: step.qualificationProviders } : {}),
      })
      if (outcome !== 'PASS') break
      continue
    }

    const expectation = step.expectation()
    const gateRunId = randomUUID()
    const summaryPath = path.join(root, '.runtime-evidence', candidateSha, gateRunId, 'summary.json')
    const receiptEnvironment = buildReceiptEnvironment({
      steps: STEPS,
      currentTargets: {},
      priorReceipts: priorPaths,
      unresolvedRoot,
    })
    let exitCode = 1
    const failures: string[] = []
    if (fs.existsSync(path.dirname(summaryPath))) {
      failures.push('isolated gate evidence target existed before this step')
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, `${failures[0]}\n`, { mode: 0o600 })
    } else {
      exitCode = await campaignGate(
        step.gateArgs,
        {
          ...environment,
          ...receiptEnvironment,
          FRESHELL_RUNTIME_GATE_RUN_ID: gateRunId,
          FRESHELL_RUNTIME_CAMPAIGN_RUN_ID: runId,
          FRESHELL_RUNTIME_CAMPAIGN_STEP_ID: step.id,
        },
        logPath,
        execute,
      )
    }
    let summary: unknown
    try { summary = readJsonFile(summaryPath) } catch (error) {
      failures.push(`gate wrote no valid summary at its exact run path: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (summary !== undefined) {
      failures.push(...validateGateSummary({
        summary,
        expectation,
        exitCode,
        candidateSha,
        gateRunId,
        campaignRunId: runId,
        stepId: step.id,
      }))
    }
    const outcome = failures.length === 0 ? 'PASS' : 'FAIL'
    results.push({
      id: step.id,
      kind: 'gate',
      logDigest: createHash('sha256').update(fs.readFileSync(logPath)).digest('hex'),
      title: step.title,
      outcome,
      exitCode,
      log: evidencePath(logPath),
      startedAt: stepStartedAt,
      finishedAt: new Date().toISOString(),
      failures,
      gate: {
        expected: expectation,
        summaryPath: evidencePath(summaryPath),
        digestSha256: receiptSnapshot(summaryPath).digestSha256 ?? '',
        runId: gateRunId,
        status: (summary as any)?.status,
        blockedReason: (summary as any)?.blockedReason,
      },
    })
    if (outcome !== 'PASS') break
  }

  let candidateAfter: RuntimeCandidate | null = null
  let integrityFailures: string[]
  try {
    candidateAfter = captureCandidate(root)
    integrityFailures = candidateIntegrityFailures(candidateSha, candidateBefore, candidateAfter)
  } catch (error) {
    integrityFailures = [`could not capture the final candidate: ${error instanceof Error ? error.message : String(error)}`]
  }
  const stepsOk = results.length === selectedSteps.length && results.every((step) => step.outcome === 'PASS')
  const candidateOk = integrityFailures.length === 0
  const productionGatePassed = results.some((step) => step.id === 'production-gate'
    && step.outcome === 'PASS' && step.gate?.status === 'PASS')
  const gateOriginal = results.find(step => step.id === 'production-gate')?.gate
  const gateSummary = gateOriginal ? receiptSnapshot(path.join(root, gateOriginal.summaryPath)).value as any : undefined
  let browserImage = ''
  for (const step of results) {
    if (step.runner !== 'playwright') continue
    try {
      const event = JSON.parse(readBoundedLog(path.join(root, step.log)).split(/\r?\n/).find(line => line.includes('managed_external_browser_passed'))!)
      browserImage = event.originals?.[0]?.browserImage ?? ''
      if (browserImage) break
    } catch { /* Missing originals are reported by coverage, never inferred. */ }
  }
  const coverage = parsed.scope === 'production' ? validateProductionCampaignCoverage({
    selectedIds: selectedSteps.map(step => step.id), completedSteps: results as CompletedCampaignStep[],
    originals: { repoRoot: root, campaignRunId: runId }, candidate: { before: candidateBefore, after: candidateAfter },
    images: { runtimeImage: gateSummary?.imageRef ?? '', browserImage },
  }) : null
  if (coverage && !coverage.complete) console.error(JSON.stringify({ severity: 'warn', event: 'runtime_campaign_readiness_refused', runId, candidateSha, failures: coverage.failures }))
  const outcome = resolveCampaignOutcome({
    full: parsed.scope === 'production' && coverage?.complete === true,
    coverageFailures: coverage?.failures,
    dirtyRehearsal,
    stepsOk,
    candidateOk,
    productionGatePassed,
  })
  const campaign = {
    schemaVersion: 2,
    runId,
    candidateSha,
    startedAt,
    finishedAt: new Date().toISOString(),
    selection: parsed.scope ?? 'partial',
    selectedSteps: selectedSteps.map((step) => step.id),
    coverage,
    candidateBefore,
    candidateAfter,
    candidateIntegrityFailures: integrityFailures,
    candidateQualified: !dirtyRehearsal && candidateOk,
    dirtyRehearsal,
    receipts: catalogue,
    steps: results,
    ...outcome,
  }
  writeCampaign(campaignRoot, campaign)
  console.log(JSON.stringify({ ...campaign, evidenceDir: evidencePath(campaignRoot) }, null, 2))
  return outcome.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCampaign(process.argv.slice(2))
}
