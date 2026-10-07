import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, type execFileSync } from 'node:child_process'

const execute = vi.fn()

import { runSelectedProviderQualification } from '../../../../scripts/testing/runtime-provider-qualification.js'
import { runSelectedFreshAgentQualification } from '../../../../scripts/testing/runtime-fresh-agent-qualification.js'

import { playwright, campaignGate } from '../../../../scripts/testing/runtime-landing-campaign.js'
import * as runner from '../../../../scripts/testing/runtime-external-browser.js'
import { ManagedRuntimeOwner, RuntimeHarness, type SupervisorInstance, type Phase3BrowserObservation } from '../../../../scripts/testing/runtime-sandbox.js'
import { runTask2RetainedFixture, RetainedFixtureBrowserSession } from '../../../../scripts/testing/task002-retained-fixture.js'

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
      expect(record).toMatchObject({ pid: info.pid, logReadState: 'read',
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
  it('stops only the exact owned incarnation with its observed intent and controller revisions', async () => {
    const { owned, context, request, inventory } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'stop-owned-soul',
      incarnationId: 'stop-owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'stop-owned-boot', nativeSessionId: 'stop-owned-native' }
    const view = { soulId: handle.soulId, incarnationId: handle.incarnationId, containerId: handle.containerId,
      hostBootId: handle.hostBootId, nativeSessionId: handle.nativeSessionId,
      launchState: 'running', intentRevision: 7, provider: 'opencode', cleanupState: 'none',
      executionGeneration: 1, desiredState: 'running', recoveryState: 'live', durabilityState: 'resume_captured',
      allocationState: 'verified_durable', evidenceRevision: 1, successfulRecoveriesInWindow: 0 }
    inventory.mockResolvedValue([view])
    owned.runtime.broker = { receipts: () => [{ ...handle }] } as unknown as typeof owned.runtime.broker
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const stopped = { outcome: 'verified_empty', view: { ...view, launchState: 'stopped', desiredState: 'stopped',
      recoveryState: 'stopped', cleanupState: 'verified_empty', intentRevision: 8 } }
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'stop', data: stopped })
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.stopRuntimeSoul(handle, 4, 7)).resolves.toMatchObject({ outcome: 'verified_empty',
      view: { soulId: handle.soulId, intentRevision: 8, desiredState: 'stopped' } })
    expect(admin).toHaveBeenCalledExactlyOnceWith(owned.supervisor, owned.runtime.stopBody(handle.soulId, 4, 7))
    await expect(control({ ...request, action: 'stop-soul', handle })).rejects.toThrow(/revision|epoch/)
    await expect(control({ ...request, operationId: 'stale-intent', action: 'stop-soul', handle,
      expectedControlEpoch: 4, expectedIntentRevision: 6 })).rejects.toThrow(/revision/)
    await expect(control({ ...request, operationId: 'stale-epoch', action: 'stop-soul', handle,
      expectedControlEpoch: 3, expectedIntentRevision: 7 })).rejects.toThrow(/epoch/)
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
