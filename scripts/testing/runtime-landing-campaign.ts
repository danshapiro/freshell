/**
 * Candidate-bound Durable Souls qualification campaign.
 *
 * Every invocation owns a UUID-scoped evidence directory. Producer receipt
 * paths are caller-supplied, unique to that invocation and step, and become
 * reusable by a later `--only <gate>` run only after provenance validation.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildReceiptEnvironment,
  defineCampaignProducerStep,
  deriveProductionGateExpectation,
  parseCampaignArguments,
  resolveCampaignOutcome,
  validateGateSummary,
  validateProducerEvidence,
  type CampaignGateExpectation,
  type CampaignStepDescriptor,
} from './runtime-campaign-policy.js'
import {
  candidateIntegrityFailures,
  captureRuntimeCandidate,
  type RuntimeCandidate,
} from './runtime-gate-integrity.js'
import {
  loadCapabilityManifest,
  productionCertificationStatus,
} from './provider-certification.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024
const MAX_POLICY_LOG_BYTES = 8 * 1024 * 1024

type ProducerRunner = 'playwright' | 'receipt'

type ProducerStep = CampaignStepDescriptor & {
  kind: 'producer'
  title: string
  qualificationProviders?: readonly string[]
  explicitLiveOnly?: boolean
  requiredLiveEnv?: string
  runner: ProducerRunner
  run: (env: NodeJS.ProcessEnv, logPath: string) => Promise<number>
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
    runId: string
    status?: unknown
    blockedReason?: unknown
  }
}

function playwright(spec: string, extraEnv: Record<string, string>) {
  return (env: NodeJS.ProcessEnv, logPath: string): Promise<number> => runLogged(
    mise,
    [
      'exec', 'node@22', '--', 'node_modules/.bin/playwright', 'test',
      '--config', 'test/e2e-browser/playwright.config.ts',
      '--project=rust-chromium', '--reporter=line', spec,
    ],
    { ...env, ...extraEnv },
    logPath,
  )
}

const gateManifest = readJsonFile(path.join(repoRoot, 'test/runtime/gate-manifest.json')) as any
const capabilities = loadCapabilityManifest(repoRoot)
const productionReadiness = productionCertificationStatus(capabilities)

const STEPS: Step[] = [
  defineCampaignProducerStep({
    id: 'continuity',
    kind: 'producer',
    title: 'Phase 2 real browser + free-tier OpenCode continuity',
    produces: ['FRESHELL_RUNTIME_BROWSER_RECEIPT', 'FRESHELL_RUNTIME_OPENCODE_RECEIPT'],
    runner: 'playwright',
    run: playwright('test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts', {}),
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
    title: 'Combined Claude/Codex/OpenCode/Amplifier provider certification receipt',
    produces: ['FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT'],
    qualificationProviders: ['claude', 'codex', 'opencode', 'amplifier'],
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
    run: (env: NodeJS.ProcessEnv, logPath: string) => runLogged(
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
  const descriptor = fs.openSync(logPath, 'wx')
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

function relativeEvidencePath(target: string): string {
  const relative = path.relative(repoRoot, target)
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

function verifiedPriorReceipts(candidateSha: string, campaignsRoot: string): Record<string, ReceiptProvenance> {
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
      const absolute = path.resolve(repoRoot, provenance.path)
      const allowedRoot = `${path.resolve(campaignsRoot)}${path.sep}`
      if (!absolute.startsWith(allowedRoot)) continue
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
  fs.writeFileSync(target, JSON.stringify(campaign, null, 2))
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
  console.error(`BLOCKED: ${reason}`)
  console.error(JSON.stringify(campaign, null, 2))
  return 2
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString()
  let parsed
  try {
    parsed = parseCampaignArguments(process.argv.slice(2), STEPS)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(`valid step ids: ${STEPS.map((step) => step.id).join(', ')}`)
    return 1
  }
  if (parsed.list) {
    for (const step of STEPS) console.log(`${step.id}\t${step.title}`)
    return 0
  }

  const selectedSteps = parsed.only === null
    ? STEPS.filter((step) => step.kind !== 'producer' || !step.explicitLiveOnly)
    : parsed.only.map((id) => STEPS.find((step) => step.id === id)!)
  const candidateBefore = captureRuntimeCandidate(repoRoot)
  const candidateSha = candidateBefore.sha
  const runId = randomUUID()
  const campaignsRoot = path.join(repoRoot, '.runtime-evidence', candidateSha, 'campaigns')
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
  const dirtyRehearsal = candidateBefore.dirty
  const prior = dirtyRehearsal ? {} : verifiedPriorReceipts(candidateSha, campaignsRoot)
  const catalogue: Record<string, ReceiptProvenance> = { ...prior }
  const results: StepResult[] = []

  for (const step of selectedSteps) {
    const stepStartedAt = new Date().toISOString()
    const logPath = path.join(logDir, `${step.id}.log`)
    console.log(`\n### ${step.id}: ${step.title}\nlog: ${relativeEvidencePath(logPath)}`)
    const priorPaths = Object.fromEntries(Object.entries(catalogue).map(([name, row]) => [name, path.resolve(repoRoot, row.path)]))

    if (step.kind === 'producer') {
      const targets = currentReceiptTargets(step, campaignRoot)
      const before = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, receiptSnapshot(target)]))
      const environment = buildReceiptEnvironment({
        steps: STEPS,
        currentTargets: targets,
        priorReceipts: priorPaths,
        unresolvedRoot,
      })
      let exitCode = 2
      const failures: string[] = []
      if (step.requiredLiveEnv && process.env[step.requiredLiveEnv] !== '1') {
        const message = `step ${step.id} requires ${step.requiredLiveEnv}=1; a skipped live qualification is never a pass`
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, `${message}\n`)
        failures.push(message)
      } else if (Object.values(before).some((snapshot) => snapshot.exists)) {
        failures.push('one or more isolated receipt targets already existed before the producer')
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        fs.writeFileSync(logPath, `${failures[0]}\n`)
        exitCode = 1
      } else {
        exitCode = await step.run({ ...process.env, ...environment }, logPath)
      }
      const after = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, receiptSnapshot(target)]))
      failures.push(...validateProducerEvidence({
        candidateSha,
        runner: step.runner,
        log: readBoundedLog(logPath),
        receipts: step.produces.map((envName) => ({ envName, before: before[envName], after: after[envName] })),
      }))
      if (exitCode !== 0) failures.push(`producer exited ${exitCode}`)
      const outcome = failures.length === 0 ? 'PASS' : exitCode === 2 ? 'BLOCKED' : 'FAIL'
      const receipts: Record<string, ReceiptProvenance> = {}
      if (outcome === 'PASS') {
        for (const [envName, target] of Object.entries(targets)) {
          const provenance: ReceiptProvenance = {
            path: relativeEvidencePath(target),
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
        title: step.title,
        outcome,
        exitCode,
        log: relativeEvidencePath(logPath),
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
    const summaryPath = path.join(repoRoot, '.runtime-evidence', candidateSha, gateRunId, 'summary.json')
    const environment = buildReceiptEnvironment({
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
      fs.writeFileSync(logPath, `${failures[0]}\n`)
    } else {
      exitCode = await runLogged(
        mise,
        ['exec', 'node@22', '--', 'npm', 'run', 'test:runtime', '--', ...step.gateArgs],
        {
          ...process.env,
          ...environment,
          FRESHELL_RUNTIME_GATE_RUN_ID: gateRunId,
          FRESHELL_RUNTIME_CAMPAIGN_RUN_ID: runId,
          FRESHELL_RUNTIME_CAMPAIGN_STEP_ID: step.id,
        },
        logPath,
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
      title: step.title,
      outcome,
      exitCode,
      log: relativeEvidencePath(logPath),
      startedAt: stepStartedAt,
      finishedAt: new Date().toISOString(),
      failures,
      gate: {
        expected: expectation,
        summaryPath: relativeEvidencePath(summaryPath),
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
    candidateAfter = captureRuntimeCandidate(repoRoot)
    integrityFailures = candidateIntegrityFailures(candidateSha, candidateBefore, candidateAfter)
  } catch (error) {
    integrityFailures = [`could not capture the final candidate: ${error instanceof Error ? error.message : String(error)}`]
  }
  const stepsOk = results.length === selectedSteps.length && results.every((step) => step.outcome === 'PASS')
  const candidateOk = integrityFailures.length === 0
  const productionGatePassed = results.some((step) => step.id === 'production-gate'
    && step.outcome === 'PASS' && step.gate?.status === 'PASS')
  const outcome = resolveCampaignOutcome({
    full: parsed.only === null,
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
    selection: parsed.only === null ? 'full' : 'partial',
    selectedSteps: selectedSteps.map((step) => step.id),
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
  console.log(JSON.stringify({ ...campaign, evidenceDir: relativeEvidencePath(campaignRoot) }, null, 2))
  return outcome.exitCode
}

process.exitCode = await main()
