import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync, type execFileSync } from 'node:child_process'

const execute = vi.fn()

import { runSelectedProviderQualification } from '../../../../scripts/testing/runtime-provider-qualification.js'
import { runSelectedFreshAgentQualification } from '../../../../scripts/testing/runtime-fresh-agent-qualification.js'

import { playwright, campaignGate } from '../../../../scripts/testing/runtime-landing-campaign.js'
import * as runner from '../../../../scripts/testing/runtime-external-browser.js'
import { ManagedRuntimeOwner, RuntimeHarness, assertExactRuntimeHandle, type SupervisorInstance, type Phase3BrowserObservation } from '../../../../scripts/testing/runtime-sandbox.js'
import { runTask2RetainedFixture, RetainedFixtureBrowserSession } from '../../../../scripts/testing/task002-retained-fixture.js'
import { stopManagedRuntimeSoul } from '../../../e2e-browser/helpers/managed-runtime.js'
import { structuredChaosLog } from '../../../e2e-browser/helpers/runtime-chaos-evidence.js'
import type { BrokerReceipt } from '../../../../scripts/testing/runtime-test-broker.js'

beforeEach(() => execute.mockReset())

describe('managed browser producers', () => {
  it.each([
    { run: runSelectedProviderQualification, args: ['--provider', 'codex'], selection: '--provider', value: 'codex', spec: 'runtime-managed-provider-qualification-rust.spec.ts', live: 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE' },
    { run: runSelectedFreshAgentQualification, args: ['--mode', 'freshcodex'], selection: '--mode', value: 'freshcodex', spec: 'runtime-fresh-agent-qualification-rust.spec.ts', live: 'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE' },
  ])('dispatches $value through the owned external runner on the configured backend', ({ run, args, selection, value, spec, live }) => {
    vi.stubEnv('FRESHELL_E2E_BACKEND', 'cloud')
    try {
      run(args, execute)
      expect(execute).toHaveBeenCalledOnce()
      const [command, childArgs, options] = execute.mock.calls[0]
      expect(command).toBe('pnpm')
      expect(childArgs).toEqual([
        'exec', 'tsx', 'scripts/testing/runtime-external-browser.ts',
        '--spec', `test/e2e-browser/specs/${spec}`, selection, value,
      ])
      expect(options.env.FRESHELL_E2E_BACKEND).toBe('cloud')
      expect(options.env[live]).toBe('1')
      expect(childArgs).not.toContain('--local')
      expect(childArgs).not.toContain('--')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})


describe('actual campaign dispatch', () => {
  it('uses owned external transport without losing campaign provenance', async () => {
    const child = vi.fn().mockResolvedValue(0)
    const env = { FRESHELL_E2E_BACKEND: 'cloud', FRESHELL_RUNTIME_CAMPAIGN_RUN_ID: 'campaign-run', FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT: '/owner/receipt' }
    const spec = 'test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts'
    await playwright(spec, { FRESHELL_RUNTIME_PHASE3_LIVE: '1' }, child)(env, '/owner/log')
    expect(child).toHaveBeenCalledWith('pnpm', [
      'exec', 'tsx', 'scripts/testing/runtime-external-browser.ts', '--spec', spec,
    ], { ...env, FRESHELL_RUNTIME_PHASE3_LIVE: '1' }, '/owner/log')
  })

  it.each(['landing', 'phase-5'])('keeps the %s gate coordinated with the original args and run metadata', async (gate) => {
    const child = vi.fn().mockResolvedValue(0)
    const env = { FRESHELL_RUNTIME_GATE_RUN_ID: 'gate-run', FRESHELL_RUNTIME_CAMPAIGN_RUN_ID: 'campaign-run', FRESHELL_RUNTIME_CAMPAIGN_STEP_ID: gate }
    await campaignGate(['gate', gate, '--require-live'], env, '/owner/log', child)
    expect(child).toHaveBeenCalledWith('pnpm', ['run', 'test:runtime', 'gate', gate, '--require-live'], env, '/owner/log')
  })
})

const descriptor = {
  FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
  FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws',
  FRESHELL_E2E_TARGET_TOKEN: 'private-owner-token',
  FRESHELL_RUNTIME_EXTERNAL_RUN_ID: '7aab49a4-08ed-4ca7-a4b2-6501f4821a63',
  FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: 'a'.repeat(40),
}
const smokeSpec = 'test/e2e-browser/specs/runtime-external-target-smoke-rust.spec.ts'

describe('selected production owner registration', () => {
  it('preserves the all-mode fixture observer interval on an actual supervisor replacement', async () => {
    const owner = runner.createExternalManagedRuntimeOwner(process.cwd(), {
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts',
    }, { FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST: '1' }, () => { throw new Error('web unused') })
    const previous: SupervisorInstance = { scenarioId: 'fixture-owner', containerId: 'b'.repeat(64),
      volumeName: 'owned-fixture-volume', controlSocket: '/owned/control.sock', controlSecret: 'fixture-test-secret',
      controlSecretFile: '/owned/control-secret', runtimeRoot: '/owned/runtime', binaryKind: 'test' }
    owner.supervisor = previous
    vi.spyOn(owner.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(owner.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const launch = vi.spyOn(owner.runtime, 'startSupervisor').mockResolvedValue({ ...previous, containerId: 'c'.repeat(64) })
    await owner.restartSupervisor()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ binaryKind: 'test',
      env: { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '250' } }))
    expect(owner.fixtureRegistrationFacts()).toEqual({ phase: 3, enabledProviders: [],
      freshAgentModes: ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'],
      fixtureFreshAgentModes: ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] })
  })
})

describe('owned external descriptor and explicit selection', () => {
  it('preserves default selection when no external descriptor is present', () => {
    expect(runner.resolveManagedExternalDescriptor({})).toBeNull()
  })
  it('admits complete HTTPS and WSS owned descriptors', () => {
    expect(runner.resolveManagedExternalDescriptor(descriptor)).toMatchObject({
      baseUrl: descriptor.FRESHELL_E2E_TARGET_URL, wsUrl: descriptor.FRESHELL_E2E_TARGET_WS_URL,
      runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID, candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
    })
  })
  it.each([
    { FRESHELL_E2E_TARGET_URL: 'http://owned.trycloudflare.com' },
    { FRESHELL_E2E_TARGET_WS_URL: 'wss://other.trycloudflare.com/ws' },
    { FRESHELL_E2E_TARGET_TOKEN: '' }, { FRESHELL_RUNTIME_EXTERNAL_RUN_ID: 'old-run' },
    { FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: 'dirty' },
  ])('refuses partial or invalid descriptor %j', (changed) => {
    expect(() => runner.resolveManagedExternalDescriptor({ ...descriptor, ...changed })).toThrow(/external/)
  })
  it('refuses unrelated specs and incompatible native selectors before rig creation', () => {
    expect(() => runner.parseExternalBrowserArguments(['--spec', 'test/e2e-browser/specs/auth.spec.ts'], {})).toThrow(/spec/)
    expect(() => runner.parseExternalBrowserArguments(['--spec', smokeSpec, '--provider', 'codex'], {})).toThrow(/provider/)
  })
  it('refuses synthetic fixture selection without its exact opt-in', () => {
    expect(() => runner.parseExternalBrowserArguments(['--spec', 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts'], {})).toThrow(/FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST/)
  })
  it('refuses mixing a native provider selector with an explicitly synthetic case', () => {
    expect(() => runner.parseExternalBrowserArguments(['--spec', 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      '--provider', 'codex', '--grep', 'synthetic config-blocked exact retry$'], {
      FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1', FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
    })).toThrow(/synthetic.*provider|provider.*synthetic/)
  })
})

describe('executable external runner admission', () => {
  it('fails an unsupported actual CLI selector before owning any resources', () => {
    const child = spawnSync('pnpm', ['exec', 'tsx', 'scripts/testing/runtime-external-browser.ts',
      '--spec', 'test/e2e-browser/specs/auth.spec.ts'], {
      cwd: process.cwd(), env: { ...process.env, FRESHELL_E2E_BACKEND: 'cloud' },
      encoding: 'utf8', timeout: 15_000,
    })
    expect(child.status).toBe(1)
    expect(child.stderr).toMatch(/allowlisted|selection|admission/)
  })
})

describe('actual runner child and nonvacuity lifecycle', () => {
  function lifecycle() {
    const cases = [{ id: 'case-owned', title: 'actual managed external topology and finite owner facts', file: smokeSpec }]
    const child = vi.fn().mockResolvedValue({ exitCode: 0, cases: cases.map((row) => ({ ...row, status: 'passed' })) })
    const owned = {
      start: vi.fn().mockResolvedValue(descriptor),
      list: vi.fn().mockResolvedValue(cases),
      child,
      finish: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
      abort: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
    }
    return { owned, child, cases }
  }
  it('lists first, executes the exact configured child and publishes counts only after owned cleanup', async () => {
    const { owned, child } = lifecycle()
    const receipt = await runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned)
    expect(child).toHaveBeenCalledWith('pnpm', expect.arrayContaining([
      'run', 'test:e2e', '--project=chromium-external-target', smokeSpec,
    ]), expect.objectContaining(descriptor))
    const childArgs = child.mock.calls[0][1]
    expect(childArgs).not.toContain('--')
    expect(childArgs).not.toContain('--local')
    // Preserve the 60-minute native case plus two 15-minute retained cases,
    // including their browser setup and cleanup time.
    expect(childArgs).toContain('--timeout=120m')
    expect(owned.list.mock.invocationCallOrder[0]).toBeLessThan(child.mock.invocationCallOrder[0])
    expect(receipt).toMatchObject({ selected: 1, executed: 1, passed: 1, skipped: 0, failed: 0, timedOut: 0 })
    expect(owned.finish).toHaveBeenCalledOnce()
    expect(owned.abort).not.toHaveBeenCalled()
  })
  it('requires native provider cases while leaving separately opted-in synthetic cases honestly unselected', async () => {
    const { owned } = lifecycle()
    const spec = 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts'
    const native = { id: 'native-codex', file: spec, title: 'managed terminal provider qualification › codex recovers exact identity' }
    const synthetic = { id: 'synthetic-config', file: spec, title: 'Task2 synthetic provider configuration and legacy retry › synthetic config-blocked exact retry' }
    owned.list.mockResolvedValue([native, synthetic])
    owned.child.mockResolvedValue({ exitCode: 0, cases: [{ ...native, status: 'passed' }, { ...synthetic, status: 'skipped' }] })
    await expect(runner.dispatchOwnedExternalBrowser({ spec, provider: 'codex' }, {
      FRESHELL_E2E_BACKEND: 'cloud', FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
    }, owned)).resolves.toMatchObject({ selected: 1, executed: 1, passed: 1, skipped: 0 })
  })
  it.each(['skipped', 'failed', 'timedOut'])('rejects a selected %s case and still cleans its owned lifecycle', async (status) => {
    const { owned, child, cases } = lifecycle()
    child.mockResolvedValue({ exitCode: 0, cases: cases.map(row => ({ ...row, status })) })
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/selected/)
    expect(owned.abort).toHaveBeenCalledOnce()
  })
  it('refuses zero selected cases before dispatch', async () => {
    const { owned, child } = lifecycle()
    owned.list.mockResolvedValue([])
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/zero/)
    expect(child).not.toHaveBeenCalled()
    expect(owned.abort).toHaveBeenCalledOnce()
  })
  it('refuses zero executed cases and lost selected identities', async () => {
    const { owned, child } = lifecycle()
    child.mockResolvedValue({ exitCode: 0, cases: [] })
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/selected|executed/)
    expect(owned.abort).toHaveBeenCalledOnce()
  })
  it('cleans exact owned resources after a dispatch failure', async () => {
    const { owned, child } = lifecycle()
    child.mockRejectedValue(new Error('cloud dispatch failed'))
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/cloud dispatch/)
    expect(owned.abort).toHaveBeenCalledOnce()
  })
  it('keeps a failed Cloud child failed when its exact case observations are recovered', async () => {
    const { owned, child, cases } = lifecycle()
    child.mockResolvedValue({ exitCode: 1, cases: cases.map(row => ({ ...row, status: 'failed' })) })
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned))
      .rejects.toThrow(/child|exit|failed/)
    expect(owned.abort).toHaveBeenCalledOnce()
    expect(owned.finish).not.toHaveBeenCalled()
  })
  it('refuses receipt publication when owner finish reports cleanup failure', async () => {
    const { owned } = lifecycle()
    owned.finish.mockResolvedValue({ ok: false, errors: ['owned web remains'] })
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/cleanup/)
  })
  it('retains the original dispatch failure when abort itself rejects', async () => {
    const { owned } = lifecycle()
    const dispatchError = new Error('owned dispatch failed')
    const cleanupError = new Error('owned abort failed')
    owned.child.mockRejectedValue(dispatchError)
    owned.abort.mockRejectedValue(cleanupError)
    const result = await runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned).catch(error => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toEqual([dispatchError, cleanupError])
  })
  it('waits for partial startup to settle before cancelling and never dispatches afterward', async () => {
    const { owned } = lifecycle()
    const cancellation = new AbortController()
    let release!: (value: typeof descriptor) => void
    owned.start.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned, cancellation.signal)
    cancellation.abort(new Error('owned run cancelled'))
    expect(owned.abort).not.toHaveBeenCalled()
    release(descriptor)
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(owned.list).not.toHaveBeenCalled()
    expect(owned.child).not.toHaveBeenCalled()
    expect(owned.abort).toHaveBeenCalledOnce()
  })
  it('propagates cancellation to an in-flight Cloud child and cleans before rejecting', async () => {
    const { owned } = lifecycle()
    const cancellation = new AbortController()
    let entered!: () => void
    const childEntered = new Promise<void>(resolve => { entered = resolve })
    owned.child.mockImplementation(async (_command, _args, _env, signal?: AbortSignal) => {
      entered()
      if (!signal) throw new Error('Cloud child has no cancellation signal')
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const pending = runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, owned, cancellation.signal)
    await childEntered
    cancellation.abort(new Error('owned run cancelled'))
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(owned.abort).toHaveBeenCalledOnce()
  })
})

describe('owned Cloud launcher diagnostics', () => {
  it('retains a failed actual child output privately before cleanup without publishing its body', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-cloud-output-'))
    const owner = new ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd())
    const artifactPath = path.join(owner.runtime.evidenceDir, 'cloud-launcher-output.json')
    const privateBody = 'private-cloud-command-body'
    await fsp.writeFile(path.join(directory, 'pnpm'), `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('10.34.5');else{console.log('${privateBody}');console.error('exact execution image observation is unavailable');process.exitCode=73}`, { mode: 0o700 })
    const lifecycle = new runner.ManagedExternalBrowserLifecycle(process.cwd(), { PATH: directory })
    Object.assign(lifecycle, { owner, descriptor: { ...runner.resolveManagedExternalDescriptor(descriptor)!,
      runId: owner.runtime.runId, candidateSha: owner.runtime.candidateSha }, tunnel: { assertAlive() {}, async stop() {} } })
    const stop = vi.spyOn(owner, 'stop').mockImplementation(async () => {
      expect(JSON.parse(await fsp.readFile(artifactPath, 'utf8'))).toMatchObject({
        stdout: `${privateBody}\n`, stderr: 'exact execution image observation is unavailable\n',
      })
      return { ok: true, errors: [] }
    })
    const record = vi.spyOn(owner.runtime, 'recordLifecycle')
    try {
      await expect(lifecycle.child('pnpm', ['fixture-cloud'], {})).rejects.toThrow(/Cloud|missing/)
      await expect(lifecycle.finish()).resolves.toEqual({ ok: true, errors: [] })
      expect(stop).toHaveBeenCalledOnce()
      expect((await fsp.stat(artifactPath)).mode & 0o777).toBe(0o600)
      const bytes = await fsp.readFile(artifactPath)
      expect(record).toHaveBeenCalledWith('external.cloud_diagnostics', {
        severity: 'info', artifactRef: 'cloud-launcher-output.json',
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        tailLimitCharactersPerStream: 1024 * 1024,
      })
      expect(record.mock.calls.filter(([event]) => event === 'external.cloud_diagnostics')).toHaveLength(1)
      expect(JSON.stringify(record.mock.calls)).not.toContain(privateBody)
    } finally {
      await lifecycle.finish()
      await fsp.rm(directory, { recursive: true, force: true })
      await fsp.rm(owner.runtime.evidenceDir, { recursive: true, force: true })
    }
  })
})

describe('authenticated owned web provenance', () => {
  it('accepts the actual expected Rust build and observed source cleanliness', () => {
    expect(() => runner.validateManagedWebProvenance({ runtime: 'rust', commit: 'a'.repeat(40), buildDirty: false }, 'a'.repeat(40), false)).not.toThrow()
  })
  it.each([
    { runtime: 'node', commit: 'a'.repeat(40), buildDirty: false },
    { runtime: 'rust', commit: 'b'.repeat(40), buildDirty: false },
    { runtime: 'rust', commit: 'a'.repeat(40), buildDirty: true },
    { runtime: 'rust', commit: 'a'.repeat(40) },
    null,
  ])('refuses wrong or incomplete authenticated web provenance %j', (observed) => {
    expect(() => runner.validateManagedWebProvenance(observed, 'a'.repeat(40), false)).toThrow(/provenance/)
  })
})

describe('machine-readable Playwright selection', () => {
  const listing = {
    errors: [], suites: [{ title: 'runtime-external-target-smoke-rust.spec.ts', file: 'runtime-external-target-smoke-rust.spec.ts',
      specs: [], suites: [{ title: 'owned managed topology', file: 'runtime-external-target-smoke-rust.spec.ts',
        specs: [{ id: 'case-owned', title: 'actual managed external topology and finite owner facts',
          file: 'runtime-external-target-smoke-rust.spec.ts',
          tests: [{ projectName: 'chromium-external-target', expectedStatus: 'passed', results: [], status: 'skipped' }],
        }],
      }],
    }],
  }
  it('parses selected identities from real Playwright list shape without treating listing as execution', () => {
    const cases = runner.parseExternalPlaywrightList(listing)
    expect(cases).toEqual([{ id: 'case-owned', file: smokeSpec,
      title: 'owned managed topology › actual managed external topology and finite owner facts' }])
  })
  it('executes the actual machine-list producer with the exact external selector', () => {
    const child = vi.fn().mockReturnValue(JSON.stringify(listing))
    const cases = runner.listExternalBrowserCases({ spec: smokeSpec, grep: 'finite owner facts' }, descriptor, child)
    expect(cases).toHaveLength(1)
    expect(child).toHaveBeenCalledWith('pnpm', expect.arrayContaining([
      'exec', 'playwright', 'test', '--list', '--reporter=json', '--project=chromium-external-target', smokeSpec,
      '--grep', 'finite owner facts',
    ]), expect.objectContaining({ env: expect.objectContaining(descriptor), encoding: 'utf8' }))
  })
  it.each([{}, { errors: [{ message: 'selection failed' }], suites: [] }, { errors: [], suites: [{ specs: [{ id: 'missing-case' }] }] }])(
    'refuses malformed or failed machine listing %j', (report) => {
      expect(() => runner.parseExternalPlaywrightList(report)).toThrow(/Playwright|listing/)
    },
  )
})

describe('candidate-bound Cloud execution events', () => {
  const context = { runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID, candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA }
  const observed = { severity: 'info', event: 'managed_external_case', ...context,
    id: 'case-owned', file: smokeSpec, title: 'actual managed external topology and finite owner facts', status: 'passed' }
  const complete = { severity: 'info', event: 'managed_external_complete', ...context, status: 'passed', cases: 1 }
  it('accepts positive executed records from the exact run and candidate', () => {
    expect(runner.parseExternalCloudExecutionEvents([observed, complete], context)).toEqual([
      { id: observed.id, file: observed.file, title: observed.title, status: 'passed' },
    ])
  })
  it.each([
    [], [complete], [observed], [observed, { ...complete, cases: 2 }],
    [{ ...observed, runId: 'foreign-run' }, complete],
    [{ ...observed, candidateSha: 'b'.repeat(40) }, complete],
    [{ ...observed, status: 'unknown' }, complete],
    [observed, observed, { ...complete, cases: 2 }],
    [observed, { ...complete, status: 'failed' }],
  ].map(events => ({ events })))('refuses missing, stale, duplicate or incomplete executed observations $events', ({ events }) => {
    expect(() => runner.parseExternalCloudExecutionEvents(events, context)).toThrow(/execution|candidate|run|duplicate/)
  })
  it('retains actual skipped and failed status for orchestration refusal', () => {
    expect(runner.parseExternalCloudExecutionEvents([{ ...observed, status: 'skipped' }, complete], context)[0].status).toBe('skipped')
  })
})

describe('owned stable relay admission and lifetime (transport unit coverage only)', () => {
  it('keeps one origin across backend replacement and records exact auth/Origin refusal', async () => {
    const servers: http.Server[] = []
    async function backend(label: string): Promise<string> {
      const server = http.createServer((_request, response) => { response.end(JSON.stringify({ label })) })
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    let current = ''
    const relay = new runner.OwnedManagedRuntimeRelay({
      token: 'owned-token', backend: () => current,
      control: async (request: unknown) => ({ request, source: 'owned-control-fixture' }),
    })
    async function get(headers: Record<string, string>, route = '/api/server-info'): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        http.get(`${relay.localUrl}${route}`, { headers }, response => {
          let body = ''
          response.on('data', chunk => { body += String(chunk) })
          response.on('end', () => resolve({ status: response.statusCode!, body }))
        }).on('error', reject)
      })
    }
    try {
      current = await backend('first-owned-fixture')
      await relay.start()
      expect((await get({}, '/ws')).status).toBe(401)
      relay.setOrigin('https://owned.trycloudflare.com')
      const valid = { 'x-auth-token': 'owned-token', Origin: 'https://owned.trycloudflare.com' }
      expect((await get(valid)).body).toContain('first-owned-fixture')
      expect((await get(valid, '/api/search')).body).toContain('first-owned-fixture')
      expect((await get({})).status).toBe(401)
      expect((await get({ ...valid, Origin: 'https://another.trycloudflare.com' })).status).toBe(403)
      expect((await get(valid, '/.freshell/config.json')).status).toBe(404)
      const firstOrigin = relay.localUrl
      current = await backend('replacement-owned-fixture')
      expect(relay.localUrl).toBe(firstOrigin)
      expect((await get(valid)).body).toContain('replacement-owned-fixture')
      expect(relay.refusalFacts()).toMatchObject({ authRefusals: 2, originRefusals: 1, lastOwnerRefusalStatus: 403 })
      expect(() => relay.setOrigin('https://another.trycloudflare.com')).toThrow(/origin/)
    } finally {
      await relay.stop()
      await Promise.all(servers.map(server => new Promise<void>((resolve) => server.close(() => resolve()))))
    }
  })
  it('observes one real browser Retry response without issuing another transaction', async () => {
    let transactions = 0
    const backend = http.createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain the actual submitted body */ }
      transactions++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ view: { soulId: 'owned-retry-soul' }, outcome: 'blocked' }))
    })
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
    const observed = vi.fn()
    const relay = new runner.OwnedManagedRuntimeRelay({ token: 'owned-token',
      backend: () => `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      control: async () => ({}), retryResponse: observed })
    try {
      await relay.start()
      relay.setOrigin('https://owned.trycloudflare.com')
      const response = await fetch(`${relay.localUrl}/api/runtime/souls/owned-retry-soul/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': 'owned-token', Origin: 'https://owned.trycloudflare.com' },
        body: JSON.stringify({ requestId: 'actual-ui-request', expectedIntentRevision: 3 }),
      })
      expect(response.status).toBe(200)
      await response.json()
      expect(observed).toHaveBeenCalledExactlyOnceWith({ soulId: 'owned-retry-soul', requestId: 'actual-ui-request',
        response: { view: { soulId: 'owned-retry-soul' }, outcome: 'blocked' } })
      expect(transactions).toBe(1)
    } finally {
      await relay.stop()
      await new Promise<void>(resolve => backend.close(() => resolve()))
    }
  })
})

describe('owned pinned Quick Tunnel endpoint', () => {
  it('extracts one stable generated HTTPS origin and derives matching WSS', () => {
    expect(runner.parseOwnedTunnelOrigin('Created Quick Tunnel: https://one-owned-test.trycloudflare.com\n')).toBe('https://one-owned-test.trycloudflare.com')
    expect(runner.parseOwnedTunnelOrigin('waiting for connection')).toBeNull()
  })
  it('refuses two distinct generated origins instead of switching the browser target', () => {
    expect(() => runner.parseOwnedTunnelOrigin('https://one-owned-test.trycloudflare.com https://another-owned-test.trycloudflare.com')).toThrow(/origin/)
  })
})

describe('owned web process lifetime (Node process fixture only)', () => {
  async function fixture() {
    const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-owned-process-'))
    const entry = path.join(fixture, 'owned-server.cjs')
    const home = path.join(fixture, 'home')
    await fsp.writeFile(entry, `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({runtime:'rust',commit:'${'a'.repeat(40)}',buildDirty:false,environmentKeys:Object.keys(process.env)}))}).listen(Number(process.env.PORT),'127.0.0.1')`)
    const setup = vi.fn(async (directory: string) => {
      await fsp.mkdir(path.join(directory, '.freshell'), { recursive: true })
      await fsp.writeFile(path.join(directory, '.freshell/config.json'), JSON.stringify({ version: 1, settings: {} }))
    })
    return { fixture, entry, home, setup }
  }
  it.each([
    { grep: 'P3-G10: pending native approval survives exact provider resurrection', permission: 'ask', delay: '7000' },
    { grep: 'imports only the selected synthetic conversation and reopens under its native ID', permission: null, delay: null },
  ])('launches the selected $grep with its existing fixed web preset', async ({ grep, permission, delay }) => {
    const { fixture: directory, entry, setup } = await fixture()
    await fsp.writeFile(entry, `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({runtime:'rust',commit:'${'a'.repeat(40)}',buildDirty:false,permission:process.env.FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION??null,delay:process.env.FRESHELL_MANAGED_RECOVERY_TEST_DELAY_MS??null}))}).listen(Number(process.env.PORT),'127.0.0.1')`)
    vi.stubEnv('FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION', undefined)
    vi.stubEnv('FRESHELL_MANAGED_RECOVERY_TEST_DELAY_MS', undefined)
    const factory = runner.createExternalManagedWebFactory({ spec: 'test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts', grep },
      { FRESHELL_RUNTIME_PHASE3_LIVE: '1', FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1' }, options => new runner.ManagedRuntimeWebServer(options))
    const server = factory({ binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40), buildDirty: false,
      setupHome: setup, preserveHomeOnStop: false, env: { NODE_OPTIONS: `--require=${entry}` } })
    let pid: number | undefined
    try {
      const info = await server.start()
      pid = info.pid
      expect(await (await fetch(`${info.baseUrl}/api/server-info`, { headers: { 'x-auth-token': info.token } })).json()).toMatchObject({ permission, delay })
      await server.stop()
      await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
    } finally { await server.stop(); vi.unstubAllEnvs(); await fsp.rm(directory, { recursive: true }) }
  })
  it('retains stopped owned output and records structured failure facts without credentials or bodies', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const line = { level: 'WARN', fields: { message: 'fresh_agent.hosted_snapshot_unavailable',
      code: 'CAPABILITY_PENDING', soul_id: 'owned-soul', authToken: 'credential-must-not-persist', transcript: 'body-must-not-persist' } }
    await fsp.writeFile(entry, `process.stderr.write(${JSON.stringify(JSON.stringify(line) + '\n')});\n${await fsp.readFile(entry, 'utf8')}`)
    const diagnostics = vi.fn()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } }, diagnostics)
    let pid: number | undefined
    try {
      pid = (await server.start()).pid
      await server.stop()
      expect(diagnostics).toHaveBeenCalledOnce()
      expect(diagnostics.mock.calls[0][0]).toMatchObject({ pid, bootAttemptCount: 1,
        facts: [{ severity: 'warn', event: 'fresh_agent.hosted_snapshot_unavailable', fields: { code: 'CAPABILITY_PENDING', soul_id: 'owned-soul' } }] })
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('credential-must-not-persist')
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('body-must-not-persist')
      expect(server.capturedOutput().stderr).toContain('fresh_agent.hosted_snapshot_unavailable')
      await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
    } finally { await server.stop(); await fsp.rm(directory, { recursive: true }) }
  })
  it('captures the actual Rust JSONL msg and bound server PID before removing owned HOME', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const logging = `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.FRESHELL_LOG_DIR,'rust-server.jsonl'),JSON.stringify({level:'WARN',msg:'fresh_agent.hosted_snapshot_unavailable',server_pid:process.pid,code:'CAPABILITY_PENDING',soul_id:'owned-file-soul',transcript:'file-body-must-not-persist'})+'\\n'+JSON.stringify({level:'WARN',msg:'fresh_agent.hosted_snapshot_unavailable',server_pid:process.pid-1,code:'FOREIGN_PID'})+'\\n');\n`
    await fsp.writeFile(entry, `${logging}${await fsp.readFile(entry, 'utf8')}`)
    const diagnostics = vi.fn()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } }, diagnostics)
    try {
      const info = await server.start()
      await server.stop()
      const record = diagnostics.mock.calls[0][0]
      expect(record).toMatchObject({ pid: info.pid, homeReference: info.homeDir, logReadState: 'read',
        facts: [{ severity: 'warn', event: 'fresh_agent.hosted_snapshot_unavailable', fields: { code: 'CAPABILITY_PENDING', soul_id: 'owned-file-soul' } }] })
      expect(JSON.stringify(record)).not.toContain('FOREIGN_PID')
      expect(JSON.stringify(record)).not.toContain('file-body-must-not-persist')
      await expect(fsp.stat(info.homeDir!)).rejects.toThrow()
    } finally { await server.stop(); await fsp.rm(directory, { recursive: true }) }
  })
  it('surfaces an unreadable owned Rust log after stopping its PID and allows cleanup retry', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } }, vi.fn())
    let log: string | undefined
    try {
      const info = await server.start()
      log = path.join(info.logsDir!, 'rust-server.jsonl')
      await fsp.writeFile(log, '{}\n', { mode: 0o000 })
      await expect(server.stop()).rejects.toMatchObject({ code: 'EACCES' })
      await expect(fsp.stat(`/proc/${info.pid}`)).rejects.toThrow()
    } finally {
      if (log) await fsp.chmod(log, 0o600)
      await server.stop()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('reports diagnostic finalizer failure after stopping only its exact owned web child', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    let failed = true
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } }, () => {
      if (failed) throw new Error('owned diagnostic write failed')
    })
    try {
      const { pid } = await server.start()
      await expect(server.stop()).rejects.toThrow('owned diagnostic write failed')
      await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
    } finally { failed = false; await server.stop(); await fsp.rm(directory, { recursive: true }) }
  })
  it('stops the actual factory-created web PID when retained producer readiness fails', async () => {
    const { fixture: directory, entry } = await fixture()
    const h = new RuntimeHarness(process.cwd(), undefined, 3)
    const supervisor: SupervisorInstance = { scenarioId: 'task2-config-jsonc', containerId: 'c'.repeat(64),
      controlSocket: path.join(h.testRoot, 'control.sock'), controlSecret: 'owned-unit-secret',
      controlSecretFile: path.join(h.testRoot, 'control-secret'), runtimeRoot: h.testRoot,
      volumeName: 'owned-unit-volume', binaryKind: 'test' }
    vi.spyOn(h, 'startSupervisor').mockResolvedValue(supervisor)
    vi.spyOn(h, 'adminOk').mockResolvedValue({ kind: 'health', data: { controlEpoch: 1 } })
    vi.spyOn(h, 'assert').mockImplementation(() => {})
    vi.spyOn(h, 'waitForFile').mockRejectedValue(new Error('owned MCP readiness failed'))
    let server: runner.ManagedRuntimeWebServer | undefined
    let webPid: number | undefined
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    await fsp.mkdir(h.testRoot, { recursive: true, mode: 0o700 })
    try {
      await expect(runTask2RetainedFixture(h, false, options => {
        server = new runner.ManagedRuntimeWebServer({ ...options, binary: process.execPath,
          candidateSha: 'a'.repeat(40), buildDirty: false, env: { ...options.env, NODE_OPTIONS: `--require=${entry}` } })
        const start = server.start.bind(server)
        vi.spyOn(server, 'start').mockImplementation(async () => {
          const info = await start(); webPid = info.pid; return info
        })
        return server
      })).rejects.toThrow('owned MCP readiness failed')
      expect(webPid).toBeDefined()
      await expect(fsp.stat(`/proc/${webPid}`)).rejects.toThrow()
    } finally {
      await server?.stop()
      vi.unstubAllEnvs()
      await fsp.rm(h.testRoot, { recursive: true, force: true })
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('attempts retained registry cleanup after its actual owned web stop fails', async () => {
    const { fixture: directory, entry } = await fixture()
    const owned = new ManagedRuntimeOwner(() => { throw new Error('base web unused') })
    const info = { baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'owned-stable-token',
      port: 1, configDir: directory, homeDir: directory, logsDir: directory, debugLogPath: path.join(directory, 'log'), pid: 1, runtimeRoot: process.cwd() }
    vi.spyOn(owned, 'info', 'get').mockReturnValue(info)
    const supervisor: SupervisorInstance = { scenarioId: 'owned-failure', containerId: 'c'.repeat(64),
      controlSocket: path.join(directory, 'control.sock'), controlSecret: 'owned-unit-secret', controlSecretFile: path.join(directory, 'secret'),
      runtimeRoot: directory, volumeName: 'owned-unit-volume', binaryKind: 'test' }
    let h: RuntimeHarness | undefined
    vi.spyOn(RuntimeHarness.prototype, 'prepareTask2FixtureArtifacts').mockImplementation(async function () { h = this })
    vi.spyOn(RuntimeHarness.prototype, 'startSupervisor').mockResolvedValue(supervisor)
    vi.spyOn(RuntimeHarness.prototype, 'adminOk').mockResolvedValue({ kind: 'health', data: { controlEpoch: 1 } })
    vi.spyOn(RuntimeHarness.prototype, 'assert').mockImplementation(() => {})
    vi.spyOn(RuntimeHarness.prototype, 'waitForFile').mockRejectedValue(new Error('owned MCP readiness failed'))
    const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(RuntimeHarness.prototype, 'verifyTransferCleanup').mockImplementation(() => {})
    let stopWeb: (() => Promise<void>) | undefined
    let webPid: number | undefined
    const artifact = { path: entry, sha256: 'b'.repeat(64) }
    const artifacts = { candidateSha: owned.runtime.candidateSha, imageDigest: `sha256:${'c'.repeat(64)}`,
      currentSupervisor: artifact, currentHost: artifact, currentServer: artifact, legacySupervisor: artifact, legacyHost: artifact,
      legacyCreatorCommit: '7dbc7ef6b0b87e47ec8386e19115f5e440399898' as const }
    const fixtureOwner = new runner.OwnedRetainedBrowserFixtures(owned, artifacts, ['config'], options => {
      const web = new runner.ManagedRuntimeWebServer({ ...options, binary: process.execPath,
        candidateSha: 'a'.repeat(40), buildDirty: false, env: { ...options.env, NODE_OPTIONS: `--require=${entry}` } })
      const start = web.start.bind(web)
      web.start = async () => { const ready = await start(); webPid = ready.pid; return ready }
      stopWeb = web.stop.bind(web)
      web.stop = async () => { throw new Error('owned web stop failed') }
      return web
    })
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      fixtureOwner.start('config')
      await vi.waitFor(() => expect(fixtureOwner.status().kind).toBe('failed'))
      expect(webPid).toBeDefined()
      expect(cleanup).toHaveBeenCalledOnce()
      await expect(fixtureOwner.cancel()).rejects.toThrow(/cleanup|stop/)
    } finally {
      await stopWeb?.()
      if (webPid) await expect(fsp.stat(`/proc/${webPid}`)).rejects.toThrow()
      if (h) await fsp.rm(h.testRoot, { recursive: true, force: true })
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('strips inherited provider environment after overrides while preserving owned controller references', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      stripEnvPrefixes: ['OPENAI_', 'FRESHELL_MANAGED_CODEX_'], env: { NODE_OPTIONS: `--require=${entry}`,
        OPENAI_UNIT_REFERENCE: 'synthetic-fixture-reference', FRESHELL_MANAGED_CODEX_UNIT_REFERENCE: 'synthetic-fixture-reference',
        FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/unit/control.sock' } })
    try {
      const info = await server.start()
      const response = await fetch(`${info.baseUrl}/api/server-info`, { headers: { 'x-auth-token': info.token } })
      const observed = await response.json()
      expect(observed.environmentKeys).not.toContain('OPENAI_UNIT_REFERENCE')
      expect(observed.environmentKeys).not.toContain('FRESHELL_MANAGED_CODEX_UNIT_REFERENCE')
      expect(observed.environmentKeys).toContain('FRESHELL_RUNTIME_CONTROL_SOCKET')
    } finally {
      await server.stop()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('starts provider-free fixture web without inherited OneCLI references while retaining its controller', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      providerFreeFixture: true, env: { NODE_OPTIONS: `--require=${entry}`,
        FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: '/owned/unit/env-reference',
        FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: '/owned/unit/auth-reference',
        FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: '/owned/unit/ca-reference',
        FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/unit/control.sock' } })
    try {
      const info = await server.start()
      const response = await fetch(`${info.baseUrl}/api/server-info`, { headers: { 'x-auth-token': info.token } })
      const observed = await response.json()
      expect(observed.environmentKeys).not.toContain('FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE')
      expect(observed.environmentKeys).not.toContain('FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE')
      expect(observed.environmentKeys).not.toContain('FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE')
      expect(observed.environmentKeys).toContain('FRESHELL_RUNTIME_CONTROL_SOCKET')
    } finally {
      await server.stop()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('keeps the relay token admitted when the retained fixture selects another owned web process', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    await fsp.writeFile(entry, `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers['x-auth-token']!==process.env.AUTH_TOKEN){res.writeHead(401);res.end('{}');return}res.end(JSON.stringify({runtime:'rust',commit:'${'a'.repeat(40)}',buildDirty:false}))}).listen(Number(process.env.PORT),'127.0.0.1')`)
    const token = 'owned-retained-relay-token'
    const options = { binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40),
      buildDirty: false, setupHome: setup, preserveHomeOnStop: false, token,
      env: { NODE_OPTIONS: `--require=${entry}` } }
    const first = new runner.ManagedRuntimeWebServer(options)
    const replacement = new runner.ManagedRuntimeWebServer(options)
    try {
      const initial = await first.start()
      const next = await replacement.start()
      expect(initial.pid).not.toBe(next.pid)
      expect((await fetch(`${next.baseUrl}/api/server-info`, { headers: { 'x-auth-token': token } })).status).toBe(200)
      expect((await fetch(`${next.baseUrl}/api/server-info`, { headers: { 'x-auth-token': 'foreign-token' } })).status).toBe(401)
    } finally {
      await first.stop()
      await replacement.stop()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('removes its own temporary home after verified process cleanup', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } })
    let home: string | undefined
    try {
      const info = await server.start()
      home = info.homeDir
      await expect(fsp.stat(home)).resolves.toBeDefined()
      await server.stop()
      await expect(fsp.stat(`/proc/${info.pid}`)).rejects.toThrow()
      await expect(fsp.stat(home)).rejects.toThrow()
    } finally {
      await server.stop()
      if (home) await fsp.rm(home, { recursive: true, force: true })
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('preserves scratch config and token/port across exact owned replacement, then verifies PID absence', async () => {
    const { fixture: directory, entry, home, setup } = await fixture()
    const server = new runner.ManagedRuntimeWebServer({
      binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40), buildDirty: false,
      setupHome: setup, homeDir: home, preserveHomeOnStop: true,
      env: { NODE_OPTIONS: `--require=${entry}` },
    })
    let firstPid: number | undefined
    let nextPid: number | undefined
    try {
      const first = await server.start()
      firstPid = first.pid
      await fsp.writeFile(path.join(home, '.freshell/config.json'), JSON.stringify({ version: 1, settings: { retainedChange: 'owned-change' } }))
      const next = await server.restartAbrupt()
      nextPid = next.pid
      expect(next.baseUrl).toBe(first.baseUrl)
      expect(next.token).toBe(first.token)
      expect(next.pid).not.toBe(first.pid)
      expect(setup).toHaveBeenCalledOnce()
      expect(JSON.parse(await fsp.readFile(path.join(home, '.freshell/config.json'), 'utf8')).settings.retainedChange).toBe('owned-change')
      await expect(fsp.stat(`/proc/${first.pid}`)).rejects.toThrow()
    } finally {
      await server.stop()
      if (firstPid) await expect(fsp.stat(`/proc/${firstPid}`)).rejects.toThrow()
      if (nextPid) await expect(fsp.stat(`/proc/${nextPid}`)).rejects.toThrow()
      await fsp.rm(directory, { recursive: true })
    }
  })
})

describe('closed external owner control', () => {
  function fixture() {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('web factory unused in controller unit') })
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const inventory = vi.spyOn(owned, 'inventory').mockResolvedValue([])
    const stop = vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    const request = { runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime', operationId: 'operation-owned', action: 'inventory' }
    return { owned, context, inventory, stop, request }
  }
  it('preserves a body-free typed diagnostic when an admitted owner operation is refused', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul',
      incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    const failure = Object.assign(new Error('private command body and credential must remain omitted'), {
      runtimeError: { code: 'HOST_UNREACHABLE', message: 'private runtime message' },
    })
    vi.spyOn(owned, 'allowFixtureDecision').mockRejectedValue(failure)
    const log = vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    const operation = { ...request, action: 'fixture-decision-allow', handle, challengeId: 'pending-owned' }
    await expect(control(operation)).rejects.toBe(failure)
    await expect(control(operation)).rejects.toBe(failure)
    expect(log).toHaveBeenCalledExactlyOnceWith('external.owner_operation_refused', {
      severity: 'warn', runId: context.runId, candidateSha: context.candidateSha,
      operationId: request.operationId, action: 'fixture-decision-allow', reason: 'runtime_rejection',
      runtimeCode: 'HOST_UNREACHABLE', soulId: handle.soulId, incarnationId: handle.incarnationId,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })
  it('identifies the actual pending-decision predicate without exposing decision or message bodies', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul',
      incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(owned, 'fixtureNativeState').mockResolvedValue({ nativeSessionId: handle.nativeSessionId,
      pendingDecisionId: null, dispatchCount: 2, completionCount: 1 })
    const log = vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control({ ...request, action: 'fixture-decision-allow', handle, challengeId: 'private-decision' })).rejects.toThrow(/pending/)
    expect(log).toHaveBeenCalledWith('external.owner_operation_refused', expect.objectContaining({ reason: 'pending_decision_mismatch' }))
    expect(log.mock.calls[0][1]).not.toHaveProperty('runtimeCode')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-decision')
  })
  it('records which exact address field changed while preserving the original current-handle refusal', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul',
      incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    vi.spyOn(owned, 'allowFixtureDecision').mockImplementation(async () => assertExactRuntimeHandle({
      runId: context.runId, candidateSha: context.candidateSha, receipts: () => [handle],
      inventory: async () => [{ ...handle, nativeSessionId: 'private-replacement-root', launchState: 'running' }],
    }, handle))
    const log = vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control({ ...request, action: 'fixture-decision-allow', handle, challengeId: 'pending-owned' })).rejects.toThrow(/current/)
    expect(log).toHaveBeenCalledWith('external.owner_operation_refused', expect.objectContaining({
      reason: 'current_address_mismatch', mismatchedFields: ['nativeSessionId'],
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-replacement-root')
  })
  it('returns only registered synthetic source IDs, digests and actual counts across the finite transport', async () => {
    const { owned, context, request } = fixture()
    const facts = { rootId: 'source-root', childId: 'source-child', grandchildId: 'source-grandchild',
      unrelatedId: 'source-unrelated', lastMessageId: 'source-tail', nonce: '0123456789abcdef',
      baselineMessages: { 'source-tail': 'a'.repeat(64) }, baselineParts: { 'source-part': 'b'.repeat(64) }, rootMessageCount: 106 }
    const read = vi.spyOn(owned, 'syntheticOpenCodeSourceFacts').mockResolvedValue(facts)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.prepareSyntheticOpenCodeSource()).resolves.toEqual(facts)
    expect(read).toHaveBeenCalledOnce()
    await expect(control({ ...request, action: 'synthetic-source-facts', sql: 'SELECT * FROM message' })).rejects.toThrow(/operation/)
    expect(read).toHaveBeenCalledOnce()
    read.mockResolvedValue({ ...facts, rootMessageCount: -1 })
    await expect(rig.syntheticOpenCodeSourceFacts()).rejects.toThrow(/invalid/)
  })
  it('transports fixed source history and exclusions using the exact current native address', async () => {
    const { owned, context } = fixture()
    const address = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-source-soul',
      incarnationId: 'owned-source-incarnation', containerId: 'c'.repeat(64), hostBootId: 'owned-source-boot', nativeSessionId: 'owned-source-root' }
    const history = { sessions: [address.nativeSessionId], messages: { 'owned-message': 'a'.repeat(64) }, parts: { 'owned-part': 'b'.repeat(64) } }
    const readHistory = vi.spyOn(owned, 'syntheticOpenCodeHistoryFacts').mockResolvedValue(history)
    const readExcluded = vi.spyOn(owned, 'syntheticOpenCodeExcludedSentinels').mockResolvedValue([])
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.syntheticOpenCodeHistoryFacts(address)).resolves.toEqual(history)
    await expect(rig.syntheticOpenCodeExcludedSentinels(address)).resolves.toEqual([])
    expect(readHistory).toHaveBeenCalledWith(address)
    expect(readExcluded).toHaveBeenCalledWith(address)
    readHistory.mockResolvedValue({ ...history, messages: { 'owned-message': 'truncated-digest' } })
    await expect(rig.syntheticOpenCodeHistoryFacts(address)).rejects.toThrow(/invalid/)
  })
  it('transports authenticated source adoption metadata and rejects another root', async () => {
    const { owned, context } = fixture()
    const address = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-source-soul',
      incarnationId: 'owned-source-incarnation', containerId: 'c'.repeat(64), hostBootId: 'owned-source-boot', nativeSessionId: 'owned-source-root' }
    const observation = { terminalId: 'owned-source-terminal', rootSessionId: address.nativeSessionId,
      tailMessageId: 'owned-tail', evidenceGeneration: 'a'.repeat(64), incarnationId: address.incarnationId,
      launchNonce: 'owned-launch', hydrated: true, messagesRead: 'success' as const }
    const read = vi.spyOn(owned, 'syntheticOpenCodeAdoptionStatus').mockResolvedValue({ state: 'observed', data: { observation } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.syntheticOpenCodeAdoptionStatus(address)).resolves.toEqual({ state: 'observed', data: { observation } })
    expect(read).toHaveBeenCalledWith(address)
    read.mockResolvedValue({ state: 'observed', data: { observation: { ...observation, rootSessionId: 'foreign-root' } } })
    await expect(rig.syntheticOpenCodeAdoptionStatus(address)).rejects.toThrow(/invalid/)
  })
  it('returns only the fixed source follow-up ID or no match through the owner', async () => {
    const { owned, context } = fixture()
    const address = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-source-soul',
      incarnationId: 'owned-source-incarnation', containerId: 'c'.repeat(64), hostBootId: 'owned-source-boot', nativeSessionId: 'owned-source-root' }
    const read = vi.spyOn(owned, 'syntheticOpenCodeFollowUpMessageId').mockResolvedValue('actual-matching-message')
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.syntheticOpenCodeFollowUpMessageId(address)).resolves.toBe('actual-matching-message')
    expect(read).toHaveBeenCalledWith(address)
    read.mockResolvedValue(null)
    await expect(rig.syntheticOpenCodeFollowUpMessageId(address)).resolves.toBeNull()
  })
  it('routes exact inventory observations and binds the reply to run, candidate and operation', async () => {
    const { owned, context, inventory, request } = fixture()
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control(request)).resolves.toEqual({ runId: context.runId, candidateSha: context.candidateSha,
      operationId: request.operationId, result: [] })
    expect(inventory).toHaveBeenCalledOnce()
  })
  it('returns the actual inventory snapshot and epoch without a remotely supplied admin request', async () => {
    const { owned, context, request } = fixture()
    const snapshot = { revision: 7, souls: [], viewIntents: [], pendingProjectionCount: 2,
      readiness: { inventoryRevision: 7, initialScanState: 'complete', blockedSubsystems: [],
        startupRecoveryConcurrencyLimit: 4, startupRecoveryPeak: 0 } }
    vi.spyOn(owned, 'inventorySnapshot').mockResolvedValue(snapshot)
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(3)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.inventorySnapshot()).resolves.toEqual(snapshot)
    await expect(rig.controlEpoch()).resolves.toBe(3)
    await expect(control({ ...request, action: 'inventory-snapshot', params: { method: 'launch' } })).rejects.toThrow(/operation/)
    vi.spyOn(owned, 'inventorySnapshot').mockResolvedValue({ ...snapshot, readiness: undefined })
    await expect(rig.inventorySnapshot()).rejects.toThrow(/invalid/)
  })
  it('reads exact owned writer counts after Stop and refuses a replaced native root before the private read', async () => {
    const { owned, context, request, inventory } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'claim-owned-soul',
      incarnationId: 'claim-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'claim-owned-boot', nativeSessionId: 'claim-owned-native' }
    inventory.mockResolvedValue([{ ...handle, launchState: 'stopped', intentRevision: 2, provider: 'opencode' }])
    owned.runtime.broker = { receipts: () => [{ ...handle }] } as unknown as typeof owned.runtime.broker
    const evidence = { provider: 'opencode', providerStoreId: 'owned-store', nativeSessionId: handle.nativeSessionId,
      soulId: handle.soulId, incarnationId: handle.incarnationId, activeClaimCount: 0, globalConflictingClaimCount: 0 }
    const read = vi.spyOn(owned, 'qualificationWriterClaim').mockResolvedValue(evidence)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.writerClaimFacts(handle)).resolves.toEqual(evidence)
    expect(read).toHaveBeenCalledExactlyOnceWith({ provider: 'opencode', soulId: handle.soulId,
      incarnationId: handle.incarnationId, nativeSessionId: handle.nativeSessionId })
    await expect(control({ ...request, action: 'writer-claim', handle: { ...handle, nativeSessionId: 'foreign-root' } })).rejects.toThrow(/owned|current/)
    expect(read).toHaveBeenCalledOnce()
    read.mockResolvedValue({ ...evidence, nativeSessionId: 'foreign-root' })
    await expect(rig.writerClaimFacts(handle)).rejects.toThrow(/invalid/)
  })
  it('applies only the registered managed opt-in preset with the exact controller epoch', async () => {
    const { owned, context, request } = fixture()
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const facts = { migrationId: 'migration-owned', currentMode: 'managed-opt-in', requestedMode: 'managed-opt-in',
      dryRun: false, controllerReady: true, imageVerified: true, registryBackupRequired: false, registryBackupVerified: false,
      managedSoulCount: 0, legacyMetadataCount: 0, projectedCpuMilli: 0, projectedMemoryBytes: 0, projectedPids: 0, blockers: [],
      registryBackupPath: '/owner-private/backup' }
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'migration_plan', data: facts })
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const reply = await control(JSON.parse(String(init.body)))
      wire.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.applyManagedOptIn(4)).resolves.toMatchObject({ currentMode: 'managed-opt-in', dryRun: false })
    expect(admin).toHaveBeenCalledExactlyOnceWith(owned.supervisor, owned.runtime.migrationPlanBody({
      requestedMode: 'managed-opt-in', apply: true, expectedControlEpoch: 4 }))
    expect(wire[0]).toMatchObject({ result: { currentMode: 'managed-opt-in' } })
    expect(wire[0]).not.toHaveProperty('result.registryBackupPath')
    await expect(control({ ...request, action: 'managed-opt-in', expectedControlEpoch: 3 })).rejects.toThrow(/epoch/)
    await expect(control({ ...request, action: 'managed-opt-in', requestedMode: 'managed-default', expectedControlEpoch: 4 })).rejects.toThrow(/operation/)
    expect(admin).toHaveBeenCalledOnce()
  })
  it('preserves graceful web and abrupt supervisor replacement as separate finite operations', async () => {
    const { owned, context } = fixture()
    const web = vi.spyOn(owned, 'restartWebGracefully').mockResolvedValue({} as Awaited<ReturnType<typeof owned.restartWebGracefully>>)
    const supervisor = vi.spyOn(owned, 'restartSupervisorAbrupt').mockResolvedValue({} as SupervisorInstance)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.restartWebGracefully()).resolves.toEqual(rig.info)
    await rig.restartSupervisorAbrupt()
    expect(web).toHaveBeenCalledOnce()
    expect(supervisor).toHaveBeenCalledOnce()
  })
  it('observes only the owned web process PID and boot count through the closed control', async () => {
    const { owned, context, request } = fixture()
    const facts = { pid: 42, bootAttemptCount: 3 }
    Object.assign(owned, { web: { processEvidence: () => facts } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.webProcessFacts()).resolves.toEqual(facts)
    facts.pid = 43
    facts.bootAttemptCount = 4
    await expect(rig.webProcessFacts()).resolves.toEqual({ pid: 43, bootAttemptCount: 4 })
    facts.pid = 0
    await expect(control({ ...request, operationId: 'invalid-web-process', action: 'web-process-facts' })).rejects.toThrow()
    Object.assign(owned, { web: undefined })
    await expect(control({ ...request, operationId: 'unprepared-web-process', action: 'web-process-facts' })).rejects.toThrow(/prepared/)
  })
  it('observes the current owned supervisor container and PID through the closed control', async () => {
    const { owned, context, request } = fixture()
    const first = 'c'.repeat(64)
    const second = 'd'.repeat(64)
    Object.assign(owned, { supervisor: { containerId: first } })
    const inspect = vi.spyOn(owned.runtime, 'ownedContainerHostPidExact').mockImplementation(id => id === first ? 42 : 43)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.supervisorProcessFacts()).resolves.toEqual({ containerId: first, pid: 42 })
    Object.assign(owned, { supervisor: { containerId: second } })
    await expect(rig.supervisorProcessFacts()).resolves.toEqual({ containerId: second, pid: 43 })
    expect(inspect.mock.calls.map(call => call[0])).toEqual([first, second])
    inspect.mockClear()
    Object.assign(owned, { supervisor: { containerId: 'malformed' } })
    await expect(control({ ...request, operationId: 'malformed-supervisor', action: 'supervisor-process-facts' })).rejects.toThrow()
    expect(inspect).not.toHaveBeenCalled()
    Object.assign(owned, { supervisor: undefined })
    await expect(control({ ...request, operationId: 'unprepared-supervisor', action: 'supervisor-process-facts' })).rejects.toThrow(/prepared/)
    Object.assign(owned, { supervisor: { containerId: second } })
    inspect.mockReturnValue(0)
    await expect(control({ ...request, operationId: 'invalid-supervisor-pid', action: 'supervisor-process-facts' })).rejects.toThrow()
    inspect.mockImplementation(() => { throw new Error('unowned exact supervisor') })
    await expect(control({ ...request, operationId: 'unowned-supervisor', action: 'supervisor-process-facts' })).rejects.toThrow(/unowned/)
    inspect.mockClear()
    await expect(control({ ...request, operationId: 'foreign-supervisor-selector', action: 'supervisor-process-facts',
      containerId: first })).rejects.toThrow(/operation/)
    expect(inspect).not.toHaveBeenCalled()
  })
  it('observes actual owner Git integrity without exposing its working diff or accepting another root', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-candidate-integrity-'))
    try {
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
      }
      git('init', '--quiet')
      await fsp.writeFile(path.join(directory, 'owned.txt'), 'initial owned content\n')
      git('add', 'owned.txt')
      git('commit', '--quiet', '-m', 'Create owned integrity fixture')
      const owned = new ManagedRuntimeOwner(() => { throw new Error('unused integrity web') }, directory)
      const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
      const control = runner.createExternalRuntimeControl(owned, context)
      const replies: unknown[] = []
      const transport = vi.fn(async (_url: string, init: RequestInit) => {
        const reply = await control(JSON.parse(String(init.body)))
        replies.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const clean = await rig.captureCandidateIntegrity()
      const empty = createHash('sha256').update('').digest('hex')
      expect(clean).toEqual({ sha: context.candidateSha, dirty: false, diffHash: empty, statusHash: empty })
      await fsp.writeFile(path.join(directory, 'owned.txt'), 'owner-private-change\n')
      const dirty = await rig.captureCandidateIntegrity()
      expect(dirty).toMatchObject({ sha: context.candidateSha, dirty: true })
      expect(dirty.diffHash).not.toBe(empty)
      expect(dirty.statusHash).not.toBe(empty)
      expect(JSON.stringify(replies)).not.toContain('owner-private-change')
      await fsp.writeFile(path.join(directory, 'private-untracked.txt'), 'owner-private-untracked-content')
      const untracked = await rig.captureCandidateIntegrity()
      expect(untracked.dirty).toBe(true)
      expect(untracked.diffHash).toBe(dirty.diffHash)
      expect(untracked.statusHash).not.toBe(dirty.statusHash)
      expect(JSON.stringify(replies)).not.toContain('private-untracked')
      vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
      await rig.stop()
      await expect(rig.captureCandidateIntegrity()).resolves.toEqual(untracked)
      await expect(control({ runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'finished-inventory', action: 'inventory' })).rejects.toThrow(/finished/)
      const replace = vi.spyOn(owned, 'crashAndRestartWeb')
      await expect(control({ runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'finished-web-replace', action: 'replace-web' })).rejects.toThrow(/finished/)
      expect(replace).not.toHaveBeenCalled()
      const request = { runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'foreign-integrity-root', action: 'candidate-integrity', repoRoot: '/foreign/root' }
      await expect(control(request)).rejects.toThrow(/operation/)
      git('add', 'owned.txt')
      git('commit', '--quiet', '-m', 'Change owned candidate fixture')
      await expect(owned.captureCandidateIntegrity()).rejects.toThrow()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('compares an observed incident to the exact owned soul without exposing its summary', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'incident-owned-soul',
      incarnationId: 'incident-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'incident-owned-boot', nativeSessionId: 'incident-owned-native' }
    vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'incident_summary',
      data: { soulId: handle.soulId, privateData: 'owner-private-summary' } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      try {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      } catch { return new Response(JSON.stringify({ error: 'runtime_owner_refused' }), { status: 409 }) }
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.incidentMatchesSoul(handle, 'incident-observed')).resolves.toBe(true)
    expect(admin).toHaveBeenCalledExactlyOnceWith(owned.supervisor, owned.runtime.incidentSummaryBody('incident-observed', 4))
    expect(JSON.stringify(wire)).not.toContain('owner-private-summary')
    admin.mockResolvedValue({ kind: 'incident_summary', data: { soul_id: 'foreign-soul' } })
    await expect(rig.incidentMatchesSoul(handle, 'incident-foreign')).resolves.toBe(false)
    for (const [index, data] of [{}, { soulId: handle.soulId, soul_id: 'contradictory-soul' }].entries()) {
      admin.mockResolvedValue({ kind: 'incident_summary', data })
      await expect(control({ ...request, operationId: `unreadable-incident-${index}`, action: 'incident-matches-soul',
        handle, incidentId: 'incident-unreadable' })).rejects.toThrow(/absent|ambiguous/)
      await expect(rig.incidentMatchesSoul(handle, 'incident-unreadable')).rejects.toThrow(/refused: 409/)
    }
    admin.mockClear()
    vi.mocked(owned.assertCurrentHandle).mockRejectedValue(new Error('stale exact runtime handle'))
    await expect(control({ ...request, operationId: 'stale-incident', action: 'incident-matches-soul',
      handle, incidentId: 'incident-after-replacement' })).rejects.toThrow(/stale/)
    await expect(rig.incidentMatchesSoul(handle, 'incident-after-replacement')).rejects.toThrow(/refused: 409/)
    expect(admin).not.toHaveBeenCalled()
  })
  it('stops only the exact owned incarnation with its observed intent and controller revisions', async () => {
    const { owned, context, request, inventory } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'stop-owned-soul',
      incarnationId: 'stop-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'stop-owned-boot', nativeSessionId: 'stop-owned-native' }
    const view = { soulId: handle.soulId, incarnationId: handle.incarnationId, containerId: handle.containerId,
      hostBootId: handle.hostBootId, nativeSessionId: handle.nativeSessionId,
      launchState: 'running', intentRevision: 7, provider: 'opencode', cleanupState: 'none',
      executionGeneration: 1, desiredState: 'running', recoveryState: 'live', durabilityState: 'resume_captured',
      allocationState: 'verified_durable', evidenceRevision: 1, successfulRecoveriesInWindow: 0 }
    inventory.mockResolvedValue([{ ...view, incarnationId: 'prior-stop-incarnation', containerId: 'c'.repeat(64),
      hostBootId: 'prior-stop-boot', launchState: 'stopped', desiredState: 'stopped', intentRevision: 6 }, view])
    owned.runtime.broker = { receipts: () => [{ ...handle }] } as unknown as typeof owned.runtime.broker
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const stopped = { outcome: 'verified_empty', view: { ...view, launchState: 'stopped', desiredState: 'stopped',
      recoveryState: 'stopped', cleanupState: 'verified_empty', intentRevision: 8 } }
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'stop', data: stopped })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(stopManagedRuntimeSoul(rig, handle.soulId)).resolves.toMatchObject({ outcome: 'verified_empty',
      view: { soulId: handle.soulId, intentRevision: 8, desiredState: 'stopped' } })
    expect(admin).toHaveBeenCalledExactlyOnceWith(owned.supervisor, owned.runtime.stopBody(handle.soulId, 4, 7))
    await expect(control({ ...request, action: 'stop-soul', handle })).rejects.toThrow(/revision|epoch/)
    await expect(control({ ...request, operationId: 'stale-intent', action: 'stop-soul', handle,
      expectedControlEpoch: 4, expectedIntentRevision: 6 })).rejects.toThrow(/revision/)
    await expect(control({ ...request, operationId: 'stale-epoch', action: 'stop-soul', handle,
      expectedControlEpoch: 3, expectedIntentRevision: 7 })).rejects.toThrow(/epoch/)
    for (const launchState of ['running', 'starting', 'prepared', 'unknown']) {
      inventory.mockResolvedValue([{ ...view, incarnationId: 'uncertain-peer', launchState }, view])
      await expect(stopManagedRuntimeSoul(rig, handle.soulId)).rejects.toThrow(/ambiguous/)
    }
    inventory.mockResolvedValue([{ ...view, launchState: 'stopped', desiredState: 'stopped' }])
    await expect(stopManagedRuntimeSoul(rig, handle.soulId)).rejects.toThrow(/absent/)
    inventory.mockResolvedValue([{ ...view, incarnationId: 'replacement-incarnation' }])
    await expect(control({ ...request, operationId: 'stale-address', action: 'stop-soul', handle,
      expectedControlEpoch: 4, expectedIntentRevision: 7 })).rejects.toThrow(/current/)
    expect(admin).toHaveBeenCalledOnce()
  })
  it('returns the fixed OpenCode version and kills only the current host-recorded provider PID', async () => {
    const { owned, context, request, inventory } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'probe-owned-soul',
      incarnationId: 'probe-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'probe-owned-boot', nativeSessionId: 'probe-owned-native' }
    const row = { ...handle, provider: 'opencode', launchState: 'running', intentRevision: 1 }
    inventory.mockResolvedValue([row])
    owned.runtime.broker = { receipts: () => [{ ...handle }] } as unknown as typeof owned.runtime.broker
    const version = vi.spyOn(owned, 'ownedProviderExec').mockResolvedValue('1.18.21\n')
    const facts = { workerPid: 23, workerLaunchCount: 1, unsafeBrokerAttempts: 0,
      limits: { cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '512' } }
    const host = vi.spyOn(owned, 'chaosHostFacts').mockResolvedValue(facts)
    const kill = vi.spyOn(owned.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => {})
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.openCodeVersionFacts(handle)).resolves.toEqual({ provider: 'opencode', version: '1.18.21' })
    expect(version).toHaveBeenCalledExactlyOnceWith(handle.containerId, ['opencode', '--version'])
    inventory.mockResolvedValue([{ ...row, nativeSessionId: undefined }])
    const enclosure = rig.runtimeEnclosureHandle({ ...row, nativeSessionId: undefined })
    await expect(rig.openCodeVersionFacts(enclosure)).resolves.toEqual({ provider: 'opencode', version: '1.18.21' })
    await expect(control({ ...request, action: 'opencode-version', enclosure: { ...enclosure, hostBootId: 'foreign-boot' } })).rejects.toThrow(/current/)
    inventory.mockResolvedValue([row])
    await rig.crashProviderWorker(handle)
    expect(kill).toHaveBeenCalledExactlyOnceWith(handle.containerId, 23)
    host.mockResolvedValue({ ...facts, workerPid: 1 })
    await expect(control({ ...request, operationId: 'invalid-provider-pid', action: 'crash-provider-worker', handle })).rejects.toThrow(/provider.*PID/)
    inventory.mockResolvedValue([{ ...row, provider: 'codex' }])
    await expect(control({ ...request, operationId: 'wrong-provider', action: 'opencode-version', enclosure })).rejects.toThrow(/OpenCode/)
    inventory.mockResolvedValue([{ ...row, incarnationId: 'replacement-incarnation' }])
    await expect(control({ ...request, operationId: 'stale-worker', action: 'crash-provider-worker', handle })).rejects.toThrow(/current/)
    expect(version).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledOnce()
  })
  it('observes fixed loss files with the original hash and diagnostic probes', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-loss-credential-'))
    try {
      const { owned, context, request, inventory } = fixture()
      const row = { soulId: 'credential-soul', incarnationId: 'credential-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'credential-boot', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const credential = path.join(directory, 'auth.json')
      const mapper = path.join(directory, 'map-provider-file.cjs')
      const nativePath = '/home/freshell/provider/.local/share/opencode/auth.json'
      await fsp.writeFile(mapper, `const fs=require('node:fs');for(const name of ['lstatSync','readFileSync']){const original=fs[name];fs[name]=function(file,...args){return original.call(fs,file===${JSON.stringify(nativePath)}?process.env.TEST_LOSS_CREDENTIAL:file,...args)}}`)
      await fsp.writeFile(credential, 'private credential fixture\n', { mode: 0o600 })
      const exec = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        if (args[0] === 'sh') {
          const child = spawnSync('sh', ['-lc', args[2].replaceAll('$HOME', '$TEST_PROVIDER_HOME')], {
            env: { ...process.env, TEST_PROVIDER_HOME: directory }, encoding: 'utf8' })
          if (child.status !== 0) throw new Error(child.stderr)
          return child.stdout
        }
        const child = spawnSync(process.execPath, ['--require', mapper, ...args.slice(1)], {
          env: { ...process.env, TEST_LOSS_CREDENTIAL: credential }, encoding: 'utf8' })
        if (child.status !== 0) throw new Error(child.stderr)
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const enclosure = rig.runtimeEnclosureHandle(row)
      const diagnostic = path.join(directory, 'p5-diagnostic-only')
      await fsp.writeFile(diagnostic, 'phase5-diagnostic-retained-no-credential\n')
      await expect(rig.lossDiagnosticRetained(enclosure)).resolves.toBe(true)
      await fsp.writeFile(diagnostic, 'mismatched private marker\n')
      await expect(rig.lossDiagnosticRetained(enclosure)).resolves.toBe(false)
      await fsp.unlink(diagnostic)
      await expect(rig.lossDiagnosticRetained(enclosure)).resolves.toBe(false)
      const observed = await rig.lossCredentialEvidence(enclosure)
      expect(observed).toEqual({ path: nativePath, exists: true,
        sha256: createHash('sha256').update(await fsp.readFile(credential)).digest('hex') })
      expect(JSON.stringify(observed)).not.toContain('private credential fixture')
      await fsp.writeFile(credential, 'changed private credential fixture\n')
      const changed = await rig.lossCredentialEvidence(enclosure)
      expect(changed.sha256).toBe(createHash('sha256').update(await fsp.readFile(credential)).digest('hex'))
      expect(changed.sha256).not.toBe(observed.sha256)
      await fsp.unlink(credential)
      await expect(rig.lossCredentialEvidence(enclosure)).resolves.toEqual({ path: nativePath, exists: false,
        sha256: createHash('sha256').update('absent').digest('hex') })
      exec.mockClear()
      await expect(control({ ...request, action: 'loss-credential', enclosure: { ...enclosure, hostBootId: 'foreign-boot' } })).rejects.toThrow(/current/)
      await expect(control({ ...request, operationId: 'stale-diagnostic-boot', action: 'loss-diagnostic',
        enclosure: { ...enclosure, hostBootId: 'foreign-boot' } })).rejects.toThrow(/current/)
      await expect(control({ ...request, operationId: 'foreign-diagnostic-command', action: 'loss-diagnostic', enclosure,
        command: 'cat /foreign/marker' })).rejects.toThrow(/operation/)
      inventory.mockResolvedValue([{ ...row, provider: 'codex' }])
      await expect(control({ ...request, operationId: 'foreign-credential-provider', action: 'loss-credential', enclosure })).rejects.toThrow(/OpenCode/)
      await expect(control({ ...request, operationId: 'foreign-credential-path', action: 'loss-credential', enclosure,
        filePath: '/foreign/credential' })).rejects.toThrow(/operation/)
      expect(exec).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('observes all four fixed loss targets and preserves unknown filesystem errors', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-loss-absence-'))
    const denied = path.join(directory, 'denied')
    try {
      const { owned, context, inventory } = fixture()
      const row = { soulId: 'absence-soul', incarnationId: 'absence-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'absence-boot', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const targets = ['/home/freshell/provider/.local/share/opencode/opencode.db',
        '/home/freshell/provider/.local/share/opencode/opencode.db-wal',
        '/home/freshell/provider/.local/share/opencode/opencode.db-shm', '/home/freshell/provider/.freshell/checkpoints']
      const files = [path.join(directory, 'db'), path.join(directory, 'wal'), path.join(denied, 'shm'), path.join(directory, 'checkpoints')]
      await fsp.mkdir(denied)
      await fsp.writeFile(files[0], 'private database fixture')
      await fsp.writeFile(files[2], 'private shm fixture')
      await fsp.mkdir(files[3])
      await fsp.chmod(denied, 0o000)
      const mapper = path.join(directory, 'map-loss-targets.cjs')
      await fsp.writeFile(mapper, `const fs=require('node:fs');const names=${JSON.stringify(targets)};const files=${JSON.stringify(files)};const original=fs.lstatSync;fs.lstatSync=function(file,...args){const index=names.indexOf(file);return original.call(fs,index<0?file:files[index],...args)};`)
      const exec = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        const child = spawnSync(process.execPath, ['--require', mapper, ...args.slice(1)], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error(child.stderr)
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const enclosure = rig.runtimeEnclosureHandle(row)
      const observed = await rig.lossAbsenceEvidence(enclosure)
      expect(observed.map(value => value.path)).toEqual(targets)
      expect(observed.map(value => value.state)).toEqual(['present', 'absent', 'unknown', 'present'])
      expect(observed.every(value => value.state === 'absent')).toBe(false)
      await fsp.chmod(denied, 0o700)
      await fsp.unlink(files[0])
      await fsp.unlink(files[2])
      await fsp.rmdir(files[3])
      expect((await rig.lossAbsenceEvidence(enclosure)).every(value => value.state === 'absent')).toBe(true)
      exec.mockClear()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement-boot' }])
      await expect(owned.lossAbsenceEvidence(enclosure)).rejects.toThrow(/current/)
      inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
      await expect(owned.lossAbsenceEvidence(enclosure)).rejects.toThrow(/OpenCode/)
      await expect(control({ runId: context.runId, candidateSha: context.candidateSha,
        operationId: 'foreign-loss-target', action: 'loss-absence', enclosure,
        path: '/foreign/target' })).rejects.toThrow(/operation/)
      expect(exec).not.toHaveBeenCalled()
    } finally {
      await fsp.chmod(denied, 0o700).catch(() => undefined)
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('removes only fixed resumable loss storage while retaining credentials and the diagnostic marker', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-loss-removal-'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'loss-soul', incarnationId: 'loss-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'loss-boot', nativeSessionId: 'loss-root', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { phase: 5, broker: { receipts: () => [receipt] } })
      const nativePaths = ['/home/freshell/provider/.local/share/opencode/opencode.db',
        '/home/freshell/provider/.local/share/opencode/opencode.db-wal',
        '/home/freshell/provider/.local/share/opencode/opencode.db-shm',
        '/home/freshell/provider/.freshell/checkpoints', '/home/freshell/provider/p5-diagnostic-only']
      const paths = ['db', 'wal', 'shm', 'checkpoints', 'diagnostic'].map(name => path.join(directory, name))
      const credential = path.join(directory, 'auth.json')
      await fsp.writeFile(credential, 'private credential fixture')
      for (const file of paths.slice(0, 3)) await fsp.writeFile(file, 'private database fixture')
      await fsp.mkdir(paths[3])
      await fsp.writeFile(path.join(paths[3], 'copy.db'), 'private checkpoint fixture')
      await fsp.writeFile(paths[4], 'phase5-diagnostic-retained-no-credential')
      const mapper = path.join(directory, 'map-loss-removal.cjs')
      await fsp.writeFile(mapper, `const fs=require('node:fs');const names=${JSON.stringify(nativePaths)};const files=${JSON.stringify(paths)};const root=${JSON.stringify(directory + path.sep)};for(const method of ['unlinkSync','rmSync','statSync']){const original=fs[method];fs[method]=function(file,...args){const name=String(file);const index=names.indexOf(name);if(index<0&&!name.startsWith(root))throw new Error('unregistered fixture target');return original.call(fs,index<0?file:files[index],...args)}};`)
      const exec = vi.spyOn(owned, 'ownedContainerExec').mockImplementation((_id, args) => {
        const child = spawnSync(process.execPath, ['--require', mapper, ...args.slice(1)], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('fixed loss command refused')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const handle = rig.exactRuntimeHandle(row)
      await rig.removeLossStorage(handle)
      for (const file of paths.slice(0, 4)) await expect(fsp.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fsp.readFile(credential, 'utf8')).toBe('private credential fixture')
      expect(await fsp.readFile(paths[4], 'utf8')).toBe('phase5-diagnostic-retained-no-credential')
      await rig.removeLossStorage(handle)
      await fsp.unlink(paths[4])
      await expect(owned.removeLossStorage(handle)).rejects.toThrow(/refused/)
      exec.mockClear()
      inventory.mockResolvedValue([{ ...row, nativeSessionId: 'replacement-root' }])
      await expect(owned.removeLossStorage(handle)).rejects.toThrow()
      await expect(control({ ...request, action: 'loss-remove-storage', handle, path: '/foreign' })).rejects.toThrow(/operation/)
      inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
      await expect(owned.removeLossStorage(handle)).rejects.toThrow(/OpenCode/)
      inventory.mockResolvedValue([row])
      Object.assign(owned.runtime, { phase: 2 })
      await expect(owned.removeLossStorage(handle)).rejects.toThrow(/Phase 5/)
      expect(exec).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('requests the fixed loss recovery with the owner epoch and projects only its observed fields', async () => {
    const { owned, context, inventory, request } = fixture()
    const row = { soulId: 'recovery-soul', incarnationId: 'recovery-incarnation', containerId: 'b'.repeat(64),
      hostBootId: 'recovery-boot', nativeSessionId: 'recovery-root', provider: 'opencode', launchState: 'running', intentRevision: 4 }
    inventory.mockResolvedValue([row])
    const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
      createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: '/owned/runtime' }
    Object.assign(owned.runtime, { phase: 5, broker: { receipts: () => [receipt] } })
    const epoch = vi.spyOn(owned, 'controlEpoch').mockResolvedValue(12)
    const observed = { outcome: 'lost', incidentId: 'incident-observed', view: { cleanupState: 'verified_empty',
      nativeSessionId: row.nativeSessionId, intentRevision: 5 } }
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'recovery', data: {
      ...observed, privateDiagnostics: 'owner-only', view: { ...observed.view, privateConfig: 'owner-only' } } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const reply = await control(JSON.parse(String(init.body)))
      wire.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    const handle = rig.exactRuntimeHandle(row)
    await expect(rig.recoverLoss(handle)).resolves.toEqual(observed)
    const container = vi.spyOn(owned.runtime, 'isContainerRunning').mockReturnValue(false)
    await expect(rig.lossContainerRunning(observed.incidentId)).resolves.toBe(false)
    expect(container).toHaveBeenCalledExactlyOnceWith(row.containerId)
    container.mockReturnValue(true)
    await expect(rig.lossContainerRunning(observed.incidentId)).resolves.toBe(true)
    container.mockClear()
    await expect(owned.lossContainerRunning('incident-foreign')).rejects.toThrow(/observed/)
    expect(container).not.toHaveBeenCalled()
    expect(admin.mock.calls[0][1]).toEqual({ method: 'recover', params: { soulId: row.soulId,
      trigger: 'provider_exit', expectedControlEpoch: 12 } })
    expect(JSON.stringify(wire)).not.toContain('owner-only')
    admin.mockResolvedValue({ kind: 'recovery', data: { ...observed, outcome: 'blocked' } })
    await expect(rig.recoverLoss(handle)).resolves.toMatchObject({ outcome: 'blocked' })
    admin.mockResolvedValue({ kind: 'recovery', data: { ...observed, view: { ...observed.view, intentRevision: -1 } } })
    await expect(owned.recoverLoss(handle)).rejects.toThrow()
    admin.mockResolvedValue({ kind: 'health', data: observed })
    await expect(owned.recoverLoss(handle)).rejects.toThrow(/expected recovery/)
    admin.mockClear()
    epoch.mockClear()
    inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement-boot' }])
    await expect(owned.recoverLoss(handle)).rejects.toThrow(/current/)
    await expect(control({ ...request, action: 'loss-recover', handle, trigger: 'explicit_request' })).rejects.toThrow(/operation/)
    expect(epoch).not.toHaveBeenCalled()
    expect(admin).not.toHaveBeenCalled()
  })
  it('runs the closed Phase3 effect operations over the same pre-native enclosure', async () => {
    const { owned, context, request } = fixture()
    const enclosure = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'p3-soul',
      incarnationId: 'p3-incarnation', containerId: 'b'.repeat(64), hostBootId: 'p3-boot' }
    const reset = vi.spyOn(owned, 'resetPhase3ApprovalEffect').mockResolvedValue(undefined)
    const count = vi.spyOn(owned, 'phase3ApprovalEffectCount').mockResolvedValue(1)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await rig.resetPhase3ApprovalEffect(enclosure)
    await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(1)
    expect(reset).toHaveBeenCalledExactlyOnceWith(enclosure)
    expect(count).toHaveBeenCalledExactlyOnceWith(enclosure)
    await expect(control({ ...request, action: 'phase3-effect-count' })).rejects.toThrow(/enclosure/)
    await expect(control({ ...request, operationId: 'forged-effect', action: 'phase3-effect-reset', enclosure,
      path: '/arbitrary' })).rejects.toThrow(/operation/)
    expect(reset).toHaveBeenCalledOnce()
  })
  it('returns fixed fresh-agent launch facts over a pre-native enclosure and refuses native commands', async () => {
    const { owned, context, request } = fixture()
    const enclosure = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'fresh-soul',
      incarnationId: 'fresh-incarnation', containerId: 'b'.repeat(64), hostBootId: 'fresh-boot' }
    const facts = vi.spyOn(owned, 'freshAgentLaunchFacts').mockResolvedValue({ provider: 'claude', version: '2.1.263', workerPid: 42 })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.freshAgentLaunchFacts(enclosure)).resolves.toEqual({ provider: 'claude', version: '2.1.263', workerPid: 42 })
    expect(facts).toHaveBeenCalledExactlyOnceWith(enclosure)
    await expect(control({ ...request, action: 'fresh-agent-launch-facts' })).rejects.toThrow(/enclosure/)
    await expect(control({ ...request, operationId: 'forged-launch', action: 'fresh-agent-launch-facts', enclosure,
      command: ['claude', 'arbitrary'] })).rejects.toThrow(/operation/)
    expect(facts).toHaveBeenCalledOnce()
  })
  it('reads only the bound prior-container status through the finite client', async () => {
    const { owned, context, request } = fixture()
    const enclosure = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'prior-soul',
      incarnationId: 'prior-incarnation', containerId: 'b'.repeat(64), hostBootId: 'prior-boot' }
    const state = vi.spyOn(owned, 'ownedContainerState').mockResolvedValue({ present: true, running: false })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.ownedContainerState(enclosure)).resolves.toEqual({ present: true, running: false })
    expect(state).toHaveBeenCalledExactlyOnceWith(enclosure)
    await expect(control({ ...request, action: 'container-state' })).rejects.toThrow(/enclosure/)
    await expect(control({ ...request, operationId: 'forged-state', action: 'container-state', enclosure,
      path: '/arbitrary' })).rejects.toThrow(/operation/)
    expect(state).toHaveBeenCalledOnce()
  })
  it('publishes only the fixed Phase3 browser observation and returns an opaque artifact reference', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'p3-soul',
      incarnationId: 'p3-incarnation', containerId: 'b'.repeat(64), hostBootId: 'p3-boot', nativeSessionId: 'p3-native' }
    const browser: Phase3BrowserObservation = { browserInteraction: true, provider: 'opencode', providerVersion: '1.18.21', model: 'openai/gpt-5.6-luna',
      paneId: 'pane', terminalId: 'terminal', soulId: handle.soulId, incarnationIdBefore: 'old', incarnationIdAfter: handle.incarnationId,
      providerSessionIdBefore: handle.nativeSessionId, providerSessionIdAfter: handle.nativeSessionId, approvalPromptNativeId: handle.nativeSessionId,
      permissionPromptHandled: true, approvalSurvived: true, samePane: true, visibleRecoveryState: true, rejectedInputWhileRecovering: true,
      accidentalApproval: false, toolCompletedExactlyOnce: true, providerHostSurvivedWebRestart: true, followUpCompleted: true, followUpResponse: 'P3_FOLLOWUP_OK' }
    const publish = vi.spyOn(owned, 'publishPhase3BrowserReceipt').mockResolvedValue({ artifactRef: `phase3-browser:${'d'.repeat(64)}` })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.publishPhase3BrowserReceipt(handle, browser)).resolves.toEqual({ artifactRef: `phase3-browser:${'d'.repeat(64)}` })
    expect(publish).toHaveBeenCalledExactlyOnceWith(handle, browser)
    await expect(control({ ...request, action: 'phase3-browser-receipt', handle })).rejects.toThrow(/observation/)
    await expect(control({ ...request, operationId: 'forged-receipt', action: 'phase3-browser-receipt', handle,
      phase3Browser: { ...browser, credential: 'not-an-observation' } })).rejects.toThrow(/operation/)
    expect(publish).toHaveBeenCalledOnce()
  })
  it('refuses arbitrary commands, foreign metadata and absent current handles before owner work', async () => {
    const { owned, context, inventory, request } = fixture()
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control({ ...request, command: ['docker', 'exec'] })).rejects.toThrow(/operation/)
    await expect(control({ ...request, runId: 'foreign-run' })).rejects.toThrow(/owned/)
    const crash = vi.spyOn(owned, 'crashRuntimeHost').mockResolvedValue(undefined)
    await expect(control({ ...request, operationId: 'crash-owned', action: 'crash-host' })).rejects.toThrow(/handle/)
    expect(inventory).not.toHaveBeenCalled()
    expect(crash).not.toHaveBeenCalled()
  })
  it('settles finish once and refuses fresh work after the owned runtime is cleaned', async () => {
    const { owned, context, inventory, stop, request } = fixture()
    const control = runner.createExternalRuntimeControl(owned, context)
    const finish = { ...request, action: 'finish' }
    await control(finish)
    await control(finish)
    await expect(control({ ...request, operationId: 'after-finish' })).rejects.toThrow(/finished/)
    expect(stop).toHaveBeenCalledOnce()
    expect(inventory).not.toHaveBeenCalled()
  })
  it('starts only a registered retained fixture once after a lost start reply', async () => {
    const { owned, context, request } = fixture()
    const session = new RetainedFixtureBrowserSession()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const start = vi.fn((fixtureId: 'config' | 'legacy') => {
      expect(fixtureId).toBe('legacy')
      session.start(async () => { await pending })
    })
    const retained = { start, status: () => session.status(), advance: (sequence: number) => session.advance(sequence),
      cancel: async () => { release(); await session.cancel() } }
    const control = runner.createExternalRuntimeControl(owned, context, retained)
    try {
      await expect(control({ ...request, action: 'retained-start', challengeId: 'foreign' })).rejects.toThrow(/fixture|operation/)
      expect(start).not.toHaveBeenCalled()
      const begin = { ...request, operationId: 'retained-begin', action: 'retained-start', challengeId: 'legacy' }
      await expect(control(begin)).resolves.toMatchObject({ result: { kind: 'preparing' } })
      await control(begin)
      expect(start).toHaveBeenCalledOnce()
      await expect(control({ ...request, operationId: 'retained-observe', action: 'retained-observed', generation: 0 })).rejects.toThrow(/stage/)
      await expect(control({ ...request, operationId: 'retained-forged', action: 'retained-status', response: {} })).rejects.toThrow(/operation/)
    } finally {
      await retained.cancel()
    }
  })
  it('still cleans the main owned runtime when retained fixture teardown fails', async () => {
    const { owned, context, request, stop } = fixture()
    const retained = { start: vi.fn(), status: () => ({ kind: 'preparing' as const, sequence: 0 }),
      advance: vi.fn(), cancel: vi.fn(async () => { throw new Error('owned fixture cleanup failed') }) }
    const control = runner.createExternalRuntimeControl(owned, context, retained)
    await expect(control({ ...request, action: 'finish' })).resolves.toMatchObject({ result: {
      ok: false, errors: ['retained fixture cleanup failed'],
    } })
    expect(stop).toHaveBeenCalledOnce()
  })
  it('finishes each retained case without ending the owner needed by the next selected case', async () => {
    const { owned, context, request, stop, inventory } = fixture()
    const retained = { start: vi.fn(), status: () => ({ kind: 'finished' as const, sequence: 1 }),
      advance: vi.fn(), cancel: vi.fn(async () => {}) }
    const control = runner.createExternalRuntimeControl(owned, context, retained)
    await expect(control({ ...request, operationId: 'config-finished', action: 'retained-finish' })).resolves.toMatchObject({ result: { ok: true, errors: [] } })
    expect(retained.cancel).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
    await control({ ...request, operationId: 'between-cases' })
    expect(inventory).toHaveBeenCalledOnce()
    await control({ ...request, operationId: 'legacy-begin', action: 'retained-start', challengeId: 'legacy' })
    expect(retained.start).toHaveBeenCalledWith('legacy')
  })
  it('holds and releases only the exact current host, retaining the held PID for cleanup', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'held-owned-soul',
      incarnationId: 'held-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'held-owned-boot', nativeSessionId: 'held-owned-native' }
    const validate = vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    const signal = vi.spyOn(owned, 'signalOwnedSessionHostExact').mockReturnValue(1234)
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control({ ...request, action: 'hold-host', handle })).resolves.toMatchObject({ result: { pid: 1234 } })
    expect(validate).toHaveBeenCalledWith(handle)
    expect(signal).toHaveBeenCalledExactlyOnceWith(handle.containerId, handle.incarnationId, 'SIGSTOP')
    await expect(control({ ...request, operationId: 'foreign-release', action: 'release-host', handle: { ...handle, hostBootId: 'foreign-boot' } })).rejects.toThrow(/held/)
    expect(signal).toHaveBeenCalledOnce()
    await control({ ...request, operationId: 'owned-release', action: 'release-host', handle })
    expect(signal).toHaveBeenLastCalledWith(handle.containerId, handle.incarnationId, 'SIGCONT', 1234)
    await expect(control({ ...request, operationId: 'duplicate-release', action: 'release-host', handle })).rejects.toThrow(/held/)
    expect(signal).toHaveBeenCalledTimes(2)
  })
  it.each([
    { kind: 'chaos-approval' as const, marker: 'p5-chaos-approval-count' },
    { kind: 'chaos-long-tool' as const, marker: 'p5-chaos-long-tool-count' },
  ])('reads and resets only registered $kind while refusing unregistered or wrong-root requests', async ({ kind, marker }) => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'chaos-owned-soul',
      incarnationId: 'chaos-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'chaos-owned-boot', nativeSessionId: 'chaos-owned-native' }
    vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    const challenge = await owned.registerNativeChallenge(handle, kind)
    const probe = vi.spyOn(owned, 'ownedProviderExec').mockResolvedValue('2\n')
    const count = { ...request, operationId: 'owned-effect-count', action: 'native-effect-count', handle, challengeId: challenge.challengeId }
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.nativeChallengeEffectCount(handle, challenge.challengeId)).resolves.toBe(2)
    expect(probe).toHaveBeenCalledExactlyOnceWith(handle.containerId, ['sh', '-lc',
      `test -f "$HOME/${marker}" && wc -l < "$HOME/${marker}" || printf 0`])
    probe.mockClear()
    await expect(control({ ...count, operationId: 'unknown-effect', challengeId: 'unregistered' })).rejects.toThrow(/challenge/)
    await expect(control({ ...count, operationId: 'foreign-effect', handle: { ...handle, nativeSessionId: 'foreign-root' } })).rejects.toThrow(/challenge/)
    const followUp = await owned.registerNativeChallenge(handle, 'chaos-follow-up')
    await expect(control({ ...count, operationId: 'non-effect-challenge', challengeId: followUp.challengeId })).rejects.toThrow(/effect/)
    expect(probe).not.toHaveBeenCalled()
    await rig.resetNativeChallengeEffect(handle, challenge.challengeId)
    expect(probe).toHaveBeenCalledExactlyOnceWith(handle.containerId, ['rm', '-f', `/home/freshell/provider/${marker}`])
    for (const raw of ['truncated', '-1', '9007199254740992']) {
      probe.mockResolvedValue(raw)
      await expect(control({ ...count, operationId: `invalid-${raw}` })).rejects.toThrow(/count/)
    }
  })
  it('registers a closed native challenge and refuses unknown or wrong-root probe requests before reading', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'challenge-owned-soul',
      incarnationId: 'challenge-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'challenge-owned-boot', nativeSessionId: 'challenge-owned-native' }
    vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    const exec = vi.spyOn(owned, 'ownedProviderExec').mockResolvedValue(JSON.stringify({ requestIds: ['tool-actual'], resultIds: ['tool-actual'], replayCount: 0 }))
    const control = runner.createExternalRuntimeControl(owned, context)
    const reply = await control({ ...request, action: 'native-challenge-register', handle, challengeId: 'chaos-approval' })
    const parsed = z.object({ result: z.object({ challengeId: z.string().uuid() }) }).passthrough().parse(reply)
    await expect(control({ ...request, operationId: 'unknown-probe', action: 'native-tool-evidence', handle, challengeId: 'unregistered' })).rejects.toThrow(/challenge/)
    await expect(control({ ...request, operationId: 'wrong-root', action: 'native-tool-evidence',
      handle: { ...handle, nativeSessionId: 'foreign-root' }, challengeId: parsed.result.challengeId })).rejects.toThrow(/challenge/)
    expect(exec).not.toHaveBeenCalled()
    await expect(control({ ...request, operationId: 'owned-probe', action: 'native-tool-evidence', handle, challengeId: parsed.result.challengeId }))
      .resolves.toMatchObject({ result: { requestIds: ['tool-actual'], resultIds: ['tool-actual'], replayCount: 0 } })
    expect(exec).toHaveBeenCalledExactlyOnceWith(handle.containerId, expect.arrayContaining(['challenge-owned-native', 'p5-chaos-approval-count']))
  })
  it('observes bounded chaos server-output facts without returning its body or token', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'output-owned-soul',
      incarnationId: 'output-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'output-owned-boot', nativeSessionId: 'output-owned-native' }
    vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    const challenge = await owned.registerNativeChallenge(handle, 'chaos-follow-up')
    const output = { stdout: 'owner-private-output-λ', stderr: 'owner-private-error' }
    const token = 'owner-private-token'
    const capture = vi.fn(() => output)
    Object.assign(owned, { web: { capturedOutput: capture, info: { token } } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const bytes = `${output.stdout}${output.stderr}`
    const wire: unknown[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const reply = await control(JSON.parse(String(init.body)))
      wire.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.chaosWebOutputFacts(handle, challenge.challengeId)).resolves.toEqual({
      contentSha256: createHash('sha256').update(bytes).digest('hex'), contentBytes: Buffer.byteLength(bytes),
      containsFollowUpMarker: false, containsAuthToken: false })
    expect(JSON.stringify(wire)).not.toContain(output.stdout)
    expect(JSON.stringify(wire)).not.toContain(output.stderr)
    expect(JSON.stringify(wire)).not.toContain(token)
    output.stdout = `${token}P5_CHAOS_FOLLOWUP`
    await expect(rig.chaosWebOutputFacts(handle, challenge.challengeId)).resolves.toMatchObject({
      containsFollowUpMarker: true, containsAuthToken: true })
    const approval = await owned.registerNativeChallenge(handle, 'chaos-approval')
    capture.mockClear()
    await expect(control({ ...request, operationId: 'wrong-output-kind', action: 'chaos-web-output',
      handle, challengeId: approval.challengeId })).rejects.toThrow(/follow-up/)
    await expect(control({ ...request, operationId: 'wrong-output-root', action: 'chaos-web-output',
      handle: { ...handle, nativeSessionId: 'foreign-root' }, challengeId: challenge.challengeId })).rejects.toThrow(/challenge/)
    expect(capture).not.toHaveBeenCalled()
  })
  it('observes only the registered long-tool process without exposing its process table', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'long-tool-soul',
      incarnationId: 'long-tool-incarnation', containerId: 'b'.repeat(64), hostBootId: 'long-tool-boot', nativeSessionId: 'long-tool-native' }
    const current = vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    const challenge = await owned.registerNativeChallenge(handle, 'chaos-long-tool')
    const table = vi.spyOn(owned, 'ownedContainerProcessTable').mockReturnValue('42 sleep 180\n43 owner-private-process-arguments')
    const control = runner.createExternalRuntimeControl(owned, context)
    const replies: unknown[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const reply = await control(JSON.parse(String(init.body)))
      replies.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.chaosLongToolRunning(handle, challenge.challengeId)).resolves.toBe(true)
    table.mockReturnValue('42 sleep 18\n43 owner-private-process-arguments')
    await expect(rig.chaosLongToolRunning(handle, challenge.challengeId)).resolves.toBe(false)
    expect(JSON.stringify(replies)).not.toContain('owner-private-process-arguments')
    table.mockClear()
    const approval = await owned.registerNativeChallenge(handle, 'chaos-approval')
    await expect(control({ ...request, action: 'chaos-long-tool-running', handle, challengeId: approval.challengeId })).rejects.toThrow(/long-tool/)
    await expect(control({ ...request, operationId: 'foreign-long-tool-root', action: 'chaos-long-tool-running',
      handle: { ...handle, nativeSessionId: 'foreign-root' }, challengeId: challenge.challengeId })).rejects.toThrow(/challenge/)
    await expect(control({ ...request, operationId: 'unknown-long-tool', action: 'chaos-long-tool-running',
      handle, challengeId: 'unregistered' })).rejects.toThrow(/challenge/)
    current.mockRejectedValue(new Error('exact runtime handle changed'))
    await expect(control({ ...request, operationId: 'stale-long-tool', action: 'chaos-long-tool-running',
      handle, challengeId: challenge.challengeId })).rejects.toThrow(/changed/)
    expect(table).not.toHaveBeenCalled()
  })
  it('persists both fixed chaos logs privately before returning their observed artifact references', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-chaos-logs-'))
    try {
      const { owned, context, request } = fixture()
      Object.assign(owned.runtime, { evidenceDir: directory, lifecyclePath: path.join(directory, 'lifecycle.jsonl') })
      const current = vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
      const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'log-owned-soul',
        incarnationId: 'log-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'log-owned-boot', nativeSessionId: 'log-owned-native' }
      const logs = { server: [structuredChaosLog('server', 1, 100, 'info', 'supervisor.replaced', 'private server body')],
        browser: [structuredChaosLog('browser', 1, 120, 'info', 'web.replaced', 'private browser body')] }
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const references = await rig.publishChaosLogs(handle, logs)
      const sources: Array<'server' | 'browser'> = ['server', 'browser']
      for (const source of sources) {
        const file = path.join(directory, `phase5-chaos-${source}-log.jsonl`)
        const bytes = await fsp.readFile(file)
        expect(bytes.toString()).toBe(`${logs[source].map(row => JSON.stringify(row)).join('\n')}\n`)
        expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
        expect(references[`${source}ArtifactRef`]).toBe(`phase5-chaos-${source}-log:${createHash('sha256').update(bytes).digest('hex')}`)
        expect(bytes.toString()).not.toContain(`private ${source} body`)
      }
      expect(JSON.stringify(references)).not.toContain(directory)
      const before = await fsp.readFile(path.join(directory, 'phase5-chaos-server-log.jsonl'))
      await expect(control({ ...request, action: 'chaos-logs', handle, chaosLogs: { ...logs, browser: [] } })).rejects.toThrow()
      await expect(control({ ...request, operationId: 'wrong-log-role', action: 'chaos-logs', handle,
        chaosLogs: { server: logs.browser, browser: logs.server } })).rejects.toThrow()
      await expect(control({ ...request, operationId: 'foreign-log-path', action: 'chaos-logs', handle,
        chaosLogs: logs, filePath: '/foreign/log.jsonl' })).rejects.toThrow(/operation/)
      current.mockRejectedValue(new Error('exact runtime handle changed'))
      await expect(control({ ...request, operationId: 'stale-chaos-logs', action: 'chaos-logs', handle, chaosLogs: logs })).rejects.toThrow(/changed/)
      expect(await fsp.readFile(path.join(directory, 'phase5-chaos-server-log.jsonl'))).toEqual(before)
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('keeps the fixed chaos JSON artifacts with the owner and supplies actual candidate/run identity', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-chaos-json-'))
    try {
      const { owned, context, request } = fixture()
      Object.assign(owned.runtime, { evidenceDir: directory, lifecyclePath: path.join(directory, 'lifecycle.jsonl') })
      vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
      const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'json-owned-soul',
        incarnationId: 'json-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'json-owned-boot', nativeSessionId: 'json-owned-native' }
      const evidence = { providerEvents: { schemaVersion: 1, provider: 'opencode', nativeSessionId: handle.nativeSessionId,
        observedMarker: 'transport fixture, no native qualification' },
        assertions: { schemaVersion: 1, caseId: 'P5-G09', identity: { soulId: handle.soulId, incarnationId: handle.incarnationId,
          containerId: handle.containerId, hostBootId: handle.hostBootId, nativeSessionId: handle.nativeSessionId },
        candidateSha: 'caller-value', receiptRunId: 'caller-value', observations: ['transport fixture only'] } }
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const references = await rig.publishChaosEvidence(handle, evidence)
      const assertions = JSON.parse(await fsp.readFile(path.join(directory, 'phase5-chaos-assertions.json'), 'utf8'))
      expect(assertions).toMatchObject({ candidateSha: context.candidateSha, receiptRunId: context.runId,
        observations: evidence.assertions.observations })
      for (const [fileName, artifactRef] of [['phase5-chaos-provider-events.json', references.providerEventsArtifactRef],
        ['phase5-chaos-assertions.json', references.assertionsArtifactRef]]) {
        const file = path.join(directory, fileName)
        expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
        expect(artifactRef).toBe(`${fileName.slice(0, -5)}:${createHash('sha256').update(await fsp.readFile(file)).digest('hex')}`)
      }
      expect(JSON.stringify(references)).not.toContain(directory)
      const before = await fsp.readFile(path.join(directory, 'phase5-chaos-provider-events.json'))
      await expect(control({ ...request, action: 'chaos-evidence', handle, chaosEvidence: {
        ...evidence, providerEvents: { ...evidence.providerEvents, nativeSessionId: 'foreign-root' } } })).rejects.toThrow(/identity|root/)
      await expect(control({ ...request, operationId: 'foreign-chaos-json-address', action: 'chaos-evidence', handle,
        chaosEvidence: { ...evidence, assertions: { ...evidence.assertions, identity: { ...evidence.assertions.identity, hostBootId: 'foreign-boot' } } } })).rejects.toThrow(/identity|address/)
      await expect(control({ ...request, operationId: 'foreign-chaos-json-path', action: 'chaos-evidence', handle,
        chaosEvidence: evidence, filePath: '/foreign/evidence.json' })).rejects.toThrow(/operation/)
      expect(await fsp.readFile(path.join(directory, 'phase5-chaos-provider-events.json'))).toEqual(before)
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('refuses to finalize a chaos receipt from custody-only records after cleanup', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused receipt web') }, process.cwd(), 5)
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    const write = vi.spyOn(owned, 'writePhase5ChaosReceipt')
    try {
      await expect(owned.finalizeChaosReceipt()).rejects.toThrow(/observation|captured/)
      await rig.captureCandidateIntegrity()
      const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'unqualified-custody-soul',
        incarnationId: 'unqualified-custody-incarnation', containerId: 'b'.repeat(64), hostBootId: 'unqualified-custody-boot', nativeSessionId: 'unqualified-custody-native' }
      vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
      await rig.publishChaosEvidence(handle, { providerEvents: { schemaVersion: 1, provider: 'opencode', nativeSessionId: handle.nativeSessionId },
        assertions: { schemaVersion: 1, caseId: 'P5-G09', identity: { soulId: handle.soulId, incarnationId: handle.incarnationId,
          containerId: handle.containerId, hostBootId: handle.hostBootId, nativeSessionId: handle.nativeSessionId } } })
      await expect(owned.finalizeChaosReceipt()).rejects.toThrow(/cleanup/)
      Object.assign(owned, { stopSettlement: Promise.resolve({ ok: false, errors: ['owned cleanup fixture failure'] }) })
      await expect(owned.finalizeChaosReceipt()).rejects.toThrow(/cleanup failed/)
      Object.assign(owned, { stopSettlement: Promise.resolve({ ok: true, errors: [] }) })
      await rig.stop()
      await expect(rig.finalizeChaosReceipt()).rejects.toThrow()
      await expect(owned.finalizeChaosReceipt()).rejects.toThrow(/cycles|array/)
      expect(write).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(owned.runtime.evidenceDir, { recursive: true, force: true })
    }
  })
  it('creates synthetic history only for the registered OpenCode fixture and returns observed row identities', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused web') }, process.cwd(), 3, {}, {}, 'test', {
      enabledProviders: [], freshAgentModes: ['freshopencode'], fixtureFreshAgentModes: ['freshopencode'],
    })
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'synthetic-owned-soul',
      incarnationId: 'synthetic-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'synthetic-owned-boot', nativeSessionId: 'synthetic-owned-native' }
    vi.spyOn(owned, 'assertCurrentHandle').mockResolvedValue(undefined)
    const worker = vi.spyOn(owned, 'fixtureWorkerFacts').mockResolvedValue({ provider: 'codex', workerPid: 42 })
    vi.spyOn(owned, 'fixtureNativeState').mockResolvedValue({ nativeSessionId: handle.nativeSessionId, pendingDecisionId: null, dispatchCount: 1, completionCount: 1 })
    const exec = vi.spyOn(owned, 'ownedProviderExec').mockResolvedValue(JSON.stringify({ nativeSessionId: handle.nativeSessionId,
      messageId: 'observed-message', toolPartId: 'observed-tool' }))
    const control = runner.createExternalRuntimeControl(owned, context)
    const request = { runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'synthetic-fixture', action: 'synthetic-history-challenge', handle }
    await expect(control(request)).rejects.toThrow(/OpenCode|opencode|operation/)
    expect(exec).not.toHaveBeenCalled()
    worker.mockResolvedValue({ provider: 'opencode', workerPid: 42 })
    const result = await control({ ...request, operationId: 'synthetic-valid' })
    expect(result).toMatchObject({ result: { nativeSessionId: handle.nativeSessionId, messageId: 'observed-message', toolPartId: 'observed-tool' } })
    expect(exec).toHaveBeenCalledTimes(2)
    await expect(control({ ...request, operationId: 'synthetic-forged', sql: 'select anything' })).rejects.toThrow(/operation/)
  })
})

describe('external finite fixture client', () => {
  it('retries a lost mutation reply with the same operation ID and settles owner cleanup once', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('web factory unused in RPC unit') })
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const stop = vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    const control = runner.createExternalRuntimeControl(owned, context)
    const operationIds: string[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      operationIds.push(request.operationId)
      const result = await control(request)
      if (operationIds.length === 1) throw new Error('lost owned cleanup reply')
      return new Response(JSON.stringify(result), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
    expect(operationIds).toHaveLength(2)
    expect(new Set(operationIds).size).toBe(1)
    expect(stop).toHaveBeenCalledOnce()
  })
  it('sends a closed bound request and refuses an otherwise successful stale reply', async () => {
    const child = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: [] }), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(runner.resolveManagedExternalDescriptor(descriptor)!, child)
    await expect(rig.inventory()).resolves.toEqual([])
    expect(child).toHaveBeenCalledWith('https://owned.trycloudflare.com/__managed_runtime', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'x-auth-token': descriptor.FRESHELL_E2E_TARGET_TOKEN }),
      body: expect.any(String),
    }))
    expect(JSON.parse(String(child.mock.calls[0][1].body))).toMatchObject({
      runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID, candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
      scenarioId: 'browser-managed-runtime', action: 'inventory',
    })
    child.mockImplementationOnce(async () => new Response(JSON.stringify({ runId: 'foreign-run',
      candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA, operationId: 'other-operation', result: [] }), { status: 200 }))
    await expect(rig.inventory()).rejects.toThrow(/run|reply|literal|expected/)
  })
  it('refuses an owner registered for a different actual fixture before browser setup', async () => {
    const registration = { phase: 3, enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] }
    const child = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: { workspaceCwd: '/owned/workspace',
          info: { baseUrl: descriptor.FRESHELL_E2E_TARGET_URL, wsUrl: descriptor.FRESHELL_E2E_TARGET_WS_URL,
            token: descriptor.FRESHELL_E2E_TARGET_TOKEN } } }), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(runner.resolveManagedExternalDescriptor(descriptor)!, child, registration)
    await expect(rig.start()).rejects.toThrow(/registered|registration/)
    child.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: { workspaceCwd: '/owned/workspace',
          info: { baseUrl: descriptor.FRESHELL_E2E_TARGET_URL, wsUrl: descriptor.FRESHELL_E2E_TARGET_WS_URL,
            token: descriptor.FRESHELL_E2E_TARGET_TOKEN }, registration: { ...registration, fixtureFreshAgentModes: ['freshclaude'] } } }), { status: 200 })
    })
    await expect(rig.start()).rejects.toThrow(/registered|registration/)
    child.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: { workspaceCwd: '/owned/workspace',
          info: { baseUrl: descriptor.FRESHELL_E2E_TARGET_URL, wsUrl: descriptor.FRESHELL_E2E_TARGET_WS_URL,
            token: descriptor.FRESHELL_E2E_TARGET_TOKEN }, registration } }), { status: 200 })
    })
    await expect(rig.start()).resolves.toMatchObject({ baseUrl: descriptor.FRESHELL_E2E_TARGET_URL })
    expect(rig.repoRoot).toBe('/owned/workspace')
  })
})

describe('closed Cloud metadata handoff', () => {
  it('hands off exact public selection and endpoints while keeping owner files/socket/receipts private', () => {
    const selection = { ...descriptor, FRESHELL_E2E_BACKEND: 'cloud',
      FRESHELL_RUNTIME_EXTERNAL_SPEC: 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts',
      FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST: '1',
      DOCKER_HOST: 'unix:///private/owned/docker.sock',
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: '/private/grant.env',
      FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT: '/private/receipt.json',
    }
    const handoff = runner.externalCloudMetadata(selection)
    expect(handoff).toMatchObject(descriptor)
    expect(handoff.FRESHELL_RUNTIME_EXTERNAL_SPEC).toBe(selection.FRESHELL_RUNTIME_EXTERNAL_SPEC)
    expect(handoff.FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST).toBe('1')
    expect(handoff).not.toHaveProperty('DOCKER_HOST')
    expect(handoff).not.toHaveProperty('FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE')
    expect(handoff).not.toHaveProperty('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT')
  })
  it('refuses partial descriptors and missing fixture opt-in before handing metadata to Cloud', () => {
    expect(() => runner.externalCloudMetadata({ FRESHELL_E2E_TARGET_URL: descriptor.FRESHELL_E2E_TARGET_URL })).toThrow(/complete/)
    expect(() => runner.externalCloudMetadata({ ...descriptor,
      FRESHELL_RUNTIME_EXTERNAL_SPEC: 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts' })).toThrow(/opt|requires/)
    expect(runner.externalCloudMetadata({ DOCKER_HOST: 'unix:///private/docker.sock' })).toEqual({})
  })
})

describe('actual Cloud launcher browser image binding', () => {
  const imageManifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: {}, layers: [] }
  const fixtureDigest = `sha256:${createHash('sha256').update(JSON.stringify(imageManifest)).digest('hex')}`
  async function launch(external: boolean, digest: string, observedImage?: string, executionImage?: string, registryDocuments?: Record<string, unknown>) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-cloud-image-'))
    try {
      const scripts = path.join(directory, 'scripts')
      const bin = path.join(directory, 'bin')
      const calls = path.join(directory, 'calls.jsonl')
      await fsp.mkdir(path.join(scripts, 'lib'), { recursive: true })
      await fsp.mkdir(bin)
      await fsp.copyFile('scripts/e2e-cloud.sh', path.join(scripts, 'e2e-cloud.sh'))
      await fsp.copyFile('scripts/lib/gcp-identity.sh', path.join(scripts, 'lib/gcp-identity.sh'))
      const command = `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const name=path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({name,args})+'\\n');
if(name==='git'){if(args.includes('status'))process.exit(0);console.log(args.includes('--short=12')?'aaaaaaaaaaaa':'${'a'.repeat(40)}');process.exit(0)}
if(name==='pnpm'){if(args.some(x=>x.includes('externalCloudMetadata'))&&process.env.TEST_EXTERNAL==='1')console.log('FRESHELL_RUNTIME_EXTERNAL_RUN_ID: "${descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID}"');process.exit(0)}
if(args[0]==='info')process.exit(0);
if(args[0]==='auth'){console.log('fixture-token');process.exit(0)}
if(args[0]==='artifacts'){console.log(process.env.TEST_DIGEST);process.exit(0)}
if(args.includes('create')){const image=args.find(x=>x.startsWith('--image=')).slice(8);fs.writeFileSync(process.env.TEST_CALLS+'.image',image);process.exit(0)}
if(args.includes('describe')){const job=args.find(x=>x.startsWith('freshell-e2e-'));const observed=args.includes('executions')?process.env.TEST_EXECUTION_IMAGE:process.env.TEST_OBSERVED_IMAGE;const containers=[{image:observed||fs.readFileSync(process.env.TEST_CALLS+'.image','utf8')}];console.log(JSON.stringify({metadata:{name:job,labels:{'freshell-managed-run':'${descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID}','freshell-managed-candidate':'${'a'.repeat(40)}'}},spec:{template:{spec:args.includes('executions')?{containers}:{template:{spec:{containers}}}}}}));process.exit(0)}
if(args.includes('execute')){const job=args.find(x=>x.startsWith('freshell-e2e-'));console.log('Execution ['+job+'-fixture] has failed.');process.exit(73)}
process.exit(0);\n`
      for (const name of ['git', 'gcloud', 'pnpm']) await fsp.writeFile(path.join(bin, name), command, { mode: 0o700 })
      const registryFixture = path.join(directory, 'registry-fixture.mjs')
      await fsp.writeFile(registryFixture, `globalThis.fetch = async url => {
        const fs = await import('node:fs');
        fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({name:'registry',args:[String(url)]})+'\\n');
        const documents = JSON.parse(process.env.TEST_REGISTRY_DOCUMENTS || '{}');
        const digest = String(url).split('/').at(-1);
        const document = documents[digest];
        if (!document) throw new Error('unregistered manifest request');
        return new Response(JSON.stringify(document), { headers: { 'Docker-Content-Digest': digest } });
      };`)
      await fsp.writeFile(path.join(bin, 'node'), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const child=cp.spawnSync(process.execPath,['--import',${JSON.stringify(registryFixture)},...process.argv.slice(2)],{input:fs.readFileSync(0),encoding:'utf8',env:process.env});process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exit(child.status??1);\n`, { mode: 0o700 })
      const child = spawnSync('bash', [path.join(scripts, 'e2e-cloud.sh'), 'run', '--cloud'], {
        env: { ...process.env, ...descriptor, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          FRESHELL_GCP_ACCOUNT: 'owned-fixture@example.test', TEST_CALLS: calls,
          TEST_EXTERNAL: external ? '1' : '0', TEST_DIGEST: digest, TEST_OBSERVED_IMAGE: observedImage,
          TEST_EXECUTION_IMAGE: executionImage, TEST_REGISTRY_DOCUMENTS: JSON.stringify(registryDocuments ?? { [digest]: imageManifest }) },
        encoding: 'utf8', timeout: 20_000,
      })
      const operations = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { name: string; args: string[] })
      const events = child.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } })
      return { child, operations, events }
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  }

  it('pins the uniquely verified Linux amd64 manifest from the candidate index before create', async () => {
    const childManifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: {}, layers: [] }
    const childDigest = `sha256:${createHash('sha256').update(JSON.stringify(childManifest)).digest('hex')}`
    const index = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
      { digest: childDigest, mediaType: childManifest.mediaType, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: `sha256:${'c'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
    ] }
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(index)).digest('hex')}`
    const result = await launch(true, digest, undefined, undefined, { [digest]: index, [childDigest]: childManifest })
    const image = `us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e@${childDigest}`
    expect(result.operations.find(row => row.args.includes('create'))?.args).toContain(`--image=${image}`)
    expect(result.events.find(row => row.event === 'managed_external_job_execution')).toMatchObject({ image, imageDigest: childDigest })
    expect(result.events.find(row => row.event === 'managed_external_image_resolved')).toMatchObject({ sourceImageDigest: digest, imageDigest: childDigest })
    expect(result.operations.filter(row => row.name === 'registry').map(row => row.args[0])).toEqual([
      `https://us-west1-docker.pkg.dev/v2/misc-puttering-project/freshell-e2e/freshell-e2e/manifests/${digest}`,
      `https://us-west1-docker.pkg.dev/v2/misc-puttering-project/freshell-e2e/freshell-e2e/manifests/${childDigest}`,
    ])
  })

  it.each(['missing-platform', 'ambiguous-platform', 'changed-child', 'unsupported-child', 'changed-source'])(
    'refuses an unverifiable candidate manifest %s before creating or executing a job', async (failure) => {
      const child = failure === 'unsupported-child' ? { ...imageManifest, mediaType: 'unsupported' } : imageManifest
      const childDigest = `sha256:${createHash('sha256').update(JSON.stringify(child)).digest('hex')}`
      const selected = { digest: childDigest, mediaType: imageManifest.mediaType, platform: { os: 'linux', architecture: 'amd64' } }
      const index = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests:
        failure === 'missing-platform' ? [] : failure === 'ambiguous-platform' ? [selected, selected] : [selected] }
      const digest = `sha256:${createHash('sha256').update(JSON.stringify(index)).digest('hex')}`
      const result = await launch(true, digest, undefined, undefined, {
        [digest]: failure === 'changed-source' ? { ...index, schemaVersion: 1 } : index,
        [childDigest]: failure === 'changed-child' ? { ...child, layers: ['changed'] } : child,
      })
      expect(result.child.status).toBe(1)
      expect(result.operations.some(row => row.args.includes('create') || row.args.includes('execute'))).toBe(false)
      expect(result.events.some(row => row.event === 'managed_external_image_resolved')).toBe(false)
      expect(result.child.stdout + result.child.stderr).not.toContain('fixture-token')
    })

  it('pins the resolved digest before create and records the actual owned job image before execution', async () => {
    const digest = fixtureDigest
    const image = `us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e@${digest}`
    const result = await launch(true, digest)
    const create = result.operations.find(row => row.name === 'gcloud' && row.args.includes('create'))
    expect(create?.args).toContain(`--image=${image}`)
    expect(result.events.find(row => row.event === 'managed_external_job_created')).toMatchObject({ image, imageDigest: digest })
    expect(result.events.find(row => row.event === 'managed_external_job_execution')).toMatchObject({ image, imageDigest: digest })
    expect(result.operations.some(row => row.args.includes('execute'))).toBe(true)
    expect(result.child.status).toBe(1)
  })

  it.each(['', 'latest', `sha256:${'b'.repeat(63)}`])('refuses unavailable or malformed digest %j before job creation', async (digest) => {
    const result = await launch(true, digest)
    expect(result.child.status).toBe(1)
    expect(result.operations.some(row => row.args.includes('create'))).toBe(false)
    expect(result.operations.some(row => row.args.includes('execute'))).toBe(false)
  })

  it('refuses a changed job image before execution and still runs owned cleanup', async () => {
    const result = await launch(true, fixtureDigest, 'foreign.example/image:latest')
    expect(result.child.status).toBe(1)
    expect(result.operations.some(row => row.args.includes('execute'))).toBe(false)
    expect(result.events.some(row => row.event === 'managed_external_job_created')).toBe(false)
    expect(result.events.find(row => row.event === 'managed_external_job_cleanup')).toMatchObject({ ok: true })
  })

  it('refuses a changed execution image without certifying that execution', async () => {
    const result = await launch(true, fixtureDigest, undefined, 'foreign.example/image:latest')
    expect(result.child.status).toBe(1)
    expect(result.operations.some(row => row.args.includes('execute'))).toBe(true)
    expect(result.events.some(row => row.event === 'managed_external_job_execution')).toBe(false)
    expect(result.events.find(row => row.event === 'managed_external_execution_image_refused')).toMatchObject({
      observedContainerCount: 1, observedImages: ['foreign.example/image:latest'],
      expectedImage: `us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e@${fixtureDigest}`,
    })
    expect(result.events.find(row => row.event === 'managed_external_job_cleanup')).toMatchObject({ ok: true })
  })

  it('preserves ordinary Cloud tag selection without external image observations', async () => {
    const result = await launch(false, fixtureDigest)
    const create = result.operations.find(row => row.name === 'gcloud' && row.args.includes('create'))
    expect(create?.args).toContain('--image=us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:aaaaaaaaaaaa')
    expect(result.operations.some(row => row.args.includes('--format=value(image_summary.digest)'))).toBe(false)
    expect(result.operations.some(row => row.args.includes('describe') && row.args.includes('jobs'))).toBe(false)
    expect(result.events).toEqual([])
    expect(result.operations.some(row => row.name === 'registry')).toBe(false)
    expect(result.child.status).toBe(1)
  })
  it('omits a malformed image value from refusal diagnostics and still cleans its owned job', async () => {
    const result = await launch(true, fixtureDigest, undefined, 'credential-must-not-leak')
    expect(result.child.status).toBe(1)
    expect(result.events.find(row => row.event === 'managed_external_execution_image_refused')).toMatchObject({
      observedContainerCount: 1, observedImages: [null],
    })
    expect(result.child.stdout).not.toContain('credential-must-not-leak')
    expect(result.events.some(row => row.event === 'managed_external_job_execution')).toBe(false)
    expect(result.events.find(row => row.event === 'managed_external_job_cleanup')).toMatchObject({ ok: true })
  })
})

describe('exact Cloud job cleanup authority', () => {
  const context = { jobName: 'freshell-e2e-owned-case', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
    candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA }
  const observed = { metadata: { name: context.jobName, labels: { 'freshell-managed-run': context.runId,
    'freshell-managed-candidate': context.candidateSha } } }
  it('admits only the exact labelled resource created for this run and candidate', () => {
    expect(() => runner.assertExternalCloudJobOwned(observed, context)).not.toThrow()
  })
  it.each([
    {}, { metadata: { ...observed.metadata, name: 'foreign-job' } },
    { metadata: { ...observed.metadata, labels: { ...observed.metadata.labels, 'freshell-managed-run': 'foreign-run' } } },
    { metadata: { ...observed.metadata, labels: { ...observed.metadata.labels, 'freshell-managed-candidate': 'b'.repeat(40) } } },
  ])('refuses deletion authority for missing or foreign observations %j', (resource) => {
    expect(() => runner.assertExternalCloudJobOwned(resource, context)).toThrow(/owned|identity/)
  })
  it('verifies absence from complete actual inventory without affecting unrelated jobs', () => {
    expect(() => runner.assertExternalCloudJobAbsent([{ metadata: { name: 'unrelated-job' } }], context.jobName)).not.toThrow()
    expect(() => runner.assertExternalCloudJobAbsent([observed], context.jobName)).toThrow(/remains/)
    expect(() => runner.assertExternalCloudJobAbsent([{ unknown: 'incomplete' }], context.jobName)).toThrow(/inventory/)
  })
  it('cancels only the owned unfinished executions after child loss, deletes the exact job and verifies absence', () => {
    const cloud = { ...context, project: 'misc-puttering-project', region: 'us-west1', account: 'gcloud-robot@example.invalid' }
    let removed = false
    const execute = vi.fn<typeof execFileSync>().mockImplementation((_command, args) => {
      if (args?.[3] === 'describe') return JSON.stringify(observed)
      if (args?.[3] === 'list') return JSON.stringify(removed ? [{ metadata: { name: 'unrelated-job' } }] : [observed])
      if (args?.[3] === 'executions' && args[4] === 'list') return JSON.stringify([
        { metadata: { name: `${context.jobName}-active`, labels: { 'run.googleapis.com/job': context.jobName } }, status: {} },
        { metadata: { name: `${context.jobName}-done`, labels: { 'run.googleapis.com/job': context.jobName } }, status: { completionTime: '2026-10-07T01:00:00Z' } },
      ])
      if (args?.[3] === 'executions' && args[4] === 'cancel') return ''
      if (args?.[3] === 'delete') { removed = true; return '' }
      throw new Error('unexpected Cloud cleanup operation')
    })
    expect(() => runner.cleanupOwnedExternalCloudJob(cloud, execute)).not.toThrow()
    expect(execute.mock.calls.some(call => call[1]?.includes(`${context.jobName}-active`) && call[1]?.includes('cancel'))).toBe(true)
    expect(execute.mock.calls.some(call => call[1]?.includes(`${context.jobName}-done`) && call[1]?.includes('cancel'))).toBe(false)
    expect(execute.mock.calls.some(call => call[1]?.includes('unrelated-job') && call[1]?.includes('delete'))).toBe(false)
    const foreign = vi.fn<typeof execFileSync>().mockImplementation((_command, args) =>
      JSON.stringify(args?.[3] === 'list' ? [observed] : { metadata: { ...observed.metadata, labels: {} } }))
    expect(() => runner.cleanupOwnedExternalCloudJob(cloud, foreign)).toThrow(/owned/)
    expect(foreign.mock.calls.some(call => call[1]?.includes('delete') || call[1]?.includes('cancel'))).toBe(false)
  })
  it('retains actual failed execution case observations after the launcher has exited without result events', () => {
    const cloud = { ...context, project: 'owned-project', region: 'us-west1', account: 'owned-robot@example.invalid' }
    const executionName = `${context.jobName}-failed`
    const events = [
      { event: 'managed_external_case', runId: context.runId, candidateSha: context.candidateSha,
        id: 'failed-owned-case', file: smokeSpec, title: 'actual managed external topology and finite owner facts', status: 'failed' },
      { event: 'managed_external_complete', runId: context.runId, candidateSha: context.candidateSha, cases: 1, status: 'failed' },
    ]
    const entries = events.map(jsonPayload => ({ resource: { type: 'cloud_run_job', labels: { job_name: context.jobName, location: cloud.region } },
      labels: { 'run.googleapis.com/execution_name': executionName }, jsonPayload }))
    const execute = vi.fn<typeof execFileSync>().mockReturnValue(JSON.stringify(entries))
    const raw = runner.readOwnedExternalCloudCases(cloud, execute)
    expect(raw).toEqual({ executionName, status: 'failed', cases: [{ id: 'failed-owned-case', file: smokeSpec,
      title: 'actual managed external topology and finite owner facts', status: 'failed' }] })
    expect(() => runner.parseExternalCloudExecutionEvents(events, context)).toThrow(/failed/)
    const recovered = vi.fn().mockReturnValue(raw)
    expect(runner.settleExternalCloudChildOutput(1, [], [cloud], recovered)).toEqual({ exitCode: 1, cases: raw.cases })
    expect(recovered).toHaveBeenCalledExactlyOnceWith(cloud)
    expect(() => runner.settleExternalCloudChildOutput(0, [], [cloud], recovered)).toThrow(/missing/)
    expect(recovered).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0]).toBe('gcloud')
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining(['logging', 'read', '--project=owned-project', '--account=owned-robot@example.invalid']))
    execute.mockReturnValue(JSON.stringify(entries.map(row => ({ ...row, resource: { ...row.resource,
      labels: { ...row.resource.labels, job_name: 'foreign-job' } } }))))
    expect(() => runner.readOwnedExternalCloudCases(cloud, execute)).toThrow(/owned|job/)
    execute.mockReturnValue(JSON.stringify(entries.map((row, index) => index === 0 ? row : { ...row,
      labels: { 'run.googleapis.com/execution_name': `${context.jobName}-other` } })))
    expect(() => runner.readOwnedExternalCloudCases(cloud, execute)).toThrow(/execution/)
    execute.mockReturnValue(JSON.stringify(entries.slice(0, 1)))
    expect(() => runner.readOwnedExternalCloudCases(cloud, execute)).toThrow(/missing|incomplete/)
  })
})
