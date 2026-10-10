import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productionCertificationStatus, loadCapabilityManifest } from '../../../../scripts/testing/provider-certification.js'
import { BROWSER_ORIGINAL_FILES, validateBrowserOriginalIndex, validateProductionCampaignCoverage } from '../../../../scripts/testing/runtime-campaign-policy.js'
import { ManagedExternalBrowserLifecycle, dispatchOwnedExternalBrowser } from '../../../../scripts/testing/runtime-external-browser.js'
import * as providerEvidence from '../../../../scripts/testing/provider-qualification-receipt.js'
import * as freshEvidence from '../../../../scripts/testing/fresh-agent-qualification-receipt.js'
import * as lossEvidence from '../../../../scripts/testing/runtime-phase5-loss-evidence.js'
import * as chaosEvidence from '../../../../scripts/testing/runtime-phase5-chaos-evidence.js'
import * as soakEvidence from '../../../../scripts/testing/runtime-soak-evidence.js'
import * as parityEvidence from '../../../../scripts/testing/provider-parity-receipt.js'
import { runCampaign } from '../../../../scripts/testing/runtime-landing-campaign.js'

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const production = productionCertificationStatus(loadCapabilityManifest(process.cwd()))
const ids = ['provider-parity-local', 'continuity', 'fresh-agent-qualification', 'resurrection', 'opencode-qualification',
  'managed-provider-qualification', 'rehydrate', 'loss-notice', 'chaos', 'soak', 'landing-gate', 'production-gate']
const candidate = { sha: 'a'.repeat(40), dirty: false, diffHash: 'e'.repeat(64), statusHash: 'e'.repeat(64) }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-campaign-'))
  roots.push(root)
  const dispatches: Array<{ args: string[], env: NodeJS.ProcessEnv }> = []
  const execute = async (_command: string, args: string[], env: NodeJS.ProcessEnv, log: string) => {
    dispatches.push({ args, env })
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, JSON.stringify({ event: 'managed_external_browser_passed', counts: {
      selected: 2, executed: 2, passed: 2, failed: 0, skipped: 0, timedOut: 0,
    } }), { mode: 0o600 })
    for (const [name, target] of Object.entries(env)) {
      if (name.endsWith('_RECEIPT') && target?.includes('/receipts/') && !fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, JSON.stringify({ status: 'PASS', candidateSha: candidate.sha }), { mode: 0o600 })
      }
    }
    if (env.FRESHELL_RUNTIME_GATE_RUN_ID) {
      const landing = args.includes('landing')
      const status = landing || production.status === 'ELIGIBLE' ? 'PASS' : 'BLOCKED'
      const target = path.join(root, '.runtime-evidence', candidate.sha, env.FRESHELL_RUNTIME_GATE_RUN_ID, 'summary.json')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify({
        gate: landing ? 'durable-souls-landing' : 'durable-souls-production-gate-5', phase: 'phase-5',
        mode: landing ? 'landing' : 'production', status, blockedReason: status === 'PASS' ? null : production.reason,
        candidateSha: candidate.sha, runId: env.FRESHELL_RUNTIME_GATE_RUN_ID,
        campaign: { runId: env.FRESHELL_RUNTIME_CAMPAIGN_RUN_ID, stepId: env.FRESHELL_RUNTIME_CAMPAIGN_STEP_ID },
        cleanup: { ok: true }, unsafeDockerAttempts: [], failures: [], caseResults: [{ caseId: 'fictional', status: 'PASS' }],
        candidateIntegrity: { failures: [] },
      }), { mode: 0o600 })
      return status === 'PASS' ? 0 : 2
    }
    return 0
  }
  const options = { repoRoot: root, environment: {}, captureCandidate: () => candidate, execute }
  const manifest = () => JSON.parse(fs.readFileSync(path.join(root, '.runtime-evidence', candidate.sha, 'campaigns',
    fs.readdirSync(path.join(root, '.runtime-evidence', candidate.sha, 'campaigns'))[0], 'campaign.json'), 'utf8'))
  return { options, dispatches, manifest }
}

async function browserOriginalFixture(f = fixture(), spec = 'runtime-tabs-rehydrate-rust.spec.ts') {
  const root = f.options.repoRoot, runId = randomUUID()
  const runtimeImage = `sha256:${'b'.repeat(64)}`, browserImage = `sha256:${'c'.repeat(64)}`
  const evidenceDir = path.join(root, '.runtime-evidence', candidate.sha, runId)
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'test/runtime'), { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/runtime/gate-manifest.json'), 'utf8'))
  fs.writeFileSync(path.join(root, 'test/runtime/gate-manifest.json'), JSON.stringify(manifest))
  const cases = [{ id: 'case-owned', title: 'P4-G08: controller inventory reconstructs views without duplicating souls',
    file: `test/e2e-browser/specs/${spec}` }]
  const executed = cases.map(row => ({ ...row, status: 'passed' as const }))
  const job = { severity: 'info', runId, candidateSha: candidate.sha, jobName: 'fictional-job' }
  const image = 'registry.invalid/browser@' + browserImage, executionName = 'fictional-job-execution'
  const events = [
    { ...job, event: 'managed_external_job_reserved', account: 'fictional', project: 'fictional', region: 'fictional' },
    { ...job, event: 'managed_external_job_created', image, imageDigest: browserImage },
    { ...job, event: 'managed_external_job_execution', executionName, image, imageDigest: browserImage },
    { ...job, event: 'managed_external_cloud_cases', executionName, cases: executed },
    { ...job, event: 'managed_external_job_cleanup', ok: true },
  ]
  const files: Record<string, unknown> = {
    manifest: { ...manifest, execution: { candidateSha: candidate.sha, runId, startedAt: new Date().toISOString() } },
    build: { candidateSha: candidate.sha, runtimeImage, binaries: Object.fromEntries(['testSupervisor', 'testHost', 'releaseSupervisor', 'releaseHost'].map(name => [name, { path: '/fictional/' + name, bytes: 1, sha256: 'f'.repeat(64) }])) },
    lifecycle: events.map(data => JSON.stringify({ at: new Date().toISOString(), event: data.event, data })).join('\n'),
    cloudLauncher: { stdout: events.map(event => JSON.stringify(event)).join('\n'), stderr: '' },
    cleanup: { ok: true, errors: [], exactContainerIds: ['d'.repeat(64)], unsafeBrokerAttempts: [],
      brokerSettlementFailures: [], brokerSettlementComplete: true, verifiedKnownResourcesAbsent: true, verifiedResourcesAbsent: true },
    ownershipAfter: { brokerReceipts: [], brokerEvents: [] },
  }
  for (const [key, file] of Object.entries(BROWSER_ORIGINAL_FILES)) {
    fs.writeFileSync(path.join(evidenceDir, file), typeof files[key] === 'string' ? files[key] as string : JSON.stringify(files[key]), { mode: 0o600 })
  }
  const receipt = path.join(evidenceDir, 'browser/fictional-receipt.json')
  fs.mkdirSync(path.dirname(receipt))
  fs.writeFileSync(receipt, JSON.stringify({ candidateSha: candidate.sha, runtimeImage, status: 'PASS' }), { mode: 0o600 })
  const owned = new ManagedExternalBrowserLifecycle(root, { FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT: receipt })
  Object.assign(owned, { owner: { runtime: { candidateSha: candidate.sha, imageRef: runtimeImage, runId, evidenceDir,
    lifecyclePath: path.join(evidenceDir, 'lifecycle.jsonl') }, stop: async () => ({ ok: true, errors: [] }) },
    descriptor: { candidateSha: candidate.sha, runId } })
  return { ...f, owned, cases, executed, evidenceDir, events, files, runtimeImage, browserImage }
}

describe('actual campaign dispatch and outcome with fictional children', () => {
  it('accepts the existing external adapter handoff for a partial rehydrate child', async () => {
    const f = fixture()
    expect(await runCampaign(['--only', 'rehydrate'], f.options)).toBe(0)
    expect(f.dispatches).toHaveLength(1)
    expect(f.dispatches[0].args).toEqual(['exec', 'tsx', 'scripts/testing/runtime-external-browser.ts', '--spec',
      'test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts'])
    expect(f.manifest()).toMatchObject({ selection: 'partial', status: 'PARTIAL', qualifying: false,
      productionApproval: false, steps: [{ id: 'rehydrate', outcome: 'PASS' }] })
  })
  it.each([{}, { FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '1' },
    { FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: 'true', FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1' }])(
    'refuses production before any producer without both exact live opt-ins: %j', async (environment) => {
      const f = fixture()
      expect(await runCampaign(['--scope', 'production'], { ...f.options, environment })).toBe(2)
      expect(f.dispatches).toHaveLength(0)
      expect(f.manifest()).toMatchObject({ status: 'BLOCKED', qualifying: false, productionApproval: false })
    })
  it('keeps the default selection partial and omits both explicit live producers', async () => {
    const f = fixture()
    expect(await runCampaign([], f.options)).toBe(0)
    expect(f.manifest()).toMatchObject({ selection: 'default', status: 'PARTIAL', qualifying: false })
    expect(f.manifest().selectedSteps).toEqual(ids.filter(id => !['fresh-agent-qualification', 'managed-provider-qualification'].includes(id)))
  })
  it('keeps an explicit list of all twelve partial and preserves caller order', async () => {
    const f = fixture()
    expect(await runCampaign(['--only', ...ids], { ...f.options, environment: {
      FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '1', FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
    } })).toBe(0)
    expect(f.manifest()).toMatchObject({ selection: 'partial', status: 'PARTIAL', qualifying: false, selectedSteps: ids })
    expect(f.manifest().steps.map((step: { id: string }) => step.id)).toEqual(ids)
    const singleton = f.manifest().steps.find((step: { id: string }) => step.id === 'opencode-qualification').receipts.FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT.path
    const combined = f.manifest().steps.find((step: { id: string }) => step.id === 'managed-provider-qualification').receipts.FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT.path
    expect(singleton).not.toBe(combined)
    expect(f.dispatches.at(-1)?.env.FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT).toBe(path.join(f.options.repoRoot, combined))
    expect(f.dispatches.map(row => row.env.FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE)).toEqual(ids.map(() => '1'))
  })
  it('dispatches canonical production in exact order and refuses unbound fictional originals', async () => {
    const f = fixture()
    expect(await runCampaign(['--scope', 'production'], { ...f.options, environment: {
      FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '1', FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
    } })).toBe(1)
    expect(f.manifest().steps.map((step: { id: string }) => step.id)).toEqual(ids)
    expect(f.manifest()).toMatchObject({ selection: 'production', status: 'FAIL', qualifying: false, productionApproval: false,
      coverage: { complete: false } })
    expect(f.manifest().coverage.failures.some((failure: string) => failure.includes('attributable browser originals'))).toBe(true)
  })
  it('preserves child failure despite positive adapter counts and receipts', async () => {
    const f = fixture()
    expect(await runCampaign(['--only', 'rehydrate'], { ...f.options, execute: async (...args) => {
      await f.options.execute(...args); return 1
    } })).toBe(1)
    expect(f.manifest()).toMatchObject({ status: 'FAIL', steps: [{ outcome: 'FAIL', exitCode: 1 }] })
  })
  it('keeps an allowed dirty rehearsal blocked', async () => {
    const f = fixture()
    expect(await runCampaign(['--allow-dirty', '--only', 'rehydrate'], {
      ...f.options, captureCandidate: () => ({ ...candidate, dirty: true }),
    })).toBe(2)
    expect(f.manifest()).toMatchObject({ status: 'BLOCKED', qualifying: false, productionApproval: false })
  })
})

describe('actual finalized browser publisher and independently loaded originals', () => {
  it('refuses early publication and preserves exact current private original references after cleanup', async () => {
    const f = await browserOriginalFixture()
    expect(() => f.owned.publishOriginals(f.cases, f.executed)).toThrow(/cleanup/)
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    expect(validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toBe(1)
    expect(original.receiptDigests.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT).toMatch(/^[a-f0-9]{64}$/)
    const before = fs.readFileSync(path.join(f.evidenceDir, 'lifecycle.jsonl'))
    f.owned.publishOriginals(f.cases, f.executed)
    expect(fs.readFileSync(path.join(f.evidenceDir, 'lifecycle.jsonl')).equals(before)).toBe(true)
    fs.appendFileSync(path.join(f.evidenceDir, 'cleanup.json'), ' ')
    expect(() => validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toThrow(/digest/)
  })
  it('accepts repeated identical lifecycle observations while retaining one actual Cloud execution', async () => {
    const f = await browserOriginalFixture()
    const lifecycle = path.join(f.evidenceDir, 'lifecycle.jsonl')
    fs.appendFileSync(lifecycle, '\n' + fs.readFileSync(lifecycle, 'utf8'))
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    expect(validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toBe(1)
  })
  it('passes actual dispatcher results into the actual campaign validator and reopens attributable owner originals', async () => {
    const f = await browserOriginalFixture()
    const execute = async (_command: string, _args: string[], environment: NodeJS.ProcessEnv, logPath: string) => {
      Object.assign(f.owned, { environment, receiptBefore: {} })
      const target = environment.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT!
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify({ candidateSha: candidate.sha, runtimeImage: f.runtimeImage, status: 'PASS' }), { mode: 0o600 })
      const result = await dispatchOwnedExternalBrowser({ spec: f.cases[0].file }, { FRESHELL_E2E_BACKEND: 'cloud' }, {
        start: async () => ({ FRESHELL_E2E_TARGET_URL: 'https://fictional.invalid', FRESHELL_E2E_TARGET_WS_URL: 'wss://fictional.invalid/ws',
          FRESHELL_E2E_TARGET_TOKEN: 'fictional-unused', FRESHELL_RUNTIME_EXTERNAL_RUN_ID: (f.owned as any).descriptor.runId,
          FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: candidate.sha }), list: async () => f.cases,
        child: async () => ({ exitCode: 0, cases: f.executed }), finish: () => f.owned.finish(), abort: () => f.owned.abort(),
        publishOriginals: (selected, executed) => f.owned.publishOriginals(selected, executed),
      })
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, JSON.stringify({ event: 'managed_external_browser_passed', counts: {
        selected: result.selected, executed: result.executed, passed: result.passed, failed: result.failed, skipped: result.skipped, timedOut: result.timedOut,
      }, originals: result.originals }), { mode: 0o600 })
      return 0
    }
    await runCampaign(['--only', 'rehydrate'], { ...f.options, execute })
    const campaign = f.manifest()
    const input = { selectedIds: campaign.selectedSteps, completedSteps: campaign.steps,
      originals: { repoRoot: f.options.repoRoot, campaignRunId: campaign.runId },
      candidate: { before: candidate, after: candidate }, images: { runtimeImage: f.runtimeImage, browserImage: f.browserImage } }
    // The selected producer validates; absent other producers still refuse full qualification.
    expect(validateProductionCampaignCoverage(input).failures.filter(failure => failure.startsWith('rehydrate:'))).toEqual([])
    fs.appendFileSync(path.join(f.evidenceDir, 'build.json'), ' ')
    expect(validateProductionCampaignCoverage(input).failures.some(failure => failure.startsWith('rehydrate:'))).toBe(true)
  })
  it.each(['unverified absence', 'unsettled broker', 'settlement failure', 'duplicate failed case'])('refuses contradictory original %s with matching hashes', async fault => {
    const f = await browserOriginalFixture()
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    const update = (key: 'cleanup' | 'lifecycle' | 'cloudLauncher', value: unknown) => {
      const bytes = typeof value === 'string' ? value : JSON.stringify(value)
      fs.writeFileSync(path.join(f.evidenceDir, BROWSER_ORIGINAL_FILES[key]), bytes)
      original.artifacts[key].sha256 = createHash('sha256').update(bytes).digest('hex')
    }
    if (fault === 'duplicate failed case') {
      const events = structuredClone(f.events)
      const reported = events[3] as any
      reported.cases.push({ ...f.executed[0], status: 'failed' })
      update('lifecycle', events.map(data => JSON.stringify({ event: data.event, data })).join('\n'))
      update('cloudLauncher', { stdout: events.map(row => JSON.stringify(row)).join('\n'), stderr: '' })
    } else {
      const cleanup = { ...f.files.cleanup as Record<string, unknown> }
      if (fault === 'unverified absence') cleanup.verifiedResourcesAbsent = false
      if (fault === 'unsettled broker') cleanup.brokerSettlementComplete = false
      if (fault === 'settlement failure') cleanup.brokerSettlementFailures = [{ reason: 'unresolved child', allocationUnknown: true }]
      update('cleanup', cleanup)
    }
    expect(() => validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toThrow()
  })
  it.each(['candidate', 'run', 'runtime image', 'browser image', 'case', 'missing original', 'failed cleanup', 'failed Cloud case', 'Cloud image'])('refuses %s even with newly matching reference hashes', async fault => {
    const f = await browserOriginalFixture()
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    if (fault === 'candidate') original.candidateSha = 'f'.repeat(40)
    if (fault === 'run') original.runId = randomUUID()
    if (fault === 'runtime image') original.runtimeImage = `sha256:${'f'.repeat(64)}`
    if (fault === 'browser image') original.browserImage = `sha256:${'f'.repeat(64)}`
    if (fault === 'case') original.selected[0] = { ...original.selected[0], id: 'wrong-case' }
    if (fault === 'missing original') fs.unlinkSync(path.join(f.evidenceDir, 'build.json'))
    if (['failed cleanup', 'failed Cloud case', 'Cloud image'].includes(fault)) {
      const key = fault === 'failed cleanup' ? 'cleanup' : 'lifecycle', file = BROWSER_ORIGINAL_FILES[key]
      let bytes: string
      if (key === 'cleanup') bytes = JSON.stringify({ ...f.files.cleanup as object, ok: false })
      else {
        const events = structuredClone(f.events)
        if (fault === 'failed Cloud case') (events[3] as any).cases[0].status = 'skipped'
        else (events[2] as any).imageDigest = `sha256:${'f'.repeat(64)}`
        bytes = events.map(data => JSON.stringify({ event: data.event, data })).join('\n')
      }
      fs.writeFileSync(path.join(f.evidenceDir, file), bytes)
      original.artifacts[key].sha256 = createHash('sha256').update(bytes).digest('hex')
    }
    expect(() => validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toThrow()
  })
})

// Isolate the already-owned native validators here: these cases prove campaign
// composition over real filesystem/dispatcher originals, not native qualification.
describe('complete finite campaign composition', () => {
  async function completeFixture() {
    const f = fixture(), root = f.options.repoRoot, campaignRunId = randomUUID()
    const empty = createHash('sha256').update('').digest('hex'), clean = { ...candidate, diffHash: empty, statusHash: empty }
    const runtimeImage = `sha256:${'b'.repeat(64)}`, browserImage = `sha256:${'c'.repeat(64)}`
    const provider = vi.spyOn(providerEvidence, 'validateProviderQualificationReceipt').mockImplementation(input => ({ providers: (input.receipt as any).providers } as any))
    const fresh = vi.spyOn(freshEvidence, 'validateFreshAgentQualificationReceipt').mockImplementation(input => ({ rows: (input.receipt as any).rows } as any))
    vi.spyOn(lossEvidence, 'validatePhase5LossReceipt').mockImplementation(() => ({} as any))
    vi.spyOn(chaosEvidence, 'validatePhase5ChaosReceipt').mockImplementation(() => ({} as any))
    vi.spyOn(soakEvidence, 'loadRuntimeSoakReceipt').mockImplementation(() => ({} as any))
    vi.spyOn(parityEvidence, 'loadProviderParityLocalReceipt').mockImplementation(() => ({} as any))
    const stem = (suffix: string) => `FRESHELL_RUNTIME_${suffix}_RECEIPT`
    const contracts: Record<string, { names: string[], spec?: string }> = {
      'provider-parity-local': { names: [stem('PROVIDER_PARITY_LOCAL')] },
      continuity: { names: [stem('BROWSER'), stem('OPENCODE')], spec: 'runtime-terminal-continuity-rust.spec.ts' },
      'fresh-agent-qualification': { names: [stem('PHASE3_FRESH_AGENT'), stem('PHASE5_FRESH_AGENT')], spec: 'runtime-fresh-agent-qualification-rust.spec.ts' },
      resurrection: { names: [stem('PHASE3_BROWSER')], spec: 'runtime-provider-resurrection-rust.spec.ts' },
      'opencode-qualification': { names: [stem('PHASE3_PROVIDER'), stem('PHASE5_PROVIDER')], spec: 'runtime-opencode-provider-qualification-rust.spec.ts' },
      'managed-provider-qualification': { names: [stem('PHASE3_PROVIDER'), stem('PHASE5_PROVIDER')], spec: 'runtime-managed-provider-qualification-rust.spec.ts' },
      rehydrate: { names: [stem('PHASE4_BROWSER')], spec: 'runtime-tabs-rehydrate-rust.spec.ts' },
      'loss-notice': { names: [stem('PHASE5_LOSS')], spec: 'runtime-lost-soul-notice-rust.spec.ts' },
      chaos: { names: [stem('PHASE5_CHAOS')], spec: 'runtime-chaos-rust.spec.ts' }, soak: { names: [stem('PHASE5_SOAK')] },
    }
    const completedSteps: any[] = []
    const write = (relative: string, value: unknown) => {
      const target = path.join(root, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const bytes = typeof value === 'string' ? value : JSON.stringify(value)
      fs.writeFileSync(target, bytes, { mode: 0o600 })
      return createHash('sha256').update(bytes).digest('hex')
    }
    for (const id of ids) {
      const log = `.runtime-evidence/${candidate.sha}/campaigns/${campaignRunId}/logs/${id}.log`
      const base = { id, outcome: 'PASS', exitCode: 0, failures: [], log }
      if (contracts[id]) {
        const contract = contracts[id], browser = contract.spec ? await browserOriginalFixture(f, contract.spec) : undefined
        const runId = browser ? (browser.owned as any).descriptor.runId : randomUUID()
        const receipts: Record<string, any> = {}, environment: NodeJS.ProcessEnv = {}
        for (const name of contract.names) {
          const receiptPath = `.runtime-evidence/${candidate.sha}/campaigns/${campaignRunId}/receipts/${id}/${name.toLowerCase()}.json`
          const receipt = { status: 'PASS', candidateSha: candidate.sha, runtimeImage, receiptRunId: runId,
            providers: (id === 'opencode-qualification' ? ['opencode'] : ['claude', 'codex', 'opencode', 'amplifier']).map(provider => ({ provider })),
            rows: ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'].map(mode => ({ mode })) }
          const digestSha256 = write(receiptPath, receipt)
          receipts[name] = { path: receiptPath, digestSha256, candidateSha: candidate.sha, campaignRunId, producerStepId: id }
          environment[name] = path.join(root, receiptPath)
        }
        let text = 'fictional nonbrowser producer completed'
        if (browser) {
          Object.assign(browser.owned, { environment, receiptBefore: {} })
          await browser.owned.finish()
          const original = browser.owned.publishOriginals(browser.cases, browser.executed)
          text = JSON.stringify({ event: 'managed_external_browser_passed', counts: {
            selected: 1, executed: 1, passed: 1, failed: 0, skipped: 0, timedOut: 0,
          }, originals: [original] })
        }
        completedSteps.push({ ...base, kind: 'producer', runner: browser ? 'playwright' : 'receipt', logDigest: write(log, text), receipts })
      } else {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'test/runtime/gate-manifest.json'), 'utf8'))
        const runId = randomUUID(), phase = manifest.phases.find((row: any) => row.id === 'phase-5')
        const mode = id === 'landing-gate' ? 'landing' : 'production'
        const expected = { gateId: manifest.certification_gates.modes[mode].id, phase: 'phase-5', mode,
          status: 'PASS', exitCode: 0, blockedReason: null }
        const summaryPath = `.runtime-evidence/${candidate.sha}/${runId}/summary.json`
        const expectedCases = [...phase.cumulative_required_case_ids, ...manifest.certification_gates.provider_certification_case_ids, 'EVIDENCE-ARTIFACTS', 'EVIDENCE-CANDIDATE']
        const summary = { gate: expected.gateId, phase: expected.phase, mode, status: 'PASS', blockedReason: null,
          candidateSha: candidate.sha, runId, campaign: { runId: campaignRunId, stepId: id }, imageRef: runtimeImage,
          requiredCases: phase.cumulative_required_case_ids, providerCertificationCases: manifest.certification_gates.provider_certification_case_ids,
          caseResults: expectedCases.map(caseId => ({ caseId, status: 'PASS' })), cleanup: { ok: true, errors: [] }, unsafeDockerAttempts: [], failures: [],
          missingArtifacts: [], invalidArtifacts: [], candidateIntegrity: { before: clean, after: clean, failures: [] } }
        for (const artifact of new Set<string>([...manifest.execution_contract.required_artifacts, ...phase.required_artifacts, ...manifest.certification_gates.required_artifacts])) {
          if (artifact === 'summary.json') continue
          write(`.runtime-evidence/${candidate.sha}/${runId}/${artifact.endsWith('/') ? artifact + 'fictional.json' : artifact}`, artifact.endsWith('.jsonl') ? '{}\n' : {})
        }
        completedSteps.push({ ...base, kind: 'gate', logDigest: write(log, 'fictional gate completed'),
          gate: { summaryPath, digestSha256: write(summaryPath, summary), runId, expected } })
      }
    }
    return { input: { selectedIds: ids, completedSteps, originals: { repoRoot: root, campaignRunId },
      candidate: { before: clean, after: clean }, images: { runtimeImage, browserImage } }, provider, fresh }
  }
  it('composes all twelve actual original sets and invokes each existing qualification boundary', async () => {
    const f = await completeFixture()
    expect(validateProductionCampaignCoverage(f.input)).toEqual({ complete: true, failures: [] })
    expect(f.provider).toHaveBeenCalledTimes(4)
    expect(f.fresh).toHaveBeenCalledTimes(2)
    expect(f.provider.mock.calls.every(([input]) => input.candidateSha === candidate.sha && input.expectedRuntimeImage === f.input.images.runtimeImage)).toBe(true)
    for (const fault of ['missing producer', 'reordered producer', 'failed child', 'wrong authority', 'missing gate', 'wrong image']) {
      const input = structuredClone(f.input)
      if (fault === 'missing producer') input.completedSteps.splice(1, 1)
      if (fault === 'reordered producer') input.completedSteps.reverse()
      if (fault === 'failed child') input.completedSteps[1].exitCode = 1
      if (fault === 'wrong authority') Object.values(input.completedSteps[1].receipts).forEach((row: any) => { row.campaignRunId = 'other' })
      if (fault === 'missing gate') input.completedSteps.at(-1)!.gate = undefined
      if (fault === 'wrong image') input.images.browserImage = `sha256:${'f'.repeat(64)}`
      expect(validateProductionCampaignCoverage(input).complete, fault).toBe(false)
    }
  })
  it.each(['wrong gate scope', 'contradictory cleanup'])('refuses %s after loading matching gate-original hashes', async fault => {
    const f = await completeFixture(), input = f.input, gate = input.completedSteps.at(-1)!.gate
    const target = path.join(input.originals.repoRoot, gate.summaryPath)
    const summary = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (fault === 'wrong gate scope') {
      summary.mode = 'landing'; summary.gate = 'durable-souls-landing'
      gate.expected.mode = 'landing'; gate.expected.gateId = 'durable-souls-landing'
    } else summary.cleanup.errors = ['still running']
    const bytes = JSON.stringify(summary)
    fs.writeFileSync(target, bytes)
    gate.digestSha256 = createHash('sha256').update(bytes).digest('hex')
    expect(validateProductionCampaignCoverage(input).complete).toBe(false)
  })
  it('requires the registered browser runner contract even when a completed record says receipt', async () => {
    const f = await completeFixture()
    f.input.completedSteps.find(step => step.id === 'continuity')!.runner = 'receipt'
    expect(validateProductionCampaignCoverage(f.input).complete).toBe(false)
  })
  it.each(['managed-provider-qualification', 'fresh-agent-qualification'])('refuses a missing combined row for %s after dependency validation', async id => {
    const f = await completeFixture(), input = f.input, step = input.completedSteps.find(step => step.id === id)!
    const name = id === 'managed-provider-qualification' ? 'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT' : 'FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT'
    const ref = step.receipts[name], target = path.join(input.originals.repoRoot, ref.path)
    const receipt = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (id === 'managed-provider-qualification') receipt.providers.pop()
    else receipt.rows.pop()
    const bytes = JSON.stringify(receipt)
    fs.writeFileSync(target, bytes)
    ref.digestSha256 = createHash('sha256').update(bytes).digest('hex')
    const logPath = path.join(input.originals.repoRoot, step.log), event = JSON.parse(fs.readFileSync(logPath, 'utf8'))
    event.originals[0].receiptDigests[name] = ref.digestSha256
    const log = JSON.stringify(event)
    fs.writeFileSync(logPath, log)
    step.logDigest = createHash('sha256').update(log).digest('hex')
    expect(validateProductionCampaignCoverage(input).failures.some(failure => failure.startsWith(id + ':') && failure.includes('rows are incomplete'))).toBe(true)
  })

})
