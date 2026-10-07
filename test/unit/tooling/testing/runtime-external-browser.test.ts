import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { ManagedRuntimeOwner } from '../../../../scripts/testing/runtime-sandbox.js'

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
  it('routes exact inventory observations and binds the reply to run, candidate and operation', async () => {
    const { owned, context, inventory, request } = fixture()
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control(request)).resolves.toEqual({ runId: context.runId, candidateSha: context.candidateSha,
      operationId: request.operationId, result: [] })
    expect(inventory).toHaveBeenCalledOnce()
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
})
