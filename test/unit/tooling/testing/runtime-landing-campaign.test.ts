import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productionCertificationStatus, loadCapabilityManifest, certifiedDurableProviders, releasedFreshAgentModes,
  classifyProviderCertificationCase, providerCertificationCaseId, resolveGateOutcome, DEFERRED_CASE_STATUS } from '../../../../scripts/testing/provider-certification.js'
import { BROWSER_ORIGINAL_FILES, TABS_CASE_TITLES, validateBrowserOriginalIndex, validateProductionCampaignCoverage } from '../../../../scripts/testing/runtime-campaign-policy.js'
import { ManagedExternalBrowserLifecycle, dispatchOwnedExternalBrowser } from '../../../../scripts/testing/runtime-external-browser.js'
import * as providerEvidence from '../../../../scripts/testing/provider-qualification-receipt.js'
import * as freshEvidence from '../../../../scripts/testing/fresh-agent-qualification-receipt.js'
import * as lossEvidence from '../../../../scripts/testing/runtime-phase5-loss-evidence.js'
import * as chaosEvidence from '../../../../scripts/testing/runtime-phase5-chaos-evidence.js'
import * as soakEvidence from '../../../../scripts/testing/runtime-soak-evidence.js'
import * as parityEvidence from '../../../../scripts/testing/provider-parity-receipt.js'
import { runCampaign } from '../../../../scripts/testing/runtime-landing-campaign.js'
import { defaultReceiptFileName } from '../../../../scripts/testing/runtime-receipts.js'
import { parseQualificationProviderSelection, QUALIFICATION_PROVIDER_SELECTION_ENV } from '../../../../scripts/testing/provider-qualification-selection.js'
import { parseFreshAgentQualificationModes, FRESH_AGENT_QUALIFICATION_MODES_ENV } from '../../../../scripts/testing/fresh-agent-qualification-selection.js'

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
    for (const [spec, name] of [['runtime-lost-soul-notice-rust.spec.ts', 'FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT'],
      ['runtime-chaos-rust.spec.ts', 'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT']]) {
      if (!args.some(argument => argument.endsWith(spec))) continue
      const runId = randomUUID(), runtimeImage = `sha256:${'b'.repeat(64)}`
      const target = path.join(root, '.runtime-evidence', candidate.sha, runId, 'browser', defaultReceiptFileName(name))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify({ candidateSha: candidate.sha, runtimeImage, receiptRunId: runId, status: 'PASS' }), { mode: 0o600 })
      fs.writeFileSync(log, JSON.stringify({ event: 'managed_external_browser_passed', counts: {
        selected: 1, executed: 1, passed: 1, failed: 0, skipped: 0, timedOut: 0,
      }, originals: [{ candidateSha: candidate.sha, runtimeImage, runId, receiptDigests: {
        [name]: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
      } }] }), { mode: 0o600 })
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

const rehydrateTitles = TABS_CASE_TITLES.map(title => `Phase 4 managed-runtime tab rehydration › ${title}`)

async function browserOriginalFixture(f = fixture(), spec = 'runtime-tabs-rehydrate-rust.spec.ts', title = rehydrateTitles[1]) {
  const root = f.options.repoRoot, runId = randomUUID()
  const runtimeImage = `sha256:${'b'.repeat(64)}`, browserImage = `sha256:${'c'.repeat(64)}`
  const evidenceDir = path.join(root, '.runtime-evidence', candidate.sha, runId)
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'test/runtime'), { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/runtime/gate-manifest.json'), 'utf8'))
  fs.writeFileSync(path.join(root, 'test/runtime/gate-manifest.json'), JSON.stringify(manifest))
  const cases = [{ id: 'case-owned', title,
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
    const managed = f.dispatches.find(row => row.args.includes('test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts'))!
    const fresh = f.dispatches.find(row => row.args.includes('test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts'))!
    const capabilities = loadCapabilityManifest(process.cwd())
    expect(parseQualificationProviderSelection(managed.env[QUALIFICATION_PROVIDER_SELECTION_ENV] ?? ''))
      .toEqual(certifiedDurableProviders(capabilities))
    expect(parseFreshAgentQualificationModes(fresh.env[FRESH_AGENT_QUALIFICATION_MODES_ENV] ?? '', capabilities))
      .toEqual(releasedFreshAgentModes(capabilities).map(row => row.mode))
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
  it.each(['FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT'])(
    'publishes the canonical owner digest for %s without a campaign target or copy', async name => {
      const f = await browserOriginalFixture()
      const target = path.join(f.evidenceDir, 'browser', defaultReceiptFileName(name))
      fs.writeFileSync(target, JSON.stringify({ candidateSha: candidate.sha, receiptRunId: (f.owned as any).descriptor.runId, status: 'PASS' }), { mode: 0o600 })
      Object.assign(f.owned, { environment: {}, receiptBefore: {} })
      await f.owned.finish()
      expect(f.owned.publishOriginals(f.cases, f.executed).receiptDigests[name]).toBe(createHash('sha256').update(fs.readFileSync(target)).digest('hex'))
    })
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
    const f = await browserOriginalFixture(undefined, undefined, rehydrateTitles[0])
    const second = await browserOriginalFixture(f)
    const execute = async (_command: string, _args: string[], environment: NodeJS.ProcessEnv, logPath: string) => {
      const originals = []
      let selected = 0
      for (const owner of [f, second]) {
        Object.assign(owner.owned, { environment, receiptBefore: {} })
        const target = environment.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT!
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, JSON.stringify({ candidateSha: candidate.sha, runtimeImage: f.runtimeImage, status: 'PASS' }), { mode: 0o600 })
        const result = await dispatchOwnedExternalBrowser({ spec: owner.cases[0].file }, { FRESHELL_E2E_BACKEND: 'cloud' }, {
          start: async () => ({ FRESHELL_E2E_TARGET_URL: 'https://fictional.invalid', FRESHELL_E2E_TARGET_WS_URL: 'wss://fictional.invalid/ws',
            FRESHELL_E2E_TARGET_TOKEN: 'fictional-unused', FRESHELL_RUNTIME_EXTERNAL_RUN_ID: (owner.owned as any).descriptor.runId,
            FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: candidate.sha }), list: async () => owner.cases,
          child: async () => ({ exitCode: 0, cases: owner.executed }), finish: () => owner.owned.finish(), abort: () => owner.owned.abort(),
          publishOriginals: (selected, executed) => owner.owned.publishOriginals(selected, executed),
        })
        selected += result.selected
        originals.push(...result.originals!)
      }
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, JSON.stringify({ event: 'managed_external_browser_passed', counts: {
        selected, executed: selected, passed: selected, failed: 0, skipped: 0, timedOut: 0,
      }, originals }), { mode: 0o600 })
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
  it.each([
    ['missing ownership object', null],
    ['missing receipts', { brokerEvents: [] }],
    ['malformed receipts', { brokerReceipts: {}, brokerEvents: [] }],
    ['missing events', { brokerReceipts: [] }],
    ['malformed receipt', { brokerReceipts: [null], brokerEvents: [] }],
    ['missing container ID', { brokerReceipts: [{}], brokerEvents: [] }],
    ['malformed container ID', { brokerReceipts: [{ containerId: 'short-id' }], brokerEvents: [] }],
    ['mismatched owned container', { brokerReceipts: [{ containerId: 'e'.repeat(64) }], brokerEvents: [] }],
    ['one missing owned container', { brokerReceipts: [{ containerId: 'd'.repeat(64) }, { containerId: 'e'.repeat(64) }], brokerEvents: [] }],
  ])('refuses cleanup ownership contradiction %s after loading matching original hashes', async (_fault, ownershipAfter) => {
    const f = await browserOriginalFixture()
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    const bytes = JSON.stringify(ownershipAfter)
    fs.writeFileSync(path.join(f.evidenceDir, BROWSER_ORIGINAL_FILES.ownershipAfter), bytes)
    original.artifacts.ownershipAfter.sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(() => validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toThrow(/ownership|owned container/)
  })
  it('refuses a missing ownership original before trusting cleanup', async () => {
    const f = await browserOriginalFixture()
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    fs.unlinkSync(path.join(f.evidenceDir, BROWSER_ORIGINAL_FILES.ownershipAfter))
    expect(() => validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toThrow()
  })
  it('accepts broker-owned container subset with additional tracked cleanup targets', async () => {
    const f = await browserOriginalFixture()
    await f.owned.finish()
    const original = f.owned.publishOriginals(f.cases, f.executed)
    for (const [key, value] of Object.entries({
      ownershipAfter: { brokerReceipts: [{ containerId: 'd'.repeat(64) }, { containerId: 'e'.repeat(64) }], brokerEvents: [] },
      cleanup: { ...f.files.cleanup as object, exactContainerIds: ['d'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)] },
    })) {
      const name = key as 'cleanup' | 'ownershipAfter', bytes = JSON.stringify(value)
      fs.writeFileSync(path.join(f.evidenceDir, BROWSER_ORIGINAL_FILES[name]), bytes)
      original.artifacts[name].sha256 = createHash('sha256').update(bytes).digest('hex')
    }
    expect(validateBrowserOriginalIndex({ repoRoot: f.options.repoRoot, candidateSha: candidate.sha,
      runtimeImage: f.runtimeImage, browserImage: f.browserImage, original })).toBe(1)
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
  async function completeFixture(declaredPolicy = false) {
    const f = fixture(), root = f.options.repoRoot, campaignRunId = randomUUID()
    const capabilities = loadCapabilityManifest(process.cwd())
    // The older all-provider fixture represents a hypothetical fully released policy.
    // The declared-policy variant exercises today's producing classifications unchanged.
    if (!declaredPolicy) {
      Object.assign(capabilities.providers.find(row => row.provider === 'amplifier')!, {
        managedEnabled: true, durableRecoveryEnabled: true, certificationState: 'certified',
      })
      capabilities.certification.productionGate.requiredCertifiedProviders.push('amplifier')
      capabilities.freshAgentModes.find(row => row.mode === 'kilroy')!.enabledInReleaseScope = true
    }
    fs.mkdirSync(path.join(root, 'docs/development'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/development/runtime-provider-capabilities.json'), JSON.stringify(capabilities))
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
        const contract = contracts[id]
        const browsers: Awaited<ReturnType<typeof browserOriginalFixture>>[] = []
        if (contract.spec) {
          for (const title of id === 'rehydrate' ? rehydrateTitles : [rehydrateTitles[1]]) {
            browsers.push(await browserOriginalFixture(f, contract.spec, title))
          }
        }
        const browser = browsers[0]
        const runId = browser ? (browser.owned as any).descriptor.runId : randomUUID()
        const receipts: Record<string, any> = {}, environment: NodeJS.ProcessEnv = {}
        for (const name of contract.names) {
          const receiptPath = ['loss-notice', 'chaos'].includes(id)
            ? `.runtime-evidence/${candidate.sha}/${runId}/browser/${defaultReceiptFileName(name)}`
            : `.runtime-evidence/${candidate.sha}/campaigns/${campaignRunId}/receipts/${id}/${name.toLowerCase()}.json`
          const receipt = { status: 'PASS', candidateSha: candidate.sha, runtimeImage, receiptRunId: runId,
            providers: (id === 'opencode-qualification' ? ['opencode'] : certifiedDurableProviders(capabilities)).map(provider => ({ provider })),
            rows: releasedFreshAgentModes(capabilities).map(row => ({ mode: row.mode })) }
          const digestSha256 = write(receiptPath, receipt)
          receipts[name] = { path: receiptPath, digestSha256, candidateSha: candidate.sha, campaignRunId, producerStepId: id }
          environment[name] = path.join(root, receiptPath)
        }
        let text = 'fictional nonbrowser producer completed'
        if (browser) {
          const originals = []
          for (const owner of browsers) {
            Object.assign(owner.owned, { environment, receiptBefore: {} })
            await owner.owned.finish()
            originals.push(owner.owned.publishOriginals(owner.cases, owner.executed))
          }
          text = JSON.stringify({ event: 'managed_external_browser_passed', counts: {
            selected: browsers.length, executed: browsers.length, passed: browsers.length, failed: 0, skipped: 0, timedOut: 0,
          }, originals })
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
        const caseResults = expectedCases.map(caseId => {
          const provider = capabilities.providers.find(row => providerCertificationCaseId(row.provider) === caseId)
          if (!provider) return { caseId, status: 'PASS' as const }
          const classification = classifyProviderCertificationCase(mode, provider)
          return { caseId, provider: provider.provider,
            status: classification.status === 'REQUIRES_LIVE_RECEIPT' ? 'PASS' as const : classification.status,
            ...(classification.reason ? { reason: classification.reason } : {}) }
        })
        const deferred = caseResults.filter(row => row.status === DEFERRED_CASE_STATUS).map(row => row.provider!)
        const outcome = resolveGateOutcome({ mode, caseResults, expectedCaseIds: expectedCases, cleanupOk: true,
          unsafeBrokerAttempts: 0, deferred, deferrableProviders: capabilities.certification.landingGate.deferrableProviders })
        const summary = { gate: expected.gateId, phase: expected.phase, mode,
          candidateSha: candidate.sha, runId, campaign: { runId: campaignRunId, stepId: id }, imageRef: runtimeImage,
          requiredCases: phase.cumulative_required_case_ids, providerCertificationCases: manifest.certification_gates.provider_certification_case_ids,
          ...outcome, deferredProviders: deferred, caseResults, cleanup: { ok: true, errors: [] }, unsafeDockerAttempts: [],
          missingArtifacts: [], invalidArtifacts: [], candidateIntegrity: { before: clean, after: clean, failures: [] } }
        for (const artifact of new Set<string>([...manifest.execution_contract.required_artifacts, ...phase.required_artifacts, ...manifest.certification_gates.required_artifacts])) {
          if (artifact === 'summary.json') continue
          write(`.runtime-evidence/${candidate.sha}/${runId}/${artifact.endsWith('/') ? artifact + 'fictional.json' : artifact}`, artifact.endsWith('.jsonl') ? '{}\n' : {})
        }
        completedSteps.push({ ...base, outcome: outcome.status, exitCode: outcome.exitCode, failures: outcome.failures,
          kind: 'gate', logDigest: write(log, 'fictional gate completed'),
          gate: { summaryPath, digestSha256: write(summaryPath, summary), runId, expected } })
      }
    }
    return { input: { selectedIds: ids, completedSteps, originals: { repoRoot: root, campaignRunId },
      candidate: { before: clean, after: clean }, images: { runtimeImage, browserImage } }, provider, fresh }
  }
  it('accepts declared enabled rows and producer-authorized landing deferrals, while production remains blocked', async () => {
    const f = await completeFixture(true)
    const result = validateProductionCampaignCoverage(f.input)
    expect(result.complete).toBe(false)
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures.every(failure => failure.startsWith('production-gate:'))).toBe(true)
  })

  it.each(['missing deferral', 'certified deferral', 'phase deferral', 'failed required case'])(
    'rejects %s even beside an authorized landing deferral', async fault => {
      const f = await completeFixture(true), input = f.input
      const gate = input.completedSteps.find(step => step.id === 'landing-gate')!.gate
      const target = path.join(input.originals.repoRoot, gate.summaryPath)
      const summary = JSON.parse(fs.readFileSync(target, 'utf8'))
      if (fault === 'missing deferral') summary.deferredProviders = []
      if (fault === 'certified deferral') {
        Object.assign(summary.caseResults.find((row: any) => row.caseId === 'PC-CODEX'), { status: DEFERRED_CASE_STATUS })
        summary.deferredProviders.push('codex')
      }
      if (fault === 'phase deferral') Object.assign(summary.caseResults[0], { status: DEFERRED_CASE_STATUS, provider: 'amplifier' })
      if (fault === 'failed required case') summary.caseResults[0].status = 'FAIL'
      const bytes = JSON.stringify(summary)
      fs.writeFileSync(target, bytes)
      gate.digestSha256 = createHash('sha256').update(bytes).digest('hex')
      expect(validateProductionCampaignCoverage(input).failures.some(failure => failure.startsWith('landing-gate:'))).toBe(true)
    },
  )
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
  it.each(['loss-notice', 'chaos'])('refuses a copied or wrong-owner canonical original for %s', async id => {
    const f = await completeFixture(), input = f.input, step = input.completedSteps.find(step => step.id === id)!
    const name = Object.keys(step.receipts)[0], reference = step.receipts[name]
    const originalPath = reference.path
    const copied = `.runtime-evidence/${candidate.sha}/campaigns/${input.originals.campaignRunId}/receipts/${id}/${name.toLowerCase()}.json`
    fs.mkdirSync(path.dirname(path.join(input.originals.repoRoot, copied)), { recursive: true })
    fs.copyFileSync(path.join(input.originals.repoRoot, originalPath), path.join(input.originals.repoRoot, copied))
    reference.path = copied
    expect(validateProductionCampaignCoverage(input).failures).toEqual([expect.stringMatching(new RegExp(`^${id}:.*path`))])
    reference.path = originalPath
    const target = path.join(input.originals.repoRoot, originalPath), receipt = JSON.parse(fs.readFileSync(target, 'utf8'))
    receipt.receiptRunId = randomUUID()
    const bytes = JSON.stringify(receipt)
    fs.writeFileSync(target, bytes)
    reference.digestSha256 = createHash('sha256').update(bytes).digest('hex')
    const log = path.join(input.originals.repoRoot, step.log), event = JSON.parse(fs.readFileSync(log, 'utf8'))
    event.originals[0].receiptDigests[name] = reference.digestSha256
    const logBytes = JSON.stringify(event)
    fs.writeFileSync(log, logBytes)
    step.logDigest = createHash('sha256').update(logBytes).digest('hex')
    expect(validateProductionCampaignCoverage(input).failures).toEqual([expect.stringMatching(new RegExp(`^${id}:.*owner`))])
  })
  it.each([0, 1])('refuses rehydrate coverage missing separately owned case %s with consistent remaining counts', async missing => {
    const f = await completeFixture(), input = f.input
    const step = input.completedSteps.find(step => step.id === 'rehydrate')!
    const target = path.join(input.originals.repoRoot, step.log)
    const event = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(event.originals).toHaveLength(2)
    expect(new Set(event.originals.map((original: any) => original.runId)).size).toBe(2)
    event.originals.splice(missing, 1)
    event.counts.selected = event.counts.executed = event.counts.passed = 1
    // Keep the Phase 4 receipt attributable to the remaining owner as well.
    const receiptRef = step.receipts.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT
    const receiptTarget = path.join(input.originals.repoRoot, receiptRef.path)
    const receipt = JSON.parse(fs.readFileSync(receiptTarget, 'utf8'))
    receipt.receiptRunId = event.originals[0].runId
    const receiptBytes = JSON.stringify(receipt)
    fs.writeFileSync(receiptTarget, receiptBytes)
    receiptRef.digestSha256 = createHash('sha256').update(receiptBytes).digest('hex')
    event.originals[0].receiptDigests.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT = receiptRef.digestSha256
    const bytes = JSON.stringify(event)
    fs.writeFileSync(target, bytes)
    step.logDigest = createHash('sha256').update(bytes).digest('hex')
    const result = validateProductionCampaignCoverage(input)
    expect(result.complete).toBe(false)
    expect(result.failures).toEqual([expect.stringMatching(/^rehydrate:.*required.*case/)])
  })
  it.each(['duplicate case', 'shared owner', 'reused run'])('refuses rehydrate %s despite two passing executions', async fault => {
    const f = await completeFixture(), input = f.input
    const step = input.completedSteps.find(step => step.id === 'rehydrate')!
    const target = path.join(input.originals.repoRoot, step.log)
    const event = JSON.parse(fs.readFileSync(target, 'utf8'))
    const first = event.originals[0], second = event.originals[1]
    if (fault === 'reused run') event.originals[1] = structuredClone(first)
    else {
      const owner = fault === 'shared owner' ? first : second
      if (fault === 'shared owner') {
        owner.selected.push({ ...second.selected[0], id: 'second-owned-case' })
        owner.executed.push({ ...second.executed[0], id: 'second-owned-case' })
        event.originals.pop()
      } else {
        owner.selected[0].title = first.selected[0].title
        owner.executed[0].title = first.executed[0].title
      }
      const lifecyclePath = path.join(input.originals.repoRoot, owner.artifacts.lifecycle.path)
      const rows = fs.readFileSync(lifecyclePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      for (const row of rows) if (row.event === 'managed_external_cloud_cases') row.data.cases = owner.executed
      const replacements = {
        lifecycle: rows.map(row => JSON.stringify(row)).join('\n'),
        cloudLauncher: JSON.stringify({ stdout: rows.map(row => JSON.stringify({ ...row.data, event: row.event })).join('\n'), stderr: '' }),
      }
      for (const [key, bytes] of Object.entries(replacements)) {
        fs.writeFileSync(path.join(input.originals.repoRoot, owner.artifacts[key].path), bytes)
        owner.artifacts[key].sha256 = createHash('sha256').update(bytes).digest('hex')
      }
    }
    const bytes = JSON.stringify(event)
    fs.writeFileSync(target, bytes)
    step.logDigest = createHash('sha256').update(bytes).digest('hex')
    const result = validateProductionCampaignCoverage(input)
    expect(result.complete).toBe(false)
    expect(result.failures).toEqual([expect.stringMatching(/^rehydrate:.*(required rehydrate cases|run is reused)/)])
  })
  it('refuses campaign composition when a current browser owner is omitted from cleanup', async () => {
    const f = await completeFixture(), input = f.input
    const step = input.completedSteps.find(step => step.id === 'continuity')!
    const target = path.join(input.originals.repoRoot, step.log)
    const event = JSON.parse(fs.readFileSync(target, 'utf8')), original = event.originals[0]
    const ownership = JSON.stringify({ brokerReceipts: [{ containerId: 'e'.repeat(64) }], brokerEvents: [] })
    fs.writeFileSync(path.join(input.originals.repoRoot, original.artifacts.ownershipAfter.path), ownership)
    original.artifacts.ownershipAfter.sha256 = createHash('sha256').update(ownership).digest('hex')
    const bytes = JSON.stringify(event)
    fs.writeFileSync(target, bytes)
    step.logDigest = createHash('sha256').update(bytes).digest('hex')
    const result = validateProductionCampaignCoverage(input)
    expect(result.complete).toBe(false)
    expect(result.failures).toEqual(['continuity: browser original owned container is missing from cleanup targets'])
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
