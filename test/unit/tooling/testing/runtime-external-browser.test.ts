import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../../../shared/ws-protocol.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')

const execute = vi.fn()
const registeredManagedBrowserCases = vi.hoisted(() => new Map<string, Function>())
vi.mock('../../../e2e-browser/helpers/fixtures.js', () => ({
  test: Object.assign((title: string, callback: Function) => registeredManagedBrowserCases.set(title, callback), {
    describe: Object.assign((_title: string, callback: () => void) => callback(), { serial: (_title: string, callback: () => void) => callback() }),
    skip: vi.fn(), setTimeout: vi.fn(),
  }),
  createFreshE2ePage: vi.fn(),
}))

import { runSelectedProviderQualification } from '../../../../scripts/testing/runtime-provider-qualification.js'
import { runSelectedFreshAgentQualification } from '../../../../scripts/testing/runtime-fresh-agent-qualification.js'
import { withOwnedCleanup } from '../../../../scripts/testing/owned-cleanup.js'
import { projectManagedViewProbe } from '../../../../scripts/testing/managed-view-probe.js'
import { NativeRecoveryValidationError } from '../../../../scripts/testing/qualification-observations.js'
import { captureTerminalOrdinaryTurnBaseline, reduceTerminalOrdinaryTurnFrames } from '../../../../scripts/testing/terminal-ordinary-turn.js'

import { playwright, campaignGate } from '../../../../scripts/testing/runtime-landing-campaign.js'
import * as runner from '../../../../scripts/testing/runtime-external-browser.js'
import { ManagedRuntimeOwner, RuntimeHarness, assertExactRuntimeHandle, stripRuntimeWebEnvironment, type ManagedRuntimeView, type SupervisorInstance, type Phase3BrowserObservation, type RuntimeLossAssertions, type RuntimeWebConstructOptions } from '../../../../scripts/testing/runtime-sandbox.js'
import { runTask2RetainedFixture, RetainedFixtureBrowserSession } from '../../../../scripts/testing/task002-retained-fixture.js'
import * as retainedDriver from '../../../../scripts/testing/task002-retained-fixture.js'
import { stopManagedRuntimeSoul, createManagedOpenCodeRuntimeBrowserRig } from '../../../e2e-browser/helpers/managed-runtime.js'
import { structuredChaosLog, bindInterruptedOrdinaryStopFailedAck, reportInterruptedOrdinaryStopAckFailure } from '../../../e2e-browser/helpers/runtime-chaos-evidence.js'
import { RustServer, ensureRustServerBuilt } from '../../../e2e-browser/helpers/rust-server.js'
import type { BrokerReceipt } from '../../../../scripts/testing/runtime-test-broker.js'
import type { ProviderQualificationRow } from '../../../../scripts/testing/provider-qualification-receipt.js'
import type { FreshAgentQualificationRow } from '../../../../scripts/testing/fresh-agent-qualification-receipt.js'
import type { ManagedTerminalStartupFacts } from '../../../../scripts/testing/runtime-sandbox.js'
import * as managedBrowser from '../../../e2e-browser/helpers/managed-runtime.js'
import { TestHarness } from '../../../e2e-browser/helpers/test-harness.js'
import { FRESH_AGENT_INGRESS_INVENTORY } from '../../../../scripts/testing/fresh-agent-ingress-inventory.js'

const sourceRoot = process.cwd()
let fixtureRepoRoot: string

function fixtureGit(directory: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: directory, encoding: 'utf8', timeout: 10_000 })
}

function initializeFixtureCheckout(directory: string, message: string): void {
  fixtureGit(directory, 'init', '--quiet')
  fixtureGit(directory, 'add', '.')
  fixtureGit(directory, 'commit', '--quiet', '--allow-empty', '-m', message)
}

beforeEach(async () => {
  execute.mockReset()
  // Cloud images have source files but no .git. Keep real candidate evidence
  // and every runtime artifact in this test's owned checkout.
  fixtureRepoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-external-browser-repo-'))
  const sources = new Set([
    'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql',
    'docs/development/runtime-provider-capabilities.json',
    ...FRESH_AGENT_INGRESS_INVENTORY.flatMap(row => [row.entry.source, row.durableGateway.source, row.sharedSupervisorOperation.source]),
  ])
  for (const relative of sources) {
    const target = path.join(fixtureRepoRoot, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(path.join(sourceRoot, relative), target)
  }
  initializeFixtureCheckout(fixtureRepoRoot, 'Owned external browser unit fixture')
})

afterEach(async () => {
  if (fixtureRepoRoot) await fsp.rm(fixtureRepoRoot, { recursive: true, force: true })
})

describe('owned tunnel executable selection', () => {
  it('finds the executable on PATH without depending on another checkout', async () => {
    const binaryDirectory = path.join(fixtureRepoRoot, 'bin')
    const missingDirectory = path.join(fixtureRepoRoot, 'missing')
    await fsp.mkdir(binaryDirectory)
    const binary = path.join(binaryDirectory, 'cloudflared')
    await fsp.writeFile(binary, '#!/bin/sh\nprintf selected-tunnel-executable\n', { mode: 0o700 })
    const selected = runner.resolveOwnedTunnelBinary(undefined, [missingDirectory, binaryDirectory].join(path.delimiter))
    expect(execFileSync(selected, [], { encoding: 'utf8' })).toBe('selected-tunnel-executable')
  })

  it('uses the explicitly selected executable before PATH', async () => {
    const selected = path.join(fixtureRepoRoot, 'selected-cloudflared')
    await fsp.writeFile(selected, '#!/bin/sh\nprintf explicitly-selected-tunnel\n', { mode: 0o700 })
    const resolved = runner.resolveOwnedTunnelBinary(selected, path.join(fixtureRepoRoot, 'missing'))
    expect(execFileSync(resolved, [], { encoding: 'utf8' })).toBe('explicitly-selected-tunnel')
  })

  it('reports the required setting when no executable is available', () => {
    expect(() => runner.resolveOwnedTunnelBinary(undefined, path.join(fixtureRepoRoot, 'missing')))
      .toThrow('FRESHELL_RUNTIME_CLOUDFLARED_BINARY')
  })
})

describe('ordinary smoke failure cleanup', () => {
  it('awaits owned cleanup before returning the operation result', async () => {
    const resource = { released: false }
    const operation = vi.fn().mockResolvedValue(resource)
    const cleanup = vi.fn(async () => { resource.released = true })
    await expect(withOwnedCleanup(operation, cleanup)).resolves.toBe(resource)
    expect(resource.released).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps cleanup failure fatal when the operation succeeds', async () => {
    const failure = new Error('owned cleanup failed after a successful turn')
    const cleanup = vi.fn().mockRejectedValue(failure)
    await expect(withOwnedCleanup(async () => 'completed turn', cleanup)).rejects.toBe(failure)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('preserves the exact operation error when cleanup succeeds', async () => {
    const failure = new Error('provider turn failed', { cause: new Error('provider unavailable') })
    const cleanup = vi.fn().mockResolvedValue(undefined)
    await expect(withOwnedCleanup(async () => { throw failure }, cleanup)).rejects.toBe(failure)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  for (const lane of ['terminal', 'fresh-agent'] as const) {
    for (const cleanupKind of ['rejection', 'failed settlement'] as const) {
      it(`${lane} retains the original startup error when cleanup returns ${cleanupKind}`, async () => {
        await import('../../../e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.js')
        await import('../../../e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.js')
        const title = lane === 'terminal'
          ? 'each selected terminal provider completes one ordinary turn'
          : 'each selected fresh-agent mode completes one ordinary turn'
        const callback = registeredManagedBrowserCases.get(title)
        if (!callback) throw new Error('actual ordinary smoke callback was not registered')
        vi.stubEnv('FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS', 'codex')
        vi.stubEnv('FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES', 'freshcodex')
        const rootCause = new Error('provider connection was refused')
        const primary = new Error('provider startup failed', { cause: rootCause })
        const primaryStack = primary.stack
        const cleanupFailure = new Error('owned enclosure cleanup failed')
        const start = vi.fn().mockRejectedValue(primary)
        const stop = cleanupKind === 'rejection'
          ? vi.fn().mockRejectedValue(cleanupFailure)
          : vi.fn().mockResolvedValue({ ok: false, errors: [cleanupFailure.message] })
        const factory = vi.spyOn(managedBrowser, 'createManagedRuntimeBrowserRig').mockReturnValue({ start, stop } as any)
        const page = { exposeBinding: vi.fn(), addInitScript: vi.fn() }
        try {
          const failure = await Reflect.apply(callback, undefined, [{ page }]).catch((error: unknown) => error)
          expect(start).toHaveBeenCalledOnce()
          expect(stop).toHaveBeenCalledOnce()
          expect(failure).toBeInstanceOf(AggregateError)
          expect(failure.cause).toBe(primary)
          expect(failure.cause.cause).toBe(rootCause)
          expect(failure.cause.stack).toBe(primaryStack)
          expect(failure.errors[0]).toBe(primary)
          expect(failure.message).toContain(cleanupFailure.message)
          if (cleanupKind === 'rejection') expect(failure.errors[1]).toBe(cleanupFailure)
        } finally {
          factory.mockRestore()
          vi.unstubAllEnvs()
        }
      })
    }
  }
})

describe('managed browser producers', () => {
  it('stages the selected browser profile before releasing real create effects', () => {
    let suppressed = true
    const content = { kind: 'fresh-agent', sessionType: 'freshclaude', createRequestId: 'real-picker-request', model: 'opus' }
    const state = { tabs: { activeTabId: 'tab' }, panes: { activePane: { tab: 'pane' }, layouts: { tab: { type: 'leaf', id: 'pane', content } } } }
    const dispatched: any[] = []
    vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => state, isAllFreshAgentNetworkEffectsSuppressed: () => suppressed,
      setSuppressAllFreshAgentNetworkEffects: (value: boolean) => { suppressed = value }, dispatch: (action: any) => { expect(suppressed).toBe(false); dispatched.push(action) } } })
    try {
      expect((runner as any).stageOwnedFreshBrowserProfile({ mode: 'freshclaude', model: 'haiku', effort: 'low' })).toEqual({ tabId: 'tab', paneId: 'pane', createRequestId: 'real-picker-request' })
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].payload.content).toMatchObject({ createRequestId: 'real-picker-request', model: 'haiku', effort: 'low', permissionMode: 'default' })
      expect(() => (runner as any).stageOwnedFreshBrowserProfile({ mode: 'freshclaude', model: 'haiku', effort: 'low' })).toThrow(/suppressed/)
    } finally { vi.unstubAllGlobals() }
  })
  it('retains existing sanitized saved-history audit after an early failure without a CPU session', async () => {
    await import('../../../e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.js')
    const callback = registeredManagedBrowserCases.get('managed fresh-agent: already-live attach restores stale loss through real hosted HTTP truth')
    if (!callback) throw new Error('actual saved-history callback was not registered')
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused diagnostic web') }, fixtureRepoRoot, 3, {}, {}, 'test',
      { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const row = { soulId: 'diagnostic-soul', incarnationId: 'diagnostic-incarnation', hostBootId: 'diagnostic-boot',
      containerId: 'b'.repeat(64), nativeSessionId: 'diagnostic-root', freshAgentSessionType: 'freshcodex', provider: 'codex',
      launchState: 'running', intentRevision: 1 }
    const factory = vi.spyOn(managedBrowser, 'createManagedRuntimeBrowserRig').mockReturnValue(owned)
    vi.spyOn(owned, 'start').mockResolvedValue({ baseUrl: 'http://127.0.0.1:3399', wsUrl: 'ws://127.0.0.1:3399/ws',
      token: 'owned-fixture-token', port: 3399, pid: 42, homeDir: '/owned-diagnostic', configDir: '/owned-diagnostic',
      logsDir: '/owned-diagnostic/logs', debugLogPath: '/owned-diagnostic/logs/server.log', runtimeRoot: process.cwd() })
    vi.spyOn(owned, 'inventory').mockResolvedValue([row])
    vi.spyOn(owned, 'prepareFreshCodexSavedHistory').mockResolvedValue({ bytes: 2 * 1024 * 1024 })
    vi.spyOn(owned, 'fixtureNativeState').mockRejectedValue(new Error('early owned fixture boundary failed'))
    const publish = vi.spyOn(owned, 'publishFreshCodexSavedHistoryMeasurement').mockResolvedValue({ artifactRef: 'private-diagnostic' })
    const finish = vi.spyOn(owned, 'finishFreshCodexSavedHistoryMeasurement').mockResolvedValue(undefined)
    const stop = vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    const ready = vi.spyOn(TestHarness.prototype, 'waitForHarness').mockResolvedValue(undefined)
    const connected = vi.spyOn(TestHarness.prototype, 'waitForConnection').mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: {
      getState: () => ({ tabs: { activeTabId: 'tab-owned' }, panes: { layouts: { 'tab-owned': {
        id: 'pane-owned', type: 'leaf', content: { kind: 'fresh-agent', sessionId: 'session-owned' },
      } } } }),
      getPerfAuditSnapshot: () => ({ perfEvents: [{ event: 'fresh_agent.snapshot_request', stage: 'display_committed',
        accepted: false, live: true, requestSerial: 2, revision: 3, privateBody: 'omit owned transcript' }] }),
    } })
    const page = { routeWebSocket: async () => undefined, goto: async () => undefined,
      unrouteAll: vi.fn(async () => undefined),
      getByRole: () => ({ click: async () => undefined }),
      evaluate: async (fn: Function, argument: unknown) => Reflect.apply(fn, undefined, [argument]) }
    try {
      await expect(Reflect.apply(callback, undefined, [{ page }])).rejects.toThrow(/early owned fixture boundary failed/)
      expect(page.unrouteAll).toHaveBeenCalledExactlyOnceWith({ behavior: 'wait' })
      expect(publish).toHaveBeenCalledOnce()
      expect(publish.mock.calls[0][1]).toMatchObject({ audit: { requestRecordCount: 1, requestRecords: [
        { sequence: 0, stage: 'display_committed', accepted: false, live: true, requestSerial: 2, revision: 3 },
      ] } })
      expect(JSON.stringify(publish.mock.calls)).not.toContain('omit owned transcript')
      expect(finish).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledOnce()
    } finally { factory.mockRestore(); ready.mockRestore(); connected.mockRestore(); vi.unstubAllGlobals() }
  })
  it('keeps the actual selected Amplifier local guard and delegates only an admitted external case to its owner', async () => {
    await import('../../../e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.js')
    const callback = registeredManagedBrowserCases.get('each explicitly selected provider produces an independent evidence-bound live row')
    if (!callback) throw new Error('actual selected provider callback was not registered')
    for (const key of [...runner.EXTERNAL_DESCRIPTOR_KEYS,
      'FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE', 'FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE', 'FRESHELL_MANAGED_AMPLIFIER_ONECLI_CA_FILE']) vi.stubEnv(key, undefined)
    vi.stubEnv('FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE', '1')
    vi.stubEnv('FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS', 'amplifier')
    const started = vi.spyOn(runner.ExternalManagedRuntimeRig.prototype, 'start').mockRejectedValue(new Error('admitted owner setup intercepted'))
    const stopped = vi.spyOn(runner.ExternalManagedRuntimeRig.prototype, 'stop').mockResolvedValue({ ok: true, errors: [] })
    try {
      await expect(Reflect.apply(callback, undefined, [{}])).rejects.toThrow(/requires.*AMPLIFIER_ONECLI/)
      expect(started).not.toHaveBeenCalled()
      for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
      await expect(Reflect.apply(callback, undefined, [{}])).rejects.toThrow(/admitted owner setup intercepted/)
      expect(started).toHaveBeenCalledOnce()
      expect(stopped).toHaveBeenCalledOnce()
      vi.stubEnv('FRESHELL_E2E_TARGET_WS_URL', undefined)
      await expect(Reflect.apply(callback, undefined, [{}])).rejects.toThrow(/complete owned external descriptor required/)
      expect(started).toHaveBeenCalledOnce()
    } finally { started.mockRestore(); stopped.mockRestore(); vi.unstubAllEnvs() }
  })
  it('refuses selected native Amplifier before owner creation when the unchanged bootstrap is missing or malformed', async () => {
    const web = vi.fn(() => { throw new Error('native web must not start') })
    const selection = { spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts', provider: 'amplifier' as const }
    expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, {}, web)).toThrow(/requires.*AMPLIFIER_ONECLI/)
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-amplifier-locality-'))
    const file = path.join(root, 'amplifier.env')
    await fsp.writeFile(file, 'FIXTURE_REFERENCE=owner-only\n', { mode: 0o644 })
    await fsp.chmod(file, 0o644)
    try {
      expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection,
        { FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE: file }, web)).toThrow(/private/)
      expect(web).not.toHaveBeenCalled()
      await fsp.chmod(file, 0o600)
      await fsp.mkdir(path.join(root, 'bundles'))
      await fsp.writeFile(path.join(root, 'settings.yaml'), 'bundle:\n  active: default\n')
      await fsp.writeFile(path.join(root, 'bundles/default.yaml'), 'providers:\n  - module: provider-vllm\n')
      const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection,
        { FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE: file, FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: root }, web)
      expect(owned.fixtureRegistrationFacts()).toEqual({ phase: 5, enabledProviders: ['amplifier'], freshAgentModes: [], fixtureFreshAgentModes: [] })
      expect(web).not.toHaveBeenCalled()
      const fixture = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
        spec: 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts',
      }, {}, web)
      expect(fixture.fixtureRegistrationFacts().fixtureFreshAgentModes).toEqual(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'])
      const retained = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, {}, web, true)
      expect(retained.fixtureRegistrationFacts().enabledProviders).toEqual(['amplifier'])
      const codex = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, { ...selection, provider: 'codex' }, {}, web)
      expect(codex.fixtureRegistrationFacts().enabledProviders).toEqual(['codex'])
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
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
  it('keeps a combined provider subset limited to its selected bootstrap references', () => {
    const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
      spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
    }, { FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
      FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS: 'claude,codex' }, () => { throw new Error('unused web') })
    expect(owned.fixtureRegistrationFacts().enabledProviders).toEqual(['claude', 'codex'])
    expect((owned.runtime as any).ownerIsolation.bootstrapProviders).toEqual(['claude', 'codex'])
  })
  it('admits combined supported providers through the actual owner factory and stages each selected profile', async () => {
    const config = path.join(fixtureRepoRoot, 'amplifier-profile')
    await fsp.mkdir(path.join(config, 'bundles'), { recursive: true })
    await fsp.writeFile(path.join(config, 'settings.yaml'), 'bundle:\n  active: default\n')
    await fsp.writeFile(path.join(config, 'bundles/default.yaml'), 'providers:\n  - module: provider-vllm\n')
    const grant = path.join(config, 'grant.env')
    await fsp.writeFile(grant, 'FIXTURE_REFERENCE=owner-only\n', { mode: 0o600 })
    const environment = { FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
      FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS: 'claude,codex,opencode,amplifier',
      FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE: grant, FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: config }
    let options!: RuntimeWebConstructOptions
    const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
      spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
    }, environment, input => { options = input; return { start: async () => ({}) } as any })
    expect(owned.fixtureRegistrationFacts()).toEqual({ phase: 5,
      enabledProviders: ['claude', 'codex', 'opencode', 'amplifier'], freshAgentModes: [], fixtureFreshAgentModes: [] })
    expect((owned.runtime as any).ownerIsolation.bootstrapProviders).toEqual(['claude', 'codex', 'opencode', 'amplifier'])
    vi.spyOn(owned.runtime, 'prepare').mockResolvedValue(undefined)
    vi.spyOn(owned as any, 'buildManagedServer').mockReturnValue('/unused/server')
    vi.spyOn(owned as any, 'buildQualificationSupervisor').mockReturnValue(undefined)
    vi.spyOn(owned.runtime, 'recordProviderQualificationBuild').mockReturnValue(undefined)
    vi.spyOn(owned.runtime, 'startSupervisor').mockResolvedValue({ controlSocket: '/unused/socket', controlSecretFile: '/unused/secret' } as SupervisorInstance)
    try {
      await owned.start()
      const home = path.join(fixtureRepoRoot, 'combined-home')
      await options.setupHome!(home)
      const settings = JSON.parse(await fsp.readFile(path.join(home, '.freshell/config.json'), 'utf8')).settings
      expect(settings.codingCli.enabledProviders).toEqual(['claude', 'codex', 'opencode', 'amplifier'])
      expect(settings.codingCli.providers).toMatchObject({ claude: { model: 'haiku', effort: 'low' }, codex: { model: 'gpt-5.6-luna', effort: 'low' } })
      expect(await fsp.readFile(path.join(home, '.claude/.claude.json'), 'utf8')).toContain('hasCompletedOnboarding')
      expect(await fsp.readFile(path.join(home, '.amplifier/settings.yaml'), 'utf8')).toContain('active: default')
      for (const selected of ['gemini', 'claude,claude', '']) expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
        spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, { ...environment, FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS: selected }, () => { throw new Error('unused') })).toThrow()
    } finally { vi.restoreAllMocks() }
  })
  it('admits combined fresh modes and stages each selected provider grant', async () => {
    let options!: RuntimeWebConstructOptions
    const selection = { spec: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts' }
    const environment = { FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '1',
      FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES: 'freshclaude,kilroy,freshcodex,freshopencode' }
    const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, environment,
      input => { options = input; return { start: async () => ({}) } as any })
    expect(owned.fixtureRegistrationFacts()).toEqual({ phase: 5, enabledProviders: [],
      freshAgentModes: ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'], fixtureFreshAgentModes: [] })
    expect((owned.runtime as any).ownerIsolation.bootstrapProviders).toEqual(['claude', 'codex', 'opencode'])
    const selectedReferences = await Promise.all(['CLAUDE', 'CODEX'].map(async family => {
      const file = path.join(fixtureRepoRoot, `${family}.env`)
      await fsp.writeFile(file, 'FIXTURE_REFERENCE=selected\n', { mode: 0o600 })
      vi.stubEnv(`FRESHELL_MANAGED_${family}_ONECLI_ENV_FILE`, file)
      vi.stubEnv(`FRESHELL_MANAGED_${family}_ONECLI_AUTH_FILE`, undefined)
      vi.stubEnv(`FRESHELL_MANAGED_${family}_ONECLI_CA_FILE`, undefined)
      return file
    }))
    const opencodeReferences = await Promise.all(['ENV', 'AUTH', 'CA'].map(async suffix => {
      const file = path.join(fixtureRepoRoot, `OPENCODE.${suffix.toLowerCase()}`)
      await fsp.writeFile(file, 'FIXTURE_REFERENCE=selected\n', { mode: 0o600 })
      vi.stubEnv(`FRESHELL_MANAGED_OPENCODE_ONECLI_${suffix}_FILE`, file)
      return file
    }))
    vi.stubEnv('FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE', '/unselected/unreadable')
    vi.spyOn(owned.runtime, 'prepare').mockResolvedValue(undefined)
    vi.spyOn(owned as any, 'buildManagedServer').mockReturnValue('/unused/server')
    vi.spyOn(owned as any, 'buildQualificationSupervisor').mockReturnValue(undefined)
    vi.spyOn(owned.runtime, 'recordProviderQualificationBuild').mockReturnValue(undefined)
    vi.spyOn(owned.runtime, 'recordFreshAgentQualificationBuild').mockReturnValue(undefined)
    vi.spyOn(owned.runtime, 'startSupervisor').mockResolvedValue({ controlSocket: '/unused/socket', controlSecretFile: '/unused/secret' } as SupervisorInstance)
    try {
      expect((owned.runtime as any).phase2BootstrapFiles()).toEqual([...selectedReferences, ...opencodeReferences])
      await owned.start()
      expect(options.env).toMatchObject({ FRESHELL_MANAGED_RUNTIME_V1: '1', FRESHELL_MANAGED_FRESH_AGENT_V1: '1', KILROY_ENABLED: '1' })
      expect(options.env).not.toHaveProperty('FRESHELL_MANAGED_FRESH_AGENT_FIXTURE_MODES')
      const env = { FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE: '/selected/claude', FRESHELL_MANAGED_CODEX_ONECLI_ENV_FILE: '/selected/codex',
        FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: '/unselected/opencode', FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE: '/unselected/amplifier', OPENCODE_API_KEY: 'paid-sentinel' }
      stripRuntimeWebEnvironment(env, options)
      expect(env).toEqual({ FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE: '/selected/claude', FRESHELL_MANAGED_CODEX_ONECLI_ENV_FILE: '/selected/codex' })
      const home = path.join(fixtureRepoRoot, 'fresh-combined-home')
      await options.setupHome!(home)
      expect(JSON.parse(await fsp.readFile(path.join(home, '.freshell/config.json'), 'utf8')).settings.freshAgent.enabled).toBe(true)
      expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection,
        { ...environment, FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES: 'freshgemini' }, () => { throw new Error('unused') })).toThrow()
      expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection,
        { ...environment, FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '0' }, () => { throw new Error('unused') })).toThrow(/opt.in|LIVE/)
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
  })
  it.each(['freshopencode', 'freshcodex', 'freshclaude', 'kilroy'] as const)('selects only the required production bootstrap for %s', mode => {
    const owner = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts', mode,
    }, {}, () => { throw new Error('web unused') })
    expect((owner.runtime as any).ownerIsolation.bootstrapProviders).toEqual(mode === 'freshopencode' ? ['opencode'] : [mode === 'freshcodex' ? 'codex' : 'claude'])
    expect(owner.fixtureRegistrationFacts().fixtureFreshAgentModes).toEqual([])
  })
  it('preserves all selected FreshOpenCode OneCLI references only for the exact ordinary-turn selection', () => {
    let actual!: RuntimeWebConstructOptions
    const environmentFile = '/unit/opencode-environment-reference.env'
    const authFile = '/unit/opencode-auth-reference.json'
    const caFile = '/unit/opencode-ca-reference.pem'
    const environment = { FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '1',
      FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES: 'freshclaude,freshcodex,freshopencode',
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: caFile }
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
      grep: 'each selected fresh-agent mode completes one ordinary turn$',
    }, environment, options => { actual = options; return {} as any })
    const env = { FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
      OPENAI_API_KEY: 'unit-sentinel', OPENCODE_API_KEY: 'unit-sentinel',
      ANTHROPIC_API_KEY: 'unit-sentinel', GEMINI_API_KEY: 'unit-sentinel',
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: caFile,
      FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION: 'allow',
      FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE: '/unit/unrelated-amplifier-reference',
      HTTP_PROXY: 'http://unit.invalid', HTTPS_PROXY: 'http://unit.invalid', ALL_PROXY: 'http://unit.invalid',
      http_proxy: 'http://unit.invalid', https_proxy: 'http://unit.invalid', all_proxy: 'http://unit.invalid',
      NODE_EXTRA_CA_CERTS: '/unit/unrelated-extra-ca', SSL_CERT_FILE: '/unit/unrelated-ca-file',
      SSL_CERT_DIR: '/unit/unrelated-ca-dir', FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' }
    factory({ repoRoot: fixtureRepoRoot, env, setupHome: async () => {} } as RuntimeWebConstructOptions)
    expect(actual.env).toMatchObject({
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: caFile,
    })
    const observed = { ...env, ...actual.env }
    stripRuntimeWebEnvironment(observed, actual)
    expect(observed).toEqual({
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: caFile,
      FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' })
    expect(actual.providerFreeFixture).not.toBe(true)
  })
  it.each([
    { selection: 'unfiltered FreshOpenCode selection', grep: undefined },
    { selection: 'different FreshAgent case', grep: 'qualifies only explicitly selected modes with production transports$' },
  ])('strips the FreshOpenCode auth-file reference for a $selection', ({ grep }) => {
    let actual!: RuntimeWebConstructOptions
    const authFile = '/unit/unselected-opencode-auth-reference.json'
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts', mode: 'freshopencode',
      ...(grep ? { grep } : {}),
    }, { FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile }, options => { actual = options; return {} as any })
    const env = { FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: authFile, FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' }
    factory({ repoRoot: fixtureRepoRoot, env, setupHome: async () => {} } as RuntimeWebConstructOptions)
    stripRuntimeWebEnvironment(env, actual)
    expect(env).toEqual({ FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' })
  })
  it('strips the OpenCode auth-file reference when FreshOpenCode is not the selected mode', () => {
    let actual!: RuntimeWebConstructOptions
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts', mode: 'freshclaude',
    }, { FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: '/unit/unselected-opencode-auth-reference.json' },
    options => { actual = options; return {} as any })
    const env = { FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: '/unit/unselected-opencode-auth-reference.json',
      FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' }
    factory({ repoRoot: fixtureRepoRoot, env, setupHome: async () => {} } as RuntimeWebConstructOptions)
    stripRuntimeWebEnvironment(env, actual)
    expect(env).toEqual({ FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' })
  })
  describe('actual provider consumers', () => {
    beforeAll(() => {
      ensureRustServerBuilt(sourceRoot)
    }, 10 * 60_000)

    it.each([
      { provider: 'claude' as const, selected: true, retained: false },
      { provider: 'codex' as const, selected: true, retained: false },
      { provider: 'claude' as const, selected: false, retained: false },
      { provider: 'claude' as const, selected: true, retained: true },
      { provider: 'codex' as const, selected: false, retained: false },
      { provider: 'codex' as const, selected: true, retained: true },
      { provider: 'opencode' as const, selected: true, retained: false },
    ])('launches the actual $provider consumer with only its selected external qualification profile ($selected/$retained)', async ({ provider, selected, retained }) => {
      const home = path.join(fixtureRepoRoot, 'launch-home')
      const argvFile = path.join(fixtureRepoRoot, 'launch-argv.json')
      const processesFile = path.join(fixtureRepoRoot, 'launch-processes.jsonl')
      const command = path.join(fixtureRepoRoot, 'profile-provider')
      const serverBinary = ensureRustServerBuilt(sourceRoot)
      await fsp.writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('fixture-only\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(processesFile)}, JSON.stringify({ pid: process.pid })+'\\n', { mode: 0o600 });
if (argv.includes('app-server')) {
  void import(${JSON.stringify(path.join(sourceRoot, 'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs'))});
} else {
  fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ pid: process.pid, argv }), { mode: 0o600 });
  process.stdin.resume();
}
`, { mode: 0o700 })
      let web!: RustServer
      const owner = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
        spec: selected ? 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts'
          : 'test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts', provider,
      }, {}, options => {
        // Keep the actual owner home writer and production settings/WS/argv path.
        // Only runtime builds and Docker allocation below are outside this test.
        web = new RustServer({ homeDir: home, setupHome: options.setupHome, providerFreeFixture: true,
          stripEnvPrefixes: ['FRESHELL_RUNTIME_', 'FRESHELL_MANAGED_', 'NODE_OPTIONS'],
          env: { CLAUDE_CMD: command, CODEX_CMD: command, OPENCODE_CMD: command, FRESHELL_BIND_HOST: '127.0.0.1' } })
        return web as any
      }, retained)
      const prepare = vi.spyOn(owner.runtime, 'prepare').mockResolvedValue(undefined)
      const buildServer = vi.spyOn(owner as any, 'buildManagedServer').mockReturnValue(serverBinary)
      const buildSupervisor = vi.spyOn(owner as any, 'buildQualificationSupervisor').mockReturnValue(undefined)
      const recordBuild = vi.spyOn(owner.runtime, 'recordProviderQualificationBuild').mockReturnValue(undefined)
      const startSupervisor = vi.spyOn(owner.runtime, 'startSupervisor').mockResolvedValue({
        controlSocket: '/unused/profile-control.sock', controlSecretFile: '/unused/profile-secret',
      } as SupervisorInstance)
      let socket: WebSocket | undefined
      let webPid: number | undefined
      try {
        const info = await owner.start()
        webPid = info.pid
        socket = new WebSocket(info.wsUrl)
        const frames: Array<Record<string, any>> = []
        socket.on('message', data => frames.push(JSON.parse(String(data))))
        await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
        socket.send(JSON.stringify({ type: 'hello', token: info.token, protocolVersion: WS_PROTOCOL_VERSION }))
        await vi.waitFor(() => expect(frames.some(frame => frame.type === 'ready')).toBe(true))
        socket.send(JSON.stringify({ type: 'terminal.create', requestId: 'external-profile-launch', mode: provider,
          shell: 'system', cwd: fixtureRepoRoot, tabId: 'profile-tab', paneId: 'profile-pane' }))
        await vi.waitFor(() => {
          const error = frames.find(frame => frame.type === 'error')
          if (error) throw new Error(`owned profile launch failed: ${error.code}`)
          expect(fs.existsSync(argvFile)).toBe(true)
        }, { timeout: 15_000 })
        const launch = JSON.parse(await fsp.readFile(argvFile, 'utf8')) as { pid: number; argv: string[] }
        if (provider === 'claude') {
          expect(launch.argv.includes('--model')).toBe(selected && !retained)
          expect(launch.argv.includes('--effort')).toBe(selected && !retained)
          if (selected && !retained) {
            expect(launch.argv[launch.argv.indexOf('--model') + 1]).toBe('haiku')
            expect(launch.argv[launch.argv.indexOf('--effort') + 1]).toBe('low')
          }
        } else if (provider === 'codex') {
          expect(launch.argv.includes('model_reasoning_effort="low"')).toBe(selected && !retained)
          // Codex's model is loaded into the launch plan separately from TUI argv.
          // This direct-route test does not certify a native managed Codex model.
          const response = await fetch(`${info.baseUrl}/api/settings`, { headers: { 'x-auth-token': info.token } })
          expect(response.ok).toBe(true)
          expect((await response.json()).codingCli.providers.codex?.model ?? null).toBe(selected && !retained ? 'gpt-5.6-luna' : null)
        } else {
          expect(launch.argv[launch.argv.indexOf('--model') + 1]).toBe('openai/gpt-5.6-luna')
          expect(launch.argv.includes('--effort')).toBe(false)
        }
      } finally {
        try {
          socket?.terminate()
          await web?.stop()
          const children = fs.existsSync(processesFile) ? (await fsp.readFile(processesFile, 'utf8')).trim().split('\n')
            .map(line => (JSON.parse(line) as { pid: number }).pid) : []
          for (const pid of new Set([...children, webPid].filter((pid): pid is number => pid !== undefined))) {
            await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
          }
        } finally {
          for (const mock of [prepare, buildServer, buildSupervisor, recordBuild, startSupervisor]) mock.mockRestore()
        }
      }
    }, 30_000)
  })

  it('prepares ordinary terminal Claude onboarding and workspace trust in the selected owned home', async () => {
    const home = path.join(fixtureRepoRoot, 'owned-claude-web-home')
    let captured!: RuntimeWebConstructOptions
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts', provider: 'claude',
    }, {}, value => { captured = value; return {} as any })
    const setup = vi.fn(async (ownedHome: string) => {
      await fsp.mkdir(path.join(ownedHome, '.freshell'), { recursive: true })
      await fsp.writeFile(path.join(ownedHome, '.freshell/config.json'), JSON.stringify({ version: 1 }))
    })
    factory({ binary: process.execPath, repoRoot: fixtureRepoRoot, candidateSha: 'a'.repeat(40),
      buildDirty: false, preserveHomeOnStop: true, env: {}, setupHome: setup })
    await captured.setupHome!(home)
    const preferencesPath = path.join(home, '.claude/.claude.json')
    const preferences = JSON.parse(await fsp.readFile(preferencesPath, 'utf8'))
    expect(preferences.theme).toBe('dark')
    expect(preferences.hasCompletedOnboarding).toBe(true)
    expect(preferences.projects[fixtureRepoRoot].hasTrustDialogAccepted).toBe(true)
    expect(Object.keys(preferences.projects)).toEqual([fixtureRepoRoot])
    expect((await fsp.stat(preferencesPath)).mode & 0o777).toBe(0o600)
    expect(await fsp.readdir(path.join(home, '.claude'))).toEqual(['.claude.json'])
    expect(setup).toHaveBeenCalledExactlyOnceWith(home)
    expect(JSON.parse(await fsp.readFile(path.join(home, '.freshell/config.json'), 'utf8'))).toEqual({ version: 1 })
  })
  it.each([
    { provider: 'codex' as const },
    { mode: 'freshclaude' as const },
    { provider: 'claude' as const, retained: true },
  ])('leaves native preference preparation outside unrelated or retained selections ($provider/$mode/$retained)', async ({ provider, mode, retained }) => {
    const home = path.join(fixtureRepoRoot, 'unselected-web-home')
    let captured!: RuntimeWebConstructOptions
    const setup = vi.fn(async () => undefined)
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      ...(provider ? { provider } : {}), ...(mode ? { mode } : {}),
    }, {}, value => { captured = value; return {} as any }, retained)
    factory({ binary: process.execPath, repoRoot: fixtureRepoRoot, candidateSha: 'a'.repeat(40),
      buildDirty: false, preserveHomeOnStop: true, env: {}, setupHome: setup })
    await captured.setupHome!(home)
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)
    expect(setup).toHaveBeenCalledExactlyOnceWith(home)
  })

  it('projects only the selected ordinary Amplifier profile into the owned web home before native preparation', async () => {
    const selected = path.join(fixtureRepoRoot, 'selected-amplifier')
    const home = path.join(fixtureRepoRoot, 'owned-web-home')
    await fsp.mkdir(path.join(selected, 'bundles'), { recursive: true })
    const settings = JSON.stringify({ bundle: { active: 'default', added: { default: '/home/freshell/provider/.amplifier/bundles/default.yaml' } } })
    const bundle = JSON.stringify({ providers: [{ module: 'provider-vllm', config: { default_model: 'selected-unit-model' } }] })
    await fsp.writeFile(path.join(selected, 'settings.yaml'), settings)
    await fsp.writeFile(path.join(selected, 'bundles/default.yaml'), bundle)
    await fsp.writeFile(path.join(selected, 'keys.env'), 'PRIVATE_CREDENTIAL_SENTINEL')
    await fsp.mkdir(path.join(selected, 'projects/native-history'), { recursive: true })
    let captured!: RuntimeWebConstructOptions
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts', provider: 'amplifier',
    }, { FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: selected }, value => { captured = value; return {} as any })
    // Profile bytes are selected once; web replacements reuse that selection.
    await fsp.writeFile(path.join(selected, 'bundles/default.yaml'), 'changed after selection')
    factory({ binary: process.execPath, repoRoot: fixtureRepoRoot, candidateSha: 'a'.repeat(40), buildDirty: false,
      preserveHomeOnStop: true, env: {}, setupHome: async ownedHome => {
        await fsp.mkdir(path.join(ownedHome, '.freshell'), { recursive: true })
        await fsp.writeFile(path.join(ownedHome, '.freshell/config.json'), '{"version":1}')
      } })
    await captured.setupHome!(home)
    expect(await fsp.readFile(path.join(home, '.amplifier/settings.yaml'), 'utf8')).toBe(settings)
    expect(await fsp.readFile(path.join(home, '.amplifier/bundles/default.yaml'), 'utf8')).toBe(bundle)
    expect(await fsp.readdir(path.join(home, '.amplifier'))).toEqual(['bundles', 'settings.yaml'])
    expect(await fsp.readFile(path.join(home, '.freshell/config.json'), 'utf8')).toBe('{"version":1}')
    expect(captured.env.FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME).toBeUndefined()
    expect(runner.externalCloudMetadata({ ...descriptor,
      FRESHELL_RUNTIME_EXTERNAL_SPEC: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
      FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS: 'amplifier',
      FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: selected }).FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME).toBeUndefined()
  })
  it('requires an ordinary Amplifier profile only for its selected full native owner', () => {
    const selection = { spec: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts', provider: 'amplifier' as const }
    const web = () => ({} as any)
    expect(() => runner.createExternalManagedWebFactory(selection, {}, web)).toThrow(/FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME/)
    expect(() => runner.createExternalManagedWebFactory({ ...selection, provider: 'codex' },
      { FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: '/missing/ordinary-profile' }, web)).not.toThrow()
    expect(() => runner.createExternalManagedWebFactory({ ...selection,
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts' },
      { FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: '/missing/ordinary-profile' }, web)).not.toThrow()
    expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, {}, web, true)).not.toThrow()
  })
  it('keeps private bootstrap reads out of the external browser while preserving local setup refusal', () => {
    for (const key of Object.keys(descriptor)) vi.stubEnv(key, undefined)
    vi.stubEnv('FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE', undefined)
    try {
      expect(() => createManagedOpenCodeRuntimeBrowserRig()).toThrow(/FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE/)
      for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
      vi.stubEnv('FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE', '/missing-private-owner-grant')
      expect(createManagedOpenCodeRuntimeBrowserRig()).toBeInstanceOf(runner.ExternalManagedRuntimeRig)
    } finally { vi.unstubAllEnvs() }
  })
  it('requires host-private OpenCode bootstrap only for selected native continuity and qualification web setup', async () => {
    const native = { spec: 'test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts', grep: 'P2-G04' }
    const web = vi.fn(() => { throw new Error('owned web factory intercepted') })
    expect(() => runner.createExternalManagedWebFactory(native, {}, web)).toThrow(/FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE/)
    expect(() => runner.createExternalManagedWebFactory({ ...native, grep: 'P2-G01' }, {}, web)).not.toThrow()
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-owner-bootstrap-'))
    try {
      const auth = path.join(directory, 'auth.json'), environmentFile = path.join(directory, 'environment.env'), ca = path.join(directory, 'ca.pem')
      await fsp.writeFile(auth, JSON.stringify({ openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.now() + 7_200_000 } }), { mode: 0o600 })
      await fsp.writeFile(environmentFile, [
        'HTTPS_PROXY=http://unit.invalid:8080', 'https_proxy=http://unit.invalid:8080',
        'HTTP_PROXY=http://unit.invalid:8080', 'http_proxy=http://unit.invalid:8080',
        'OPENAI_BASE_URL=https://api.openai.com/v1', 'NODE_EXTRA_CA_CERTS=/home/freshell/provider/.config/onecli/gateway-ca.pem',
        'NODE_USE_ENV_PROXY=1', 'NO_PROXY=127.0.0.1,localhost',
      ].join('\n'), { mode: 0o600 })
      await fsp.writeFile(ca, 'private unit CA fixture; no TLS use', { mode: 0o600 })
      const environment = { FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: auth,
        FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: environmentFile, FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: ca }
      const options: RuntimeWebConstructOptions = { binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40),
        buildDirty: false, setupHome: async () => undefined, preserveHomeOnStop: false, env: { PORT: '3399' } }
      const selections: runner.ExternalBrowserSelection[] = [native, { spec: 'test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts', provider: 'opencode' }]
      for (const selection of selections) {
        const capture = vi.fn((input: RuntimeWebConstructOptions) => { throw Object.assign(new Error('owned web factory intercepted'), { input }) })
        const factory = runner.createExternalManagedWebFactory(selection, environment, capture)
        expect(() => factory(options)).toThrow(/intercepted/)
        expect(capture.mock.calls[0][0].env).toMatchObject({ ...environment, PORT: '3399', FRESHELL_BIND_HOST: '0.0.0.0' })
      }
      await fsp.chmod(ca, 0o644)
      expect(() => runner.createExternalManagedWebFactory(native, environment, web)).toThrow(/private/)
      expect(web).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('preserves the saved-history registered fixture profile and observer preset', async () => {
    const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
      spec: 'test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts', grep: 'already-live attach',
    }, {}, () => { throw new Error('unused saved-history web') })
    expect(owned.fixtureRegistrationFacts()).toEqual({ phase: 3, enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const previous: SupervisorInstance = { scenarioId: 'history-owner', containerId: 'b'.repeat(64),
      volumeName: 'owned-history-volume', controlSocket: '/owned/control.sock', controlSecret: 'fixture-test-secret',
      controlSecretFile: '/owned/control-secret', runtimeRoot: '/owned/runtime', binaryKind: 'test' }
    owned.supervisor = previous
    vi.spyOn(owned.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(owned.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const launch = vi.spyOn(owned.runtime, 'startSupervisor').mockResolvedValue({ ...previous, containerId: 'c'.repeat(64) })
    await owned.restartSupervisor()
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ binaryKind: 'test', env: {
      FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS: '5000', FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS: '10000',
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000',
    } }))
  })
  it('registers the stopped nine-soul runbook independently of native phase-three cases', () => {
    const selection = { spec: 'test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts',
      grep: '^stopped nine-soul restoration runbook$' }
    const web = () => { throw new Error('batch registration never launches web') }
    const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection,
      { FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1' }, web)
    expect(owned.fixtureRegistrationFacts()).toEqual({ phase: 3, enabledProviders: [],
      freshAgentModes: [], fixtureFreshAgentModes: [] })
    expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, {}, web)).toThrow(/opt.in|SYNTHETIC/)
    expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, { ...selection, grep: '.*' },
      { FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1' }, web)).toThrow(/separate|exact/)
  })
  it('preserves the all-mode fixture observer interval on an actual supervisor replacement', async () => {
    const owner = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, {
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
    const child = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'),
      path.join(sourceRoot, 'scripts/testing/runtime-external-browser.ts'),
      '--spec', 'test/e2e-browser/specs/auth.spec.ts'], {
      cwd: fixtureRepoRoot, env: { ...process.env, FRESHELL_E2E_BACKEND: 'cloud' },
      encoding: 'utf8', timeout: 15_000,
    })
    expect(child.status).toBe(1)
    const failure = child.stderr.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).find(row => row?.event === 'managed_external_admission_or_run_failed')
    expect(failure?.diagnosticPath).toEqual(expect.any(String))
    const artifact = JSON.parse(fs.readFileSync(failure.diagnosticPath, 'utf8'))
    let original: unknown
    try { runner.parseExternalBrowserArguments(['--spec', 'test/e2e-browser/specs/auth.spec.ts'], {}) }
    catch (error) { original = error }
    expect(artifact.error).toMatchObject({ name: 'Error', message: (original as Error).message })
    expect(failure.reason).toBe((original as Error).message)
    expect(fs.statSync(failure.diagnosticPath).mode & 0o077).toBe(0)
    expect(fs.statSync(path.dirname(failure.diagnosticPath)).mode & 0o077).toBe(0)
  })

  it('retains the original child failure through its cause and explains a missing workload image', () => {
    let cause: Error | undefined
    try {
      execFileSync(process.execPath, ['-e', 'process.stderr.write("Error response from daemon: No such image: sha256:" + "a".repeat(64)); process.exit(1)'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { cause = error as Error }
    expect(cause).toBeInstanceOf(Error)
    Object.assign(cause!, { request: { body: 'request-body-sentinel' }, response: { body: 'response-body-sentinel' },
      env: { PRIVATE_TOKEN: 'environment-sentinel' } })
    const failure = runner.captureExternalBrowserFailure(new Error('owned runtime admission failed', { cause }), fixtureRepoRoot)
    expect(failure.reason).toMatch(/workload image.*(?:missing|unavailable)/i)
    expect(failure.reason).toContain('FRESHELL_RUNTIME_WORKLOAD_IMAGE_DIGEST')
    const bytes = fs.readFileSync(failure.diagnosticPath!, 'utf8')
    const artifact = JSON.parse(bytes)
    expect(artifact.error.cause).toMatchObject({ name: cause!.name, message: cause!.message, stack: cause!.stack })
    expect(bytes).not.toMatch(/request-body-sentinel|response-body-sentinel|environment-sentinel/)
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
  it('executes both tabs owner profiles separately without losing either case', async () => {
    const spec = 'test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts'
    const cases = [
      { id: 'saved-history', file: spec, title: 'Phase 4 managed-runtime tab rehydration › managed fresh-agent: already-live attach restores stale loss through real hosted HTTP truth' },
      { id: 'rehydration', file: spec, title: 'Phase 4 managed-runtime tab rehydration › P4-G08: controller inventory reconstructs views without duplicating souls' },
    ]
    const owned = { start: vi.fn().mockResolvedValue(descriptor), list: vi.fn().mockResolvedValue(cases),
      child: vi.fn(async (_command: string, args: string[]) => {
        const grepIndex = args.indexOf('--grep')
        const selected = cases.filter(row => grepIndex < 0 || new RegExp(args[grepIndex + 1]).test(row.title))
        return { exitCode: 0, cases: selected.map(row => ({ ...row, status: 'passed' as const })) }
      }), finish: vi.fn().mockResolvedValue({ ok: true, errors: [] }), abort: vi.fn().mockResolvedValue({ ok: true, errors: [] }) }
    await expect(runner.runExternalBrowserCli(['--spec', spec], { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).resolves.toEqual({
      selected: 2, executed: 2, passed: 2, failed: 0, skipped: 0, timedOut: 0 })
    expect(owned.start).toHaveBeenCalledTimes(2)
    expect(owned.finish).toHaveBeenCalledTimes(2)
    expect(owned.child).toHaveBeenCalledTimes(2)
    expect(owned.finish.mock.invocationCallOrder[0]).toBeLessThan(owned.start.mock.invocationCallOrder[1])
    expect(owned.child.mock.calls.every(call => call[1].includes('--grep'))).toBe(true)
    const profiles = owned.start.mock.calls.map(([selection]) => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, {}, () => { throw new Error('unused profile web') }).fixtureRegistrationFacts())
    expect(profiles).toEqual([{ phase: 3, enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] },
      { phase: 4, enabledProviders: ['opencode'], freshAgentModes: [], fixtureFreshAgentModes: [] }])
    owned.start.mockClear()
    await expect(runner.runExternalBrowserCli(['--spec', spec, '--grep', 'already-live attach|nonexistent requested title'],
      { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/zero/)
    expect(owned.start).not.toHaveBeenCalled()
    await expect(runner.runExternalBrowserCli(['--spec', spec, '--grep', 'P4-G08'], { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).resolves.toMatchObject({ selected: 1, executed: 1, passed: 1 })
    expect(owned.start).toHaveBeenCalledTimes(1)
    owned.start.mockClear()
    owned.finish.mockResolvedValueOnce({ ok: false, errors: ['owned fixture cleanup failure'] })
    await expect(runner.runExternalBrowserCli(['--spec', spec], { FRESHELL_E2E_BACKEND: 'cloud' }, owned)).rejects.toThrow(/cleanup/)
    expect(owned.start).toHaveBeenCalledTimes(1)
  })
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
  it('hands current original references off only after actual child and settled cleanup', async () => {
    const { owned, cases } = lifecycle()
    const originals = { runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID, candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA }
    const publishOriginals = vi.fn().mockReturnValue(originals)
    const result = await runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, { ...owned, publishOriginals })
    expect(result.originals).toEqual([originals])
    expect(publishOriginals).toHaveBeenCalledWith(cases, cases.map(row => ({ ...row, status: 'passed' })))
    expect(owned.finish.mock.invocationCallOrder[0]).toBeLessThan(publishOriginals.mock.invocationCallOrder[0])
    publishOriginals.mockClear()
    owned.finish.mockResolvedValueOnce({ ok: false, errors: ['cleanup failed'] })
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, { ...owned, publishOriginals })).rejects.toThrow(/cleanup/)
    expect(publishOriginals).not.toHaveBeenCalled()
    owned.child.mockResolvedValueOnce({ exitCode: 1, cases: cases.map(row => ({ ...row, status: 'passed' })) })
    await expect(runner.dispatchOwnedExternalBrowser({ spec: smokeSpec }, { FRESHELL_E2E_BACKEND: 'cloud' }, { ...owned, publishOriginals })).rejects.toThrow(/failed/)
    expect(publishOriginals).not.toHaveBeenCalled()
  })
  it('retains both separately owned rehydrate original indexes and aggregate counts', async () => {
    const spec = 'test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts'
    const cases = [
      { id: 'history', file: spec, title: 'Phase 4 managed-runtime tab rehydration › managed fresh-agent: already-live attach restores stale loss through real hosted HTTP truth' },
      { id: 'tabs', file: spec, title: 'Phase 4 managed-runtime tab rehydration › P4-G08: controller inventory reconstructs views without duplicating souls' },
    ]
    const { owned } = lifecycle()
    owned.list.mockResolvedValue(cases)
    owned.child.mockImplementation(async (_command, args) => ({ exitCode: 0,
      cases: cases.filter(row => new RegExp(args[args.indexOf('--grep') + 1]).test(row.title)).map(row => ({ ...row, status: 'passed' })) }))
    const publishOriginals = vi.fn().mockReturnValueOnce({ runId: 'owned-first' }).mockReturnValueOnce({ runId: 'owned-second' })
    const result = await runner.runExternalBrowserCli(['--spec', spec], { FRESHELL_E2E_BACKEND: 'cloud' }, { ...owned, publishOriginals })
    expect(result).toMatchObject({ selected: 2, executed: 2, passed: 2, originals: [{ runId: 'owned-first' }, { runId: 'owned-second' }] })
    expect(publishOriginals).toHaveBeenCalledTimes(2)
    publishOriginals.mockClear().mockReturnValue({ runId: 'owned-partial' })
    const partial = await runner.runExternalBrowserCli(['--spec', spec, '--grep', 'P4-G08:'],
      { FRESHELL_E2E_BACKEND: 'cloud' }, { ...owned, publishOriginals })
    expect(partial).toMatchObject({ selected: 1, executed: 1, passed: 1, originals: [{ runId: 'owned-partial' }] })
    expect(publishOriginals).toHaveBeenCalledOnce()
    expect(publishOriginals.mock.calls[0][0]).toEqual([cases[1]])
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
    const owner = new ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot)
    const artifactPath = path.join(owner.runtime.evidenceDir, 'cloud-launcher-output.json')
    const privateBody = 'private-cloud-command-body'
    const fakePnpm = `#!${process.execPath}
if (process.argv.includes('--version')) {
  console.log('10.34.5')
} else {
  console.log('${privateBody}')
  console.error('exact execution image observation is unavailable')
  // Keep the child alive long enough for its executable and cwd to be observed.
  setTimeout(() => { process.exitCode = 73 }, 1_000)
}
`
    await fsp.writeFile(path.join(directory, 'pnpm'), fakePnpm, { mode: 0o700 })
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

describe('body-free ordinary-turn Cloud diagnostics', () => {
  it('retains safe native failure outcome and sequence from the production reducer in forwarded diagnostics', () => {
    const target = { provider: 'codex' as const, terminalId: 'owned-terminal', streamId: 'owned-stream', nativeSessionId: 'native-owned' }
    const facts = { requestInputSeen: true, renderedAnswerSeen: false, ...reduceTerminalOrdinaryTurnFrames([{
      type: 'terminal.turn.complete', ...target, sessionId: target.nativeSessionId, completionSeq: 9, outcome: 'failed', error: 'PRIVATE_API_ERROR',
    }], captureTerminalOrdinaryTurnBaseline([], target)) }
    const parsed = runner.parseManagedOrdinaryTurnDiagnosticText(JSON.stringify({
      event: 'durable_souls.ordinary_turn_failed', lane: 'terminal', provider: target.provider,
      ordinaryTurnFailureStage: 'turn_completion', ordinaryTurnFacts: { ...facts, error: 'PRIVATE_API_ERROR' },
    }))
    expect(parsed).toMatchObject([{ ordinaryTurnFacts: { renderedAnswerSeen: false, completionSeen: false, completionOutcome: 'failed', completionSeq: 9 } }])
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_API_ERROR')
  })

  it('forwards only the request-correlated Codex pane-creation probe for the exact terminal smoke', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const testCase = { id: 'ordinary-turn-codex-pane-create-probe', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'each selected terminal provider completes one ordinary turn' } as any
      const probe = {
        terminalCreateResult: 'created', inventoryRead: 'ok', matchingRowCount: 1,
        matchingRows: [{ launchState: 'starting', providerMatch: true, containerIdPresent: true }],
      }
      const safeEvent = { severity: 'error', event: 'durable_souls.pane_creation_probe',
        lane: 'terminal', provider: 'codex', probe }
      reporter.onStdOut(`${JSON.stringify(safeEvent)}\n`, testCase)
      reporter.onStdOut(`${JSON.stringify({ ...safeEvent,
        probe: { ...probe, createRequestId: 'private-request-id-sentinel',
          terminalId: 'private-terminal-id-sentinel', message: 'private-message-sentinel' } })}\n`, testCase)
      reporter.onStdOut(`${JSON.stringify({ ...safeEvent, prompt: 'private-prompt-sentinel' })}\n`, testCase)

      expect(write).toHaveBeenCalledOnce()
      const forwarded = JSON.parse(String(write.mock.calls[0][0]))
      expect(forwarded).toEqual({
        severity: 'info', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
        candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
        event: 'managed_external_ordinary_turn', id: 'ordinary-turn-codex-pane-create-probe',
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.pane_creation_probe', outcome: 'failed', lane: 'terminal',
        provider: 'codex', paneCreationProbe: probe,
      })
      const serialized = JSON.stringify(forwarded)
      for (const sentinel of [
        'private-request-id-sentinel', 'private-terminal-id-sentinel', 'private-message-sentinel',
        'private-prompt-sentinel',
      ]) expect(serialized).not.toContain(sentinel)
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('forwards the Codex managed-view probe only for the exact terminal smoke', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const testCase = { id: 'ordinary-turn-codex-probe', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'each selected terminal provider completes one ordinary turn' } as any
      const probe = projectManagedViewProbe({
        terminalId: 'private-terminal-id-sentinel', createRequestId: 'private-request-id-sentinel', provider: 'codex',
        sentMessages: [{ type: 'terminal.create', requestId: 'private-request-id-sentinel' }],
        receivedMessages: [], inventoryRead: 'ok',
        inventory: [{ terminalId: 'private-terminal-id-sentinel', launchState: 'starting', provider: 'codex',
          containerId: 'a'.repeat(64), soulId: 'private-soul-id-sentinel' }],
      })
      reporter.onStdOut(`${JSON.stringify({ severity: 'error', event: 'durable_souls.managed_view_probe',
        lane: 'terminal', provider: 'codex', probe, prompt: 'private-prompt-sentinel' })}\n`, testCase)
      reporter.onStdOut(`${JSON.stringify({ event: 'durable_souls.managed_view_probe', lane: 'terminal',
        provider: 'claude', probe })}\n`, testCase)
      reporter.onStdOut(`${JSON.stringify({ event: 'durable_souls.managed_view_probe', lane: 'terminal',
        provider: 'codex', probe })}\n`, { ...testCase, id: 'wrong-title', title: 'different title' } as any)

      expect(write).toHaveBeenCalledOnce()
      const forwarded = JSON.parse(String(write.mock.calls[0][0]))
      expect(forwarded).toEqual({
        severity: 'info', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
        candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
        event: 'managed_external_ordinary_turn', id: 'ordinary-turn-codex-probe',
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.managed_view_probe', outcome: 'failed', lane: 'terminal', provider: 'codex',
        managedViewProbe: {
          terminalCreateResult: 'no_reply', createSent: true, inventoryRead: 'ok', matchingRowCount: 1,
          matchingRows: [{ launchState: 'starting', providerMatch: true, containerIdPresent: true }],
        },
      })
      const serialized = JSON.stringify(forwarded)
      for (const sentinel of ['private-terminal-id-sentinel', 'private-request-id-sentinel',
        'private-soul-id-sentinel', 'private-prompt-sentinel']) expect(serialized).not.toContain(sentinel)
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('forwards only the fixed setup stage and safe facts from the selected terminal smoke', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const testCase = { id: 'ordinary-turn-codex', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'each selected terminal provider completes one ordinary turn' } as any
      reporter.onStdOut(`${JSON.stringify({
        severity: 'error', event: 'durable_souls.ordinary_turn_failed', lane: 'terminal', provider: 'codex',
        paneSetupFailureStage: 'managed_runtime_view', ordinaryTurnFailureStage: null,
        terminalFacts: { available: false }, ordinaryTurnFacts: {
          requestInputSeen: false, activitySeen: false, outputSeen: false, outputFrameCount: 0, completionSeen: false,
        },
        prompt: 'private-prompt-sentinel', providerOutput: 'private-provider-output-sentinel',
      })}\n`, testCase)

      expect(write).toHaveBeenCalledOnce()
      const forwarded = JSON.parse(String(write.mock.calls[0][0]))
      expect(forwarded).toEqual({
        severity: 'info', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
        candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
        event: 'managed_external_ordinary_turn', id: 'ordinary-turn-codex',
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.ordinary_turn_failed', outcome: 'failed', lane: 'terminal', provider: 'codex',
        paneSetupFailureStage: 'managed_runtime_view', ordinaryTurnFailureStage: null,
        terminalFacts: { available: false }, ordinaryTurnFacts: {
          requestInputSeen: false, activitySeen: false, outputSeen: false, outputFrameCount: 0, completionSeen: false,
        },
      })
      expect(JSON.stringify(forwarded)).not.toContain('private-prompt-sentinel')
      expect(JSON.stringify(forwarded)).not.toContain('private-provider-output-sentinel')
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('forwards only bounded FreshAgent readiness facts without errors or assistant text', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const testCase = { id: 'ordinary-turn-freshcodex', location: {
        file: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
      }, title: 'each selected fresh-agent mode completes one ordinary turn' } as any
      const event = JSON.stringify({
        severity: 'error', event: 'durable_souls.ordinary_turn_failed', lane: 'fresh-agent', mode: 'freshcodex',
        stage: 'waiting_for_composer', createCompleted: true, composerFilled: false,
        assistantBaselineCaptured: false, composerSubmitted: false, sendObserved: false,
        turnCompleteObserved: false, assistantTextDisplayed: false,
        assistantDom: { available: true, rows: 0, textCharacters: 0, assistantText: 'private-assistant-sentinel' },
        providerEvents: { counts: { created: 1, createFailed: 0, assistant: 0, stream: 0, error: 0,
          snapshot: 0, changed: 0, turnComplete: 0, result: 0 }, createFailureCodes: [],
          createFailureDiagnostics: [], errorCodePresent: false, errorMessagePresent: false,
          unapproved: 'private-provider-output-sentinel' },
        readiness: {
          paneFound: true, paneStatus: 'connected', sessionStatePresent: true,
          sessionStatus: 'idle', attachTargetsPaneSession: true,
          composerPresent: true, composerDisabled: false, composerVisible: true,
          composerFocused: false, composerHasInput: false,
          connectionStatus: 'ready', networkEffectsSuppressed: false,
          sessionError: 'private-readiness-sentinel',
        },
      })
      reporter.onStdOut(event.slice(0, 80), testCase)
      reporter.onStdOut(`${event.slice(80)}\n`, testCase)

      expect(write).toHaveBeenCalledOnce()
      const forwarded = JSON.parse(String(write.mock.calls[0][0]))
      expect(forwarded).toEqual({
        severity: 'info', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
        candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
        event: 'managed_external_ordinary_turn', id: 'ordinary-turn-freshcodex',
        file: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.ordinary_turn_failed', outcome: 'failed', lane: 'fresh-agent',
        mode: 'freshcodex', stage: 'waiting_for_composer', createCompleted: true, composerFilled: false,
        assistantBaselineCaptured: false, composerSubmitted: false, sendObserved: false,
        turnCompleteObserved: false, assistantTextDisplayed: false,
        assistantDom: { available: true, rows: 0, textCharacters: 0 },
        providerEvents: { counts: { created: 1, createFailed: 0, assistant: 0, stream: 0, error: 0,
          snapshot: 0, changed: 0, turnComplete: 0, result: 0 }, createFailureCodes: [],
          createFailureDiagnostics: [], errorCodePresent: false, errorMessagePresent: false },
        readiness: {
          paneFound: true, paneStatus: 'connected', sessionStatePresent: true,
          sessionStatus: 'idle', attachTargetsPaneSession: true,
          composerPresent: true, composerDisabled: false, composerVisible: true,
          composerFocused: false, composerHasInput: false,
          connectionStatus: 'ready', networkEffectsSuppressed: false,
        },
      })
      for (const sentinel of ['private-assistant-sentinel', 'private-provider-output-sentinel', 'private-readiness-sentinel']) {
        expect(JSON.stringify(forwarded)).not.toContain(sentinel)
      }
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('forwards only fixed setup stages from the exact managed-provider ordinary-turn test', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const testCase = { id: 'ordinary-turn-setup-failure', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'each selected terminal provider completes one ordinary turn' } as any
      reporter.onStdOut(`${JSON.stringify({
        severity: 'error', event: 'durable_souls.ordinary_setup_failed', lane: 'terminal', stage: 'harness_ready',
        error: 'private-exception-sentinel', stack: 'private-stack-sentinel', readiness: { text: 'private-readiness-sentinel' },
      })}\n${JSON.stringify({
        severity: 'error', event: 'durable_souls.ordinary_setup_failed', lane: 'terminal', stage: 'private-stage-sentinel',
      })}\n`, testCase)

      expect(write).toHaveBeenCalledOnce()
      const forwarded = JSON.parse(String(write.mock.calls[0][0]))
      expect(forwarded).toEqual({
        severity: 'info', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
        candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
        event: 'managed_external_ordinary_turn', id: 'ordinary-turn-setup-failure',
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.ordinary_setup_failed', outcome: 'failed', lane: 'terminal',
        setupFailureStage: 'harness_ready',
      })
      const serialized = JSON.stringify(forwarded)
      for (const sentinel of ['private-exception-sentinel', 'private-stack-sentinel', 'private-readiness-sentinel']) {
        expect(serialized).not.toContain(sentinel)
      }
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('forwards safe stderr diagnostics only for exact ordinary-turn targets and flushes a final partial FreshAgent line', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const terminalTest = { id: 'stderr-terminal', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'each selected terminal provider completes one ordinary turn' } as any
      const terminalDiagnostic = JSON.stringify({
        event: 'durable_souls.ordinary_turn_failed', lane: 'terminal', provider: 'codex',
        paneSetupFailureStage: 'managed_runtime_view', ordinaryTurnFailureStage: null,
        terminalFacts: { available: false }, ordinaryTurnFacts: null,
        prompt: 'private-stderr-prompt-sentinel', providerOutput: 'private-stderr-output-sentinel',
      })
      const line = `${JSON.stringify({ event: 'durable_souls.ordinary_turn_completed', lane: 'terminal', provider: 'codex' })}\n`
      reporter.onStdErr(`${terminalDiagnostic}\n`, terminalTest)
      reporter.onStdErr(line, { id: 'stderr-wrong-title', location: terminalTest.location,
        title: 'a different test title' } as any)
      reporter.onStdErr(line, { id: 'stderr-wrong-spec', location: {
        file: 'test/e2e-browser/specs/other.spec.ts',
      }, title: terminalTest.title } as any)

      const freshAgentTest = { id: 'stderr-fresh-agent', location: {
        file: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
      }, title: 'each selected fresh-agent mode completes one ordinary turn', titlePath: () => [
        'runtime-fresh-agent-qualification-rust.spec.ts', 'ordinary turns',
        'each selected fresh-agent mode completes one ordinary turn',
      ] } as any
      reporter.onStdErr(`${JSON.stringify({
        event: 'durable_souls.ordinary_turn_completed', lane: 'fresh-agent', mode: 'freshopencode',
        assistantText: 'private-stderr-assistant-sentinel',
      })}`, freshAgentTest)
      expect(write).toHaveBeenCalledOnce()

      reporter.onTestEnd(freshAgentTest, { status: 'passed' } as any)

      const forwarded = write.mock.calls.map(([output]) => JSON.parse(String(output)))
      expect(forwarded.map(event => event.event)).toEqual([
        'managed_external_ordinary_turn', 'managed_external_ordinary_turn', 'managed_external_case',
      ])
      expect(forwarded[0]).toEqual({
        severity: 'info', runId: descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID,
        candidateSha: descriptor.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA,
        event: 'managed_external_ordinary_turn', id: 'stderr-terminal',
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.ordinary_turn_failed', outcome: 'failed', lane: 'terminal', provider: 'codex',
        paneSetupFailureStage: 'managed_runtime_view', ordinaryTurnFailureStage: null,
        terminalFacts: { available: false }, ordinaryTurnFacts: null,
      })
      expect(forwarded[1]).toMatchObject({
        severity: 'info', event: 'managed_external_ordinary_turn', id: 'stderr-fresh-agent',
        file: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
        sourceEvent: 'durable_souls.ordinary_turn_completed', outcome: 'completed', lane: 'fresh-agent',
        mode: 'freshopencode',
      })
      const serialized = JSON.stringify(forwarded)
      for (const sentinel of [
        'private-stderr-prompt-sentinel', 'private-stderr-output-sentinel', 'private-stderr-assistant-sentinel',
      ]) expect(serialized).not.toContain(sentinel)
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('flushes one valid buffered final diagnostic line when the selected test ends', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const testCase = { id: 'ordinary-turn-final-line', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'each selected terminal provider completes one ordinary turn', titlePath: () => [
        'runtime-managed-provider-qualification-rust.spec.ts', 'ordinary managed-provider use',
        'each selected terminal provider completes one ordinary turn',
      ] } as any
      reporter.onStdOut(`${JSON.stringify({ event: 'durable_souls.ordinary_turn_completed', lane: 'terminal', provider: 'codex' })}`, testCase)
      reporter.onTestEnd(testCase, { status: 'passed' } as any)

      const forwarded = write.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(forwarded.map(event => event.event)).toEqual([
        'managed_external_ordinary_turn', 'managed_external_case',
      ])
      expect(forwarded[0]).toMatchObject({
        event: 'managed_external_ordinary_turn', sourceEvent: 'durable_souls.ordinary_turn_completed',
        provider: 'codex', outcome: 'completed',
      })
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it('does not forward ordinary diagnostics from another test title or spec', () => {
    for (const [key, value] of Object.entries(descriptor)) vi.stubEnv(key, value)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const reporter = new runner.default()
      const line = `${JSON.stringify({ event: 'durable_souls.ordinary_turn_completed', lane: 'terminal', provider: 'codex' })}\n`
      reporter.onStdOut(line, { id: 'wrong-title', location: {
        file: 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts',
      }, title: 'a different test title' } as any)
      reporter.onStdOut(line, { id: 'wrong-spec', location: {
        file: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
      }, title: 'each selected fresh-agent mode completes one ordinary turn' } as any)
      reporter.onStdOut(`${JSON.stringify({
        event: 'durable_souls.ordinary_setup_failed', lane: 'terminal', stage: 'runtime_start',
      })}\n`, { id: 'wrong-setup-spec', location: {
        file: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts',
      }, title: 'each selected fresh-agent mode completes one ordinary turn' } as any)

      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

describe('body-free managed-view probe projection', () => {
  it('keeps only matching create outcome and fixed inventory facts', () => {
    const probe = projectManagedViewProbe({
      terminalId: 'private-terminal-id-sentinel',
      createRequestId: 'private-request-id-sentinel',
      provider: 'codex',
      sentMessages: [{ type: 'terminal.create', requestId: 'private-request-id-sentinel' }],
      receivedMessages: [{ type: 'error', requestId: 'private-request-id-sentinel', code: 'PTY_SPAWN_FAILED',
        message: 'private-error-message-sentinel', terminalId: 'private-error-terminal-sentinel' }],
      inventoryRead: 'ok',
      inventory: [
        { terminalId: 'other-terminal', launchState: 'running', provider: 'codex', containerId: 'a'.repeat(64) },
        { terminalId: 'private-terminal-id-sentinel', launchState: 'failed', provider: 'codex',
          containerId: 'b'.repeat(64), soulId: 'private-soul-id-sentinel' },
        { terminalId: 'private-terminal-id-sentinel', launchState: 'private-launch-state-sentinel',
          provider: 'private-provider-sentinel', containerId: '', nativeSessionId: 'private-session-id-sentinel' },
      ],
    })

    expect(probe).toEqual({
      terminalCreateResult: 'error', createSent: true, wireErrorCode: 'PTY_SPAWN_FAILED',
      inventoryRead: 'ok', matchingRowCount: 2,
      matchingRows: [
        { launchState: 'failed', providerMatch: true, containerIdPresent: true },
        { launchState: 'unknown', providerMatch: false, containerIdPresent: false },
      ],
    })
    const serialized = JSON.stringify(probe)
    for (const sentinel of [
      'private-terminal-id-sentinel', 'private-request-id-sentinel', 'private-error-message-sentinel',
      'private-error-terminal-sentinel', 'private-soul-id-sentinel', 'private-launch-state-sentinel',
      'private-provider-sentinel', 'private-session-id-sentinel',
    ]) expect(serialized).not.toContain(sentinel)
  })

  it('keeps matching create errors while omitting unknown wire codes', () => {
    const probe = projectManagedViewProbe({
      terminalId: 'target-terminal', createRequestId: 'target-request', provider: 'codex',
      sentMessages: [{ type: 'terminal.create', requestId: 'target-request' }],
      receivedMessages: [{ type: 'error', requestId: 'target-request', code: 'private-wire-code-sentinel',
        message: 'private-wire-message-sentinel' }],
      inventoryRead: 'failed', inventory: null,
    })

    expect(probe).toEqual({
      terminalCreateResult: 'error', createSent: true,
      inventoryRead: 'failed', matchingRowCount: 0, matchingRows: [],
    })
    expect(JSON.stringify(probe)).not.toContain('private-wire-code-sentinel')
    expect(JSON.stringify(probe)).not.toContain('private-wire-message-sentinel')
  })

  it('caps exact matches and includes only a bounded row projection', () => {
    const probe = projectManagedViewProbe({
      terminalId: 'target-terminal', createRequestId: 'target-request', provider: 'codex',
      sentMessages: [{ type: 'terminal.create', requestId: 'another-request' }],
      receivedMessages: [{ type: 'terminal.created', requestId: 'another-request' }],
      inventoryRead: 'ok',
      inventory: Array.from({ length: 10_005 }, (_, index) => ({ terminalId: 'target-terminal',
        launchState: index % 2 ? 'running' : 'starting', provider: 'codex', containerId: 'c'.repeat(64),
        soulId: `private-soul-${index}` })),
    })

    expect(probe.terminalCreateResult).toBe('no_reply')
    expect(probe.createSent).toBe(false)
    expect(probe.matchingRowCount).toBe(10_000)
    expect(probe.matchingRows).toHaveLength(8)
    expect(probe.matchingRows[0]).toEqual({ launchState: 'starting', providerMatch: true, containerIdPresent: true })
    expect(JSON.stringify(probe)).not.toContain('private-soul-')
  })
})

describe('owned stable relay admission and lifetime (transport unit coverage only)', () => {
  it('admits the existing bounded CPU diagnostic and then finishes the owner over actual HTTP', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused relay diagnostic web') }, fixtureRepoRoot)
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const enclosure = owned.runtimeEnclosureHandle({ soulId: 'diagnostic-soul', incarnationId: 'diagnostic-incarnation',
      containerId: 'b'.repeat(64), hostBootId: 'diagnostic-boot' })
    const publish = vi.spyOn(owned, 'publishFreshCodexSavedHistoryMeasurement').mockResolvedValue({ artifactRef: 'diagnostic-record' })
    const stop = vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    const relay = new runner.OwnedManagedRuntimeRelay({ token: context.token, backend: () => 'http://127.0.0.1:1', control })
    const frame = { functionName: 'f'.repeat(120), script: 'owned-asset.js', line: 1, column: 1 }
    const measurement = { kind: 'owned-page saved-history diagnostic', errors: [], cpu: {
      startTimeUs: 1, endTimeUs: 2, sampledDurationMs: 1, sampleCount: 1,
      topLeaves: Array.from({ length: 80 }, () => ({ ...frame, samples: 1, durationMs: 1,
        stack: Array.from({ length: 20 }, () => ({ ...frame })) })), seconds: [],
    } }
    const post = async (body: unknown) => fetch(`${relay.localUrl}/__managed_runtime`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': context.token }, body: JSON.stringify(body) })
    const base = { runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime' }
    try {
      await relay.start()
      relay.setOrigin(context.baseUrl)
      const request = { ...base, operationId: 'large-diagnostic', action: 'freshcodex-history-measurement-artifact', enclosure, historyMeasurement: measurement }
      expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(64 * 1024)
      const response = await post(request)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { artifactRef: 'diagnostic-record' } })
      expect(publish).toHaveBeenCalledOnce()
      const finish = await post({ ...base, operationId: 'finish-after-diagnostic', action: 'finish' })
      expect(finish.status).toBe(200)
      expect(await finish.json()).toMatchObject({ result: { ok: true } })
      expect(stop).toHaveBeenCalledOnce()
    } finally { await relay.stop() }
  })
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

describe('owner HTTP failure observability', () => {
  const context = () => runner.resolveManagedExternalDescriptor(descriptor)!
  const operationId = '550e8400-e29b-41d4-a716-446655440000'
  const edgeHeaders = { server: 'cloudflare', 'content-type': 'text/html; charset=UTF-8', 'cf-ray': '0123456789abcdef-SJC' }
  const edgeFailure = () => new Response('private-response-sentinel', { status: 502, headers: edgeHeaders })
  const ownerReply = (init: RequestInit, result: unknown) => {
    const request = JSON.parse(String(init.body))
    return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
      operationId: request.operationId, result }))
  }
  it('retries the observed upstream retained-status 502 and returns the actual validated owner stage', async () => {
    const bound = context(), write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const stage = { kind: 'failed', sequence: 7 }
    let attempts = 0
    const transport = vi.fn(async (_url: string, init: RequestInit) => ++attempts === 1
      ? edgeFailure() : ownerReply(init, stage))
    try {
      const rig = new runner.ExternalManagedRuntimeRig(bound, transport)
      await expect(rig.retainedFixtureStage()).resolves.toEqual(stage)
      expect(transport).toHaveBeenCalledTimes(2)
      const requests = transport.mock.calls.map(([url, init]) => ({ url, method: init.method, headers: init.headers, body: init.body }))
      expect(requests[1]).toEqual(requests[0])
      expect(JSON.parse(String(requests[0].body))).toMatchObject({ runId: bound.runId, candidateSha: bound.candidateSha,
        scenarioId: 'browser-managed-runtime', action: 'retained-status', operationId: expect.any(String) })
      expect(timeout.mock.calls).toEqual([[90_000], [90_000]])
      const events = write.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(events.filter(event => event.event === 'managed_external_owner_http_failed')).toEqual([
        expect.objectContaining({ action: 'retained-status', status: 502, server: 'cloudflare', contentType: 'html', relayRequestId: null }),
      ])
      expect(events.filter(event => event.event === 'managed_external_owner_transport_retry')).toEqual([
        { severity: 'warn', event: 'managed_external_owner_transport_retry', runId: bound.runId, candidateSha: bound.candidateSha,
          operationId: JSON.parse(String(requests[0].body)).operationId, action: 'retained-status' },
      ])
      expect(JSON.stringify(events)).not.toContain('private-')
      expect(JSON.stringify(events)).not.toContain(bound.token)
    } finally { timeout.mockRestore(); write.mockRestore() }
  })
  it.each([
    ['edge', 'edge'], ['fetch', 'edge'], ['edge', 'fetch'], ['fetch', 'fetch'],
  ] as const)('shares the original two-attempt budget for retained-status failures %s then %s', async (first, second) => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    let attempts = 0
    const transport = vi.fn(async (_url: string, _init: RequestInit) => {
      const failure = [first, second][attempts++]
      if (failure === 'fetch') throw new TypeError('private-fetch-sentinel')
      return edgeFailure()
    })
    try {
      const rig = new runner.ExternalManagedRuntimeRig(context(), transport)
      await expect(rig.retainedFixtureStage()).rejects.toThrow(second === 'edge'
        ? 'closed owner operation refused: 502' : 'closed owner retained-status transport did not settle')
      expect(transport).toHaveBeenCalledTimes(2)
      expect(transport.mock.calls[1]).toEqual([transport.mock.calls[0][0],
        expect.objectContaining({ method: transport.mock.calls[0][1].method,
          headers: transport.mock.calls[0][1].headers, body: transport.mock.calls[0][1].body })])
      expect(timeout.mock.calls).toEqual([[90_000], [90_000]])
      const events = write.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(events.filter(event => event.event === 'managed_external_owner_transport_retry')).toHaveLength(1)
      const failures = events.filter(event => event.event === 'managed_external_owner_http_failed')
      expect(failures).toHaveLength([first, second].filter(value => value === 'edge').length)
      for (const failure of failures) expect(failure).toMatchObject({ action: 'retained-status', status: 502,
        server: 'cloudflare', contentType: 'html', relayRequestId: null,
        operationId: JSON.parse(String(transport.mock.calls[0][1].body)).operationId })
      expect(JSON.stringify(events)).not.toContain('private-')
    } finally { timeout.mockRestore(); write.mockRestore() }
  })
  it('preserves successful fetch-rejection recovery with the same retained-status operation', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    let attempts = 0
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      if (++attempts === 1) throw new TypeError('fetch failed')
      return ownerReply(init, { kind: 'finished', sequence: 3 })
    })
    try {
      const rig = new runner.ExternalManagedRuntimeRig(context(), transport)
      await expect(rig.retainedFixtureStage()).resolves.toEqual({ kind: 'finished', sequence: 3 })
      expect(transport).toHaveBeenCalledTimes(2)
      expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body)
    } finally { write.mockRestore() }
  })
  it.each([
    [502, { server: 'cloudflare', 'content-type': 'application/json' }],
    [502, { server: 'unknown', 'content-type': 'text/html' }],
    [502, { ...edgeHeaders, 'x-freshell-relay-request-id': operationId }],
    [502, { ...edgeHeaders, 'x-freshell-relay-request-id': 'invalid-owned-header' }],
    [409, edgeHeaders],
    [503, edgeHeaders],
  ])('refuses retained-status HTTP %i without retry for headers %j', async (status, headers) => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const transport = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status, headers }))
    try {
      const rig = new runner.ExternalManagedRuntimeRig(context(), transport)
      await expect(rig.retainedFixtureStage()).rejects.toThrow(`closed owner operation refused: ${status}`)
      expect(transport).toHaveBeenCalledOnce()
      expect(write.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(['managed_external_owner_http_failed'])
    } finally { write.mockRestore() }
  })
  it.each(['start', 'observe', 'finish', 'replace-web'] as const)('never retries upstream 502 for the mutating %s operation', async action => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const transport = vi.fn(async (_url: string, _init: RequestInit) => edgeFailure())
    try {
      const rig = new runner.ExternalManagedRuntimeRig(context(), transport)
      const result = action === 'start' ? rig.startRetainedFixture('legacy')
        : action === 'observe' ? rig.observeRetainedFixture(7)
          : action === 'finish' ? rig.finishRetainedFixture() : rig.crashAndRestartWeb()
      await expect(result).rejects.toThrow('closed owner operation refused: 502')
      expect(transport).toHaveBeenCalledOnce()
      const sent = JSON.parse(String(transport.mock.calls[0][1].body))
      if (action === 'start') expect(sent.challengeId).toBe('legacy')
      if (action === 'observe') expect(sent.generation).toBe(7)
    } finally { write.mockRestore() }
  })
  it.each(['wrong-run', 'invalid-stage', 'invalid-json'] as const)('preserves %s refusal after the upstream retained-status retry', async invalid => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    let attempts = 0
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      if (++attempts === 1) return edgeFailure()
      if (invalid === 'invalid-json') return new Response('not JSON')
      if (invalid === 'invalid-stage') return ownerReply(init, { kind: 'preparing', sequence: -1 })
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ runId: 'wrong-run', candidateSha: request.candidateSha,
        operationId: request.operationId, result: { kind: 'preparing', sequence: 0 } }))
    })
    try {
      const rig = new runner.ExternalManagedRuntimeRig(context(), transport)
      await expect(rig.retainedFixtureStage()).rejects.toThrow(invalid === 'invalid-json'
        ? 'closed owner reply is not valid JSON' : invalid === 'invalid-stage'
          ? 'closed owner retained-status reply result is missing or invalid'
          : 'closed owner reply has invalid run, candidate, operation or shape')
      expect(transport).toHaveBeenCalledTimes(2)
    } finally { write.mockRestore() }
  })
  it('records receipt and completion for control-local retained status while the ordinary backend is unavailable', async () => {
    const bound = context(), recordLifecycle = vi.fn()
    const stage = { kind: 'observe', sequence: 1, phase: 'store_blocked', context: { token: 'private-context-sentinel' } }
    const control = vi.fn(async () => ({ runId: bound.runId, candidateSha: bound.candidateSha, operationId, result: stage }))
    const relay = new runner.OwnedManagedRuntimeRelay({ token: bound.token, backend: () => 'http://127.0.0.1:1', control,
      diagnostics: { runId: bound.runId, candidateSha: bound.candidateSha, recordLifecycle } })
    try {
      await relay.start()
      const response = await fetch(`${relay.localUrl}/__managed_runtime`, { method: 'POST',
        headers: { 'x-auth-token': bound.token }, body: JSON.stringify({ runId: bound.runId, candidateSha: bound.candidateSha, operationId,
          scenarioId: 'browser-managed-runtime', action: 'retained-status' }) })
      expect(response.status).toBe(200)
      expect((await response.json()).result).toEqual(stage)
      expect(recordLifecycle).toHaveBeenCalledWith('external.relay_owner_received', expect.objectContaining({
        severity: 'info', runId: bound.runId, candidateSha: bound.candidateSha,
        diagnosticId: response.headers.get('x-freshell-relay-request-id') }))
      expect(recordLifecycle).toHaveBeenCalledWith('external.relay_owner_completed', expect.objectContaining({
        status: 200, operationId, action: 'retained-status', stage: { kind: 'observe', sequence: 1, phase: 'store_blocked' } }))
      expect(JSON.stringify(recordLifecycle.mock.calls)).not.toContain('private-context-sentinel')
      expect(control).toHaveBeenCalledOnce()
    } finally { await relay.stop() }
  })
  it('records a genuine outer body-read failure as 502 and preserves a separate control refusal as 409', async () => {
    const bound = context(), recordLifecycle = vi.fn()
    const control = vi.fn(async () => { throw Object.assign(new Error('private-error-sentinel'), { code: 'private-code-sentinel' }) })
    const relay = new runner.OwnedManagedRuntimeRelay({ token: bound.token, backend: () => 'http://127.0.0.1:1', control,
      diagnostics: { runId: bound.runId, candidateSha: bound.candidateSha, recordLifecycle } })
    const post = (body: string) => fetch(`${relay.localUrl}/__managed_runtime`, { method: 'POST',
      headers: { 'x-auth-token': bound.token }, body })
    try {
      await relay.start()
      const outer = await post('private-body-sentinel' + 'x'.repeat(2 * 1024 * 1024))
      expect(outer.status).toBe(502)
      expect(outer.headers.get('server')).toBe('freshell-managed-runtime-relay')
      await outer.text()
      expect(control).not.toHaveBeenCalled()
      expect(recordLifecycle).toHaveBeenCalledWith('external.relay_owner_failed', expect.objectContaining({
        severity: 'error', phase: 'body_read', status: 502, errorClass: 'Error', errorCode: 'unknown' }))
      const refused = await post(JSON.stringify({ runId: bound.runId, candidateSha: bound.candidateSha,
        operationId, action: 'retained-status', scenarioId: 'browser-managed-runtime' }))
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({ reason: 'owner_operation_refused' })
      expect(control).toHaveBeenCalledOnce()
      expect(recordLifecycle).toHaveBeenCalledWith('external.relay_owner_completed', expect.objectContaining({ status: 409, operationId }))
      for (const secret of ['private-error-sentinel', 'private-code-sentinel', 'private-body-sentinel', bound.token]) {
        expect(JSON.stringify(recordLifecycle.mock.calls)).not.toContain(secret)
      }
    } finally { await relay.stop() }
  })
  it.each([
    [{ server: 'cloudflare', 'content-type': 'text/html', 'cf-ray': '0123456789abcdef-SJC', 'x-freshell-relay-request-id': operationId },
      { server: 'cloudflare', contentType: 'html', cloudflareRay: '0123456789abcdef-SJC', relayRequestId: operationId }],
    [{ server: 'freshell-managed-runtime-relay', 'content-type': 'application/json', 'x-freshell-relay-request-id': operationId },
      { server: 'owned_relay', contentType: 'json', cloudflareRay: null, relayRequestId: operationId }],
    [{ server: 'private-header-sentinel', 'content-type': 'private-header-sentinel', 'cf-ray': 'private-header-sentinel',
      'x-freshell-relay-request-id': 'private-header-sentinel' },
      { server: 'unknown', contentType: 'other', cloudflareRay: null }],
    [{}, { server: 'unknown', contentType: 'absent', cloudflareRay: null }],
  ])('records bounded client 502 provenance and fails once with headers %j', async (headers, provenance) => {
    const bound = context(), write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const transport = vi.fn(async (_url: string, _init: RequestInit) => new Response(
      new TextEncoder().encode('private-response-sentinel'), { status: 502, headers }))
    try {
      const rig = new runner.ExternalManagedRuntimeRig(bound, transport)
      await expect(rig.retainedFixtureStage()).rejects.toThrow('closed owner operation refused: 502')
      expect(transport).toHaveBeenCalledOnce()
      const sent = JSON.parse(String(transport.mock.calls[0][1].body))
      const events = write.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(events).toContainEqual({ severity: 'error', event: 'managed_external_owner_http_failed',
        runId: bound.runId, candidateSha: bound.candidateSha, operationId: sent.operationId,
        action: 'retained-status', status: 502, relayRequestId: null, ...provenance })
      expect(JSON.stringify(events)).not.toContain('private-')
      expect(JSON.stringify(events)).not.toContain(bound.token)
      expect(JSON.stringify(events)).not.toContain(bound.baseUrl)
    } finally { write.mockRestore() }
  })
  it('retains only finite already-captured tunnel error facts at exact owned stop', async () => {
    const record = vi.fn(), stop = vi.fn(async () => {})
    const tunnel = new runner.OwnedManagedRuntimeTunnel(fixtureRepoRoot, '/unused-pinned-binary', record)
    Object.assign(tunnel, { process: { identity: { pid: 1234, startTicks: '9876', executable: '/owned/cloudflared', cwd: fixtureRepoRoot },
      stop, output: () => ({ stdout: 'private-tunnel-sentinel\n', stderr:
        'ERR Unable to reach the origin service https://private.example/?token=private-tunnel-sentinel\nERR dial tcp: connection refused\nERR connection with edge closed\nERR i/o timeout\nERR private-tunnel-sentinel\n' }) } })
    await tunnel.stop()
    expect(stop).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledOnce()
    expect(record.mock.calls[0][0]).toEqual({ severity: 'info', pid: 1234, startTicks: '9876',
      originUnreachable: 1, connectionRefused: 1, edgeConnectionClosed: 1, timeout: 1, otherErrorLines: 1 })
    expect(JSON.stringify(record.mock.calls)).not.toContain('private-')
    await tunnel.stop()
    expect(record).toHaveBeenCalledOnce()
  })
  it.each(['failure', 'cancel'] as const)('records retained driver %s and last public stage before cleanup without its context', async kind => {
    const owner = new ManagedRuntimeOwner(() => { throw new Error('unused owner web') }, fixtureRepoRoot)
    vi.spyOn(owner, 'info', 'get').mockReturnValue({ baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'private-token',
      port: 1, pid: 42, homeDir: fixtureRepoRoot, configDir: fixtureRepoRoot, logsDir: fixtureRepoRoot,
      debugLogPath: path.join(fixtureRepoRoot, 'unused-web.jsonl'), runtimeRoot: fixtureRepoRoot })
    vi.spyOn(RuntimeHarness.prototype, 'prepareTask2FixtureArtifacts').mockResolvedValue(undefined)
    vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(RuntimeHarness.prototype, 'verifyTransferCleanup').mockImplementation(() => undefined)
    vi.spyOn(RuntimeHarness.prototype, 'writeArtifact').mockImplementation(() => undefined)
    const log = vi.spyOn(RuntimeHarness.prototype, 'recordLifecycle').mockImplementation(() => undefined)
    const configFile = path.join(fixtureRepoRoot, 'private-config.json')
    await fsp.writeFile(configFile, '{}')
    const driver = vi.spyOn(retainedDriver, 'runTask2RetainedFixture').mockImplementation(async (h, _legacy, _factory, hooks) => {
      if (!hooks) throw new Error('test hooks required')
      const pending = hooks.observe({ h, configFile, web: { info: owner.info }, title: 'private-context-sentinel',
        soulId: 'owned', rootSessionId: 'owned-root', childSessionId: 'owned-child', oldContainerId: 'b'.repeat(64),
        oldIncarnationId: 'owned-incarnation', providerVolumeName: 'owned-volume', preferredTabId: 'owned-tab',
        preferredPaneId: 'owned-pane' } as retainedDriver.Task2RetainedBrowserContext, 'store_blocked')
      if (kind === 'failure') {
        await pending
        throw Object.assign(new TypeError('private-driver-error-sentinel'), { code: 'private-driver-code-sentinel' })
      }
      await pending
    })
    const fixtures = new runner.OwnedRetainedBrowserFixtures(owner, {} as any, ['config'])
    try {
      fixtures.start('config')
      await expect.poll(() => fixtures.status().kind).toBe('observe')
      if (kind === 'failure') {
        fixtures.advance(1)
        await expect.poll(() => fixtures.status().kind).toBe('failed')
      }
      await fixtures.cancel()
      expect(log).toHaveBeenCalledWith('external.retained_driver_failed', expect.objectContaining({
        severity: kind === 'cancel' ? 'info' : 'error', parentRunId: owner.runtime.runId,
        fixtureId: 'config', reason: kind === 'cancel' ? 'cancelled' : 'driver_failure',
        stage: { kind: 'observe', sequence: 1, phase: 'store_blocked' },
        errorClass: kind === 'cancel' ? 'Error' : 'TypeError', errorCode: 'unknown' }))
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-')
    } finally { driver.mockRestore(); vi.restoreAllMocks() }
  })
  it('uses the exact image admitted by the owning runtime for retained fixtures', async () => {
    const owner = new ManagedRuntimeOwner(() => { throw new Error('unused owner web') }, fixtureRepoRoot)
    const ownerImage = `sha256:${'a'.repeat(64)}`
    Object.assign(owner.runtime, { imageRef: ownerImage })
    vi.spyOn(owner, 'info', 'get').mockReturnValue({ baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'private-token',
      port: 1, pid: 42, homeDir: fixtureRepoRoot, configDir: fixtureRepoRoot, logsDir: fixtureRepoRoot,
      debugLogPath: path.join(fixtureRepoRoot, 'unused-web.jsonl'), runtimeRoot: fixtureRepoRoot })
    const selectedImages: string[] = []
    vi.spyOn(RuntimeHarness.prototype, 'prepareTask2FixtureArtifacts').mockImplementation(async input => {
      selectedImages.push(input.imageDigest)
      throw new Error('stop after image selection')
    })
    vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(RuntimeHarness.prototype, 'verifyTransferCleanup').mockImplementation(() => undefined)
    const artifact = { path: path.join(fixtureRepoRoot, 'fixture-artifact'), sha256: 'c'.repeat(64) }
    const artifacts = { candidateSha: owner.runtime.candidateSha,
      currentSupervisor: artifact, currentHost: artifact, currentServer: artifact,
      legacySupervisor: artifact, legacyHost: artifact,
      legacyCreatorCommit: '7dbc7ef6b0b87e47ec8386e19115f5e440399898' as const }
    const fixtures = new runner.OwnedRetainedBrowserFixtures(owner, artifacts, ['config'])
    try {
      fixtures.start('config')
      await vi.waitFor(() => expect(fixtures.status().kind).toBe('failed'))
      expect(selectedImages).toEqual([ownerImage])
      await fixtures.cancel()
    } finally { vi.restoreAllMocks() }
  })
  it('uses a run-owned current-candidate image when preparing standalone retained fixtures', async () => {
    const h = new RuntimeHarness(fixtureRepoRoot, '550e8400-e29b-41d4-a716-446655440001', 3)
    const currentImage = `sha256:${'d'.repeat(64)}`
    const ensureImage = vi.spyOn(h as any, 'ensureRuntimeImage').mockImplementation(() => { h.imageRef = currentImage })
    const prepare = vi.spyOn(h, 'prepareTask2FixtureArtifacts').mockResolvedValue(undefined)
    const artifact = { path: path.join(fixtureRepoRoot, 'fixture-artifact'), sha256: 'c'.repeat(64) }
    try {
      await h.prepareTask2FixtureArtifactsForCurrentCandidate({
        candidateSha: h.candidateSha,
        currentSupervisor: artifact, currentHost: artifact, currentServer: artifact,
        legacySupervisor: artifact, legacyHost: artifact,
        legacyCreatorCommit: '7dbc7ef6b0b87e47ec8386e19115f5e440399898',
      })
      expect(ensureImage).toHaveBeenCalledOnce()
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ imageDigest: currentImage }))
    } finally { vi.restoreAllMocks() }
  })
  it('accepts and discards the sealer image digest because the owner supplies the active image', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-retained-manifest-'))
    const manifestPath = path.join(directory, 'manifest.json')
    const candidateSha = 'a'.repeat(40)
    const artifact = { path: path.join(fixtureRepoRoot, 'fixture-artifact'), sha256: 'b'.repeat(64) }
    const manifest = {
      repoRoot: fixtureRepoRoot,
      runId: '550e8400-e29b-41d4-a716-446655440000',
      candidateSha,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      currentSupervisor: artifact, currentHost: artifact, currentServer: artifact,
      legacySupervisor: artifact, legacyHost: artifact,
      legacyCreatorCommit: '7dbc7ef6b0b87e47ec8386e19115f5e440399898',
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    fs.chmodSync(manifestPath, 0o600)
    try {
      const parsed = runner.readRetainedArtifacts(manifestPath, fixtureRepoRoot, candidateSha)
      expect(parsed).not.toHaveProperty('imageDigest')
      expect(parsed).toEqual(expect.objectContaining({ candidateSha, currentSupervisor: artifact }))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('diagnostic sink failure isolation', () => {
  it.each([
    ['external.relay_owner_received', 200],
    ['external.relay_owner_completed', 409],
    ['external.relay_owner_failed', 502],
  ] as const)('settles the original HTTP %s path with status %i when its sink throws', async (failedEvent, status) => {
    const bound = runner.resolveManagedExternalDescriptor(descriptor)!
    const unexpected: unknown[] = []
    const capture = (error: unknown) => { unexpected.push(error) }
    const sinkError = Object.assign(new Error('private-sink-error-sentinel'), { code: 'ENOSPC' })
    const recordLifecycle = vi.fn((event: string) => { if (event === failedEvent) throw sinkError })
    const control = vi.fn(async () => {
      if (status === 409) throw new Error('private-control-error-sentinel')
      return { runId: bound.runId, candidateSha: bound.candidateSha, operationId: '550e8400-e29b-41d4-a716-446655440000', result: { kind: 'preparing', sequence: 0 } }
    })
    const relay = new runner.OwnedManagedRuntimeRelay({ token: bound.token, backend: () => 'http://127.0.0.1:1', control,
      diagnostics: { runId: bound.runId, candidateSha: bound.candidateSha, recordLifecycle } })
    const write = vi.spyOn(fs, 'writeSync').mockReturnValue(0)
    process.on('uncaughtException', capture)
    process.on('unhandledRejection', capture)
    try {
      await relay.start()
      const body = status === 502 ? 'x'.repeat(2 * 1024 * 1024 + 1) : JSON.stringify({
        runId: bound.runId, candidateSha: bound.candidateSha, operationId: '550e8400-e29b-41d4-a716-446655440000',
        scenarioId: 'browser-managed-runtime', action: 'retained-status' })
      const response = await fetch(`${relay.localUrl}/__managed_runtime`, { method: 'POST',
        headers: { 'x-auth-token': bound.token }, body, signal: AbortSignal.timeout(1000) })
      expect(response.status).toBe(status)
      if (status === 409) expect(await response.json()).toEqual({ reason: 'owner_operation_refused' })
      else await response.text()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unexpected).toEqual([])
      expect(recordLifecycle.mock.calls.some(([event]) => event === failedEvent)).toBe(true)
      expect(control).toHaveBeenCalledTimes(status === 502 ? 0 : 1)
      expect(write).toHaveBeenCalledWith(2, expect.stringContaining('managed_external_diagnostic_write_failed'))
      expect(JSON.stringify(write.mock.calls)).not.toContain('private-')
    } finally {
      await relay.stop()
      process.removeListener('uncaughtException', capture)
      process.removeListener('unhandledRejection', capture)
      write.mockRestore()
    }
  })
  it('keeps the client HTTP error and single dispatch when both stderr writes throw', async () => {
    const bound = runner.resolveManagedExternalDescriptor(descriptor)!
    const transport = vi.fn(async () => new Response(null, { status: 502 }))
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('private-stderr-error-sentinel') })
    const fallback = vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw new Error('private-stderr-descriptor-sentinel') })
    try {
      const rig = new runner.ExternalManagedRuntimeRig(bound, transport)
      await expect(rig.retainedFixtureStage()).rejects.toThrow('closed owner operation refused: 502')
      expect(transport).toHaveBeenCalledOnce()
      expect(write).toHaveBeenCalled()
      expect(fallback).toHaveBeenCalled()
    } finally { write.mockRestore(); fallback.mockRestore() }
  })
  it.each(['edge', 'fetch'] as const)('returns actual retained status after %s failure when both diagnostic sinks throw', async failure => {
    const bound = runner.resolveManagedExternalDescriptor(descriptor)!
    let attempts = 0
    const stage = { kind: 'failed', sequence: 7 }
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      if (++attempts === 1) {
        if (failure === 'fetch') throw new TypeError('private-fetch-sentinel')
        return new Response('private-response-sentinel', { status: 502,
          headers: { server: 'cloudflare', 'content-type': 'text/html' } })
      }
      const request = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: stage }))
    })
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('private-stderr-error-sentinel') })
    const fallback = vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw new Error('private-stderr-descriptor-sentinel') })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const rig = new runner.ExternalManagedRuntimeRig(bound, transport)
      await expect(rig.retainedFixtureStage()).resolves.toEqual(stage)
      expect(transport).toHaveBeenCalledTimes(2)
      expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0])
      expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body)
      expect(timeout.mock.calls).toEqual([[90_000], [90_000]])
      expect(write.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        severity: 'warn', event: 'managed_external_owner_transport_retry', runId: bound.runId, candidateSha: bound.candidateSha,
        operationId: JSON.parse(String(transport.mock.calls[0][1].body)).operationId, action: 'retained-status',
      })
      expect(fallback).toHaveBeenCalledWith(2, expect.stringContaining('managed_external_diagnostic_write_failed'))
      expect(JSON.stringify([write.mock.calls, fallback.mock.calls])).not.toContain('private-')
    } finally { timeout.mockRestore(); write.mockRestore(); fallback.mockRestore() }
  })
  it.each([
    ['edge', 'edge'], ['edge', 'fetch'], ['fetch', 'edge'], ['fetch', 'fetch'],
  ] as const)('retains bounded %s then %s refusal when both diagnostic sinks throw', async (first, second) => {
    const bound = runner.resolveManagedExternalDescriptor(descriptor)!
    let attempts = 0
    const transport = vi.fn(async (_url: string, _init: RequestInit) => {
      if ([first, second][attempts++] === 'fetch') throw new TypeError('private-fetch-sentinel')
      return new Response('private-response-sentinel', { status: 502,
        headers: { server: 'cloudflare', 'content-type': 'text/html' } })
    })
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('private-stderr-error-sentinel') })
    const fallback = vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw new Error('private-stderr-descriptor-sentinel') })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const rig = new runner.ExternalManagedRuntimeRig(bound, transport)
      await expect(rig.retainedFixtureStage()).rejects.toThrow(second === 'edge'
        ? 'closed owner operation refused: 502' : 'closed owner retained-status transport did not settle')
      expect(transport).toHaveBeenCalledTimes(2)
      expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body)
      expect(timeout.mock.calls).toEqual([[90_000], [90_000]])
      expect(write.mock.calls.map(([line]) => JSON.parse(String(line)).event)
        .filter(event => event === 'managed_external_owner_transport_retry')).toHaveLength(1)
      expect(fallback).toHaveBeenCalledWith(2, expect.stringContaining('managed_external_diagnostic_write_failed'))
      expect(JSON.stringify([write.mock.calls, fallback.mock.calls])).not.toContain('private-')
    } finally { timeout.mockRestore(); write.mockRestore(); fallback.mockRestore() }
  })
  it.each([false, true])('removes the exact tunnel HOME and settles fields with a throwing sink (stderr failure=%s)', async stderrFails => {
    const home = await fsp.mkdtemp(path.join(fixtureRepoRoot, 'owned-tunnel-home-'))
    await fsp.chmod(home, 0o700)
    const stop = vi.fn(async () => {})
    const diagnostics = vi.fn(() => { throw new Error('private-tunnel-sink-sentinel') })
    const tunnel = new runner.OwnedManagedRuntimeTunnel(fixtureRepoRoot, '/unused-pinned-binary', diagnostics)
    Object.assign(tunnel, { home, origin: 'https://owned.trycloudflare.com', process: {
      identity: { pid: 1234, startTicks: '9876', executable: '/owned/cloudflared', cwd: fixtureRepoRoot },
      stop, output: () => ({ stdout: '', stderr: 'ERR private-captured-sentinel' }),
    } })
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      if (stderrFails) throw new Error('private-stderr-error-sentinel')
      return 0
    })
    try {
      await expect(tunnel.stop()).resolves.toBeUndefined()
      await expect(fsp.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(tunnel).toMatchObject({ process: undefined, home: undefined, origin: undefined })
      expect(() => tunnel.baseUrl).toThrow('owned tunnel has not published its origin')
      await tunnel.stop()
      expect(stop).toHaveBeenCalledOnce()
      expect(diagnostics).toHaveBeenCalledOnce()
      expect(JSON.stringify(write.mock.calls)).not.toContain('private-')
    } finally { write.mockRestore() }
  })
  it.each(['external.retained_stage_published', 'external.retained_driver_failed'])(
    'cleans and verifies the retained harness and preserves the driver error when %s throws', async failedEvent => {
      const owner = new ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot)
      vi.spyOn(owner, 'info', 'get').mockReturnValue({ baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'private-token',
        port: 1, pid: 42, homeDir: fixtureRepoRoot, configDir: fixtureRepoRoot, logsDir: fixtureRepoRoot,
        debugLogPath: path.join(fixtureRepoRoot, 'unused-web.jsonl'), runtimeRoot: fixtureRepoRoot })
      vi.spyOn(RuntimeHarness.prototype, 'prepareTask2FixtureArtifacts').mockResolvedValue(undefined)
      const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
      const verify = vi.spyOn(RuntimeHarness.prototype, 'verifyTransferCleanup').mockImplementation(() => undefined)
      vi.spyOn(RuntimeHarness.prototype, 'writeArtifact').mockImplementation(() => undefined)
      const log = vi.spyOn(RuntimeHarness.prototype, 'recordLifecycle').mockImplementation(event => {
        if (event === failedEvent) throw Object.assign(new Error('private-retained-sink-sentinel'), { code: 'EIO' })
      })
      const write = vi.spyOn(fs, 'writeSync').mockReturnValue(0)
      const configFile = path.join(fixtureRepoRoot, 'retained-config.json')
      await fsp.writeFile(configFile, '{}')
      const original = new TypeError('private-original-driver-sentinel')
      vi.spyOn(retainedDriver, 'runTask2RetainedFixture').mockImplementation(async (h, _legacy, _factory, hooks) => {
        if (!hooks) throw new Error('test hooks required')
        await hooks.observe({ h, configFile, web: { info: owner.info }, title: 'private-context-sentinel',
          soulId: 'owned', rootSessionId: 'owned-root', childSessionId: 'owned-child', oldContainerId: 'b'.repeat(64),
          oldIncarnationId: 'owned-incarnation', providerVolumeName: 'owned-volume', preferredTabId: 'owned-tab',
          preferredPaneId: 'owned-pane' } as retainedDriver.Task2RetainedBrowserContext, 'store_blocked')
        throw original
      })
      const fixtures = new runner.OwnedRetainedBrowserFixtures(owner, {} as any, ['config'])
      try {
        fixtures.start('config')
        await expect.poll(() => ['observe', 'failed'].includes(fixtures.status().kind)).toBe(true)
        if (fixtures.status().kind === 'observe') fixtures.advance(1)
        const session = (fixtures as unknown as { session: RetainedFixtureBrowserSession }).session
        await expect(session.settled()).rejects.toBe(original)
        expect(cleanup).toHaveBeenCalledOnce()
        expect(verify).toHaveBeenCalledOnce()
        expect(log.mock.calls.some(([event]) => event === failedEvent)).toBe(true)
        expect(write).toHaveBeenCalledWith(2, expect.stringContaining('managed_external_diagnostic_write_failed'))
        expect(JSON.stringify(write.mock.calls)).not.toContain('private-')
        await fixtures.cancel()
        expect(cleanup).toHaveBeenCalledOnce()
      } finally { vi.restoreAllMocks() }
    },
  )
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
  async function authenticatedFixture() {
    const owned = await fixture()
    await fsp.writeFile(owned.entry, `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers['x-auth-token']!==process.env.AUTH_TOKEN){res.writeHead(401);res.end('{}');return}res.end(JSON.stringify({runtime:'rust',commit:'${'a'.repeat(40)}',buildDirty:false}))}).listen(Number(process.env.PORT),'127.0.0.1')`)
    return owned
  }
  it('launches selected free FreshOpenCode with paid overrides removed from the actual owned web process', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    let constructed!: RuntimeWebConstructOptions
    const factory = runner.createExternalManagedWebFactory({
      spec: 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts', mode: 'freshopencode',
    }, {}, options => { constructed = options; return new runner.ManagedRuntimeWebServer(options) })
    const server = factory({ binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40), buildDirty: false,
      setupHome: setup, preserveHomeOnStop: false, env: { NODE_OPTIONS: `--require=${entry}`,
        OPENAI_API_KEY: 'unit-sentinel', OPENCODE_API_KEY: 'unit-sentinel', ANTHROPIC_API_KEY: 'unit-sentinel',
        FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: '/unit/unreadable', FRESHELL_MANAGED_CODEX_ONECLI_AUTH_FILE: '/unit/unreadable',
        HTTPS_PROXY: 'http://unit.invalid', NODE_EXTRA_CA_CERTS: '/unit/unreadable', FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/control' } })
    let pid: number | undefined
    try {
      const info = await server.start(); pid = info.pid
      const observed = await (await fetch(`${info.baseUrl}/api/server-info`)).json()
      expect(observed.environmentKeys).toContain('FRESHELL_RUNTIME_CONTROL_SOCKET')
      for (const key of ['OPENAI_API_KEY', 'OPENCODE_API_KEY', 'ANTHROPIC_API_KEY', 'FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE',
        'FRESHELL_MANAGED_CODEX_ONECLI_AUTH_FILE', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']) expect(observed.environmentKeys).not.toContain(key)
      expect(constructed.providerFreeFixture).not.toBe(true)
    } finally {
      await server.stop()
      if (pid) await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it.each([
    { identity: 'generated', token: undefined }, { identity: 'configured', token: 'owned-configured-test-token' },
  ])('retains its $identity authentication identity after owned stop/start', async ({ token }) => {
    const { fixture: directory, entry, home, setup } = await authenticatedFixture()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, homeDir: home,
      preserveHomeOnStop: true, token, env: { NODE_OPTIONS: `--require=${entry}` } })
    const pids: number[] = []
    try {
      const initial = await server.start()
      pids.push(initial.pid)
      const headers = { 'x-auth-token': token ?? initial.token }
      expect((await fetch(`${initial.baseUrl}/api/server-info`, { headers })).status).toBe(200)
      await server.stop()
      await expect(fsp.stat(`/proc/${initial.pid}`)).rejects.toThrow()
      const next = await server.start()
      pids.push(next.pid)
      expect(next.pid).not.toBe(initial.pid)
      expect(next.homeDir).toBe(initial.homeDir)
      expect(setup).toHaveBeenCalledOnce()
      expect((await fetch(`${next.baseUrl}/api/server-info`, { headers })).status).toBe(200)
      expect((await fetch(`${next.baseUrl}/api/server-info`, { headers: { 'x-auth-token': 'foreign-token' } })).status).toBe(401)
    } finally {
      await server.stop()
      for (const pid of pids) await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
      await fsp.rm(directory, { recursive: true })
    }
  })
  it('keeps generated authentication identities independent between owned web instances', async () => {
    const { fixture: directory, entry, setup } = await authenticatedFixture()
    const options = { binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40),
      buildDirty: false, setupHome: setup, preserveHomeOnStop: false, env: { NODE_OPTIONS: `--require=${entry}` } }
    const first = new runner.ManagedRuntimeWebServer(options)
    const second = new runner.ManagedRuntimeWebServer(options)
    const pids: number[] = []
    const homes: string[] = []
    try {
      const initial = await first.start()
      pids.push(initial.pid); homes.push(initial.homeDir)
      const other = await second.start()
      pids.push(other.pid); homes.push(other.homeDir)
      for (const [accepted, rejected] of [[initial, other], [other, initial]]) {
        expect((await fetch(`${accepted.baseUrl}/api/server-info`, { headers: { 'x-auth-token': accepted.token } })).status).toBe(200)
        expect((await fetch(`${accepted.baseUrl}/api/server-info`, { headers: { 'x-auth-token': rejected.token } })).status).toBe(401)
      }
    } finally {
      await first.stop()
      await second.stop()
      for (const pid of pids) await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
      for (const home of homes) await expect(fsp.stat(home)).rejects.toThrow()
      await fsp.rm(directory, { recursive: true })
    }
  })
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
  it('retains only the finite FreshAgent provider-start diagnostic category', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const safe = { level: 'WARN', fields: { message: 'fresh_agent.create.launch_failed',
      runtime_code: 'HOST_UNREACHABLE', provider: 'codex', provider_start_diagnostic: 'authentication',
      transcript: 'provider-body-must-not-persist' } }
    const unsafe = { level: 'WARN', fields: { message: 'fresh_agent.create.launch_failed',
      provider_start_diagnostic: 'credential-leak-1' } }
    await fsp.writeFile(entry, `process.stderr.write(${JSON.stringify(JSON.stringify(safe) + '\n' + JSON.stringify(unsafe) + '\n')});\n${await fsp.readFile(entry, 'utf8')}`)
    const diagnostics = vi.fn()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } }, diagnostics)
    try {
      await server.start()
      await server.stop()
      const record = diagnostics.mock.calls[0][0]
      expect(record.facts).toContainEqual({ severity: 'warn', event: 'fresh_agent.create.launch_failed',
        fields: { runtime_code: 'HOST_UNREACHABLE', provider: 'codex', provider_start_diagnostic: 'authentication' } })
      expect(JSON.stringify(record)).not.toContain('provider-body-must-not-persist')
      expect(JSON.stringify(record)).not.toContain('credential-leak-1')
    } finally { await server.stop(); await fsp.rm(directory, { recursive: true }) }
  })
  it('records an authenticated cleanliness refusal before exact owned web cleanup', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    await fsp.writeFile(entry, `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({runtime:'rust',commit:'${'a'.repeat(40)}',buildDirty:true,authToken:'private-admission-secret',transcript:'private-admission-body'}))}).listen(Number(process.env.PORT),'127.0.0.1')`)
    const diagnostics = vi.fn()
    const server = new runner.ManagedRuntimeWebServer({ binary: process.execPath, repoRoot: process.cwd(),
      candidateSha: 'a'.repeat(40), buildDirty: false, setupHome: setup, preserveHomeOnStop: false,
      env: { NODE_OPTIONS: `--require=${entry}` } }, diagnostics)
    try {
      await expect(server.start()).rejects.toThrow(/provenance/)
      await server.stop()
      const record = diagnostics.mock.calls[0][0]
      expect(record.facts).toContainEqual({ severity: 'error', event: 'managed_runtime.web_admission_refused',
        fields: { reason: 'cleanliness_mismatch', expectedCommit: 'a'.repeat(40), observedCommit: 'a'.repeat(40),
          expectedBuildDirty: false, observedBuildDirty: true } })
      expect(JSON.stringify(record)).not.toContain('private-admission-')
      await expect(fsp.stat(`/proc/${record.pid}`)).rejects.toThrow()
      await expect(fsp.stat(record.homeReference)).rejects.toThrow()
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
  it('preserves the actual native preparation error privately after owned HOME cleanup', async () => {
    const { fixture: directory, entry } = await fixture()
    const error = 'initial auth source observation failed; retry preparation PRIVATE_PREPARATION_SENTINEL'
    const logging = `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.FRESHELL_LOG_DIR,'rust-server.jsonl'),JSON.stringify({level:'WARN',event:'fresh_agent.create.provider_inputs_failed',server_pid:process.pid,error:${JSON.stringify(error)}})+'\\n');\n`
    await fsp.writeFile(entry, `${logging}${await fsp.readFile(entry, 'utf8')}`)
    const diagnostics = vi.fn()
    const owner = new ManagedRuntimeOwner(options => new runner.ManagedRuntimeWebServer({ ...options,
      binary: process.execPath, candidateSha: 'a'.repeat(40), buildDirty: false, preserveHomeOnStop: false,
      env: { ...options.env, NODE_OPTIONS: `--require=${entry}` } }, diagnostics), fixtureRepoRoot, 3, {}, {}, 'test', { enabledProviders: [] })
    vi.spyOn(owner.runtime, 'prepare').mockResolvedValue(undefined)
    vi.spyOn(owner as any, 'buildManagedServer').mockReturnValue(process.execPath)
    vi.spyOn(owner as any, 'buildQualificationSupervisor').mockReturnValue(undefined)
    vi.spyOn(owner.runtime, 'recordProviderQualificationBuild').mockReturnValue(undefined)
    vi.spyOn(owner.runtime, 'startSupervisor').mockResolvedValue({ controlSocket: '/unused/socket', controlSecretFile: '/unused/secret' } as SupervisorInstance)
    const cleanup = vi.spyOn(owner.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    try {
      const info = await owner.start()
      await expect(owner.stop()).resolves.toEqual({ ok: true, errors: [] })
      expect(cleanup).toHaveBeenCalledOnce()
      await expect(fsp.stat(info.homeDir)).rejects.toThrow()
      await expect(fsp.stat(`/proc/${info.pid}`)).rejects.toThrow()
      const record = diagnostics.mock.calls[0][0]
      expect(record.privateLogArtifact, 'actual preparation error survives generated HOME removal').toEqual(expect.any(String))
      const artifact = await fsp.readFile(record.privateLogArtifact, 'utf8')
      expect(artifact).toContain(error)
      expect((await fsp.stat(record.privateLogArtifact)).mode & 0o777).toBe(0o600)
      expect(JSON.stringify(record)).not.toContain('PRIVATE_PREPARATION_SENTINEL')
      expect(record.facts).toContainEqual({ severity: 'warn', event: 'fresh_agent.create.provider_inputs_failed', fields: {} })
    } finally { await owner.stop(); vi.restoreAllMocks(); await fsp.rm(directory, { recursive: true }) }
  })
  it('reports private diagnostic write failure while completing owned process and HOME cleanup', async () => {
    const { fixture: directory, entry, setup } = await fixture()
    const logging = `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.FRESHELL_LOG_DIR,'rust-server.jsonl'),JSON.stringify({level:'WARN',event:'fresh_agent.create.provider_inputs_failed',server_pid:process.pid,error:'ordinary preparation failure'})+'\\n');\n`
    await fsp.writeFile(entry, `${logging}${await fsp.readFile(entry, 'utf8')}`)
    const diagnostics = vi.fn(), stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const options = { binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40),
      buildDirty: false, setupHome: setup, preserveHomeOnStop: false, env: { NODE_OPTIONS: `--require=${entry}` },
      writeDiagnosticArtifact: () => { throw Object.assign(new Error('PRIVATE_WRITE_FAILURE_SENTINEL'), { code: 'EACCES' }) } }
    const server = new runner.ManagedRuntimeWebServer(options, diagnostics)
    try {
      const info = await server.start()
      await expect(server.stop()).resolves.toBeUndefined()
      await expect(fsp.stat(info.homeDir)).rejects.toThrow()
      await expect(fsp.stat(`/proc/${info.pid}`)).rejects.toThrow()
      expect(diagnostics.mock.calls[0][0].facts).toContainEqual({ severity: 'warn',
        event: 'managed_runtime.web_diagnostics_retention_failed', fields: { code: 'EACCES' } })
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('PRIVATE_WRITE_FAILURE_SENTINEL')
      expect(JSON.stringify(stderr.mock.calls)).toContain('managed_runtime.web_diagnostics_retention_failed')
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_WRITE_FAILURE_SENTINEL')
    } finally { await server.stop(); stderr.mockRestore(); await fsp.rm(directory, { recursive: true }) }
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
    const h = new RuntimeHarness(fixtureRepoRoot, undefined, 3)
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
    const owned = new ManagedRuntimeOwner(() => { throw new Error('base web unused') }, fixtureRepoRoot)
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
    const artifacts = { candidateSha: owned.runtime.candidateSha,
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
  it.each([
    { kind: 'external', requestedScrub: false }, { kind: 'colocated', requestedScrub: false },
    { kind: 'external', requestedScrub: true }, { kind: 'colocated', requestedScrub: true },
  ])('boots $kind fixture web with only explicitly selected OneCLI references (explicit scrub: $requestedScrub)', async ({ kind, requestedScrub }) => {
    const { fixture: directory, entry, setup } = await fixture()
    const referenceKey = 'FRESHELL_MANAGED_CODEX_ONECLI_ENV_FILE'
    const referenceFile = path.join(directory, 'synthetic-onecli.env')
    await fsp.writeFile(referenceFile, 'synthetic-reference-only\n', { mode: 0o600 })
    await fsp.writeFile(entry, `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');const reference=process.env.${referenceKey};res.end(JSON.stringify({ok:true,runtime:'rust',commit:'${'a'.repeat(40)}',buildDirty:false,environmentKeys:Object.keys(process.env),selectedReferenceReadable:!!reference&&require('node:fs').readFileSync(reference,'utf8')==='synthetic-reference-only\\n'}))}).listen(Number(process.env.PORT),'127.0.0.1')`)
    vi.stubEnv(referenceKey, '/ambient/stale-reference')
    vi.stubEnv('FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE', '/ambient/unselected-reference')
    vi.stubEnv('OPENAI_UNIT_CREDENTIAL', 'ambient-fixture-sentinel')
    vi.stubEnv('FRESHELL_E2E_RUST_SERVER_BIN', process.execPath)
    const options = { binary: process.execPath, repoRoot: process.cwd(), candidateSha: 'a'.repeat(40),
      buildDirty: false, setupHome: setup, preserveHomeOnStop: false, providerFreeFixture: true,
      fixtureOnecliReferences: { [referenceKey]: referenceFile, OPENAI_UNIT_CREDENTIAL: 'ambient-fixture-sentinel' },
      stripEnvPrefixes: requestedScrub ? ['FRESHELL_MANAGED_CODEX_'] : [],
      env: { NODE_OPTIONS: `--require=${entry}`, [referenceKey]: referenceFile,
        FRESHELL_MANAGED_CODEX_UNRELATED_CREDENTIAL: 'explicit-fixture-sentinel',
        FRESHELL_RUNTIME_CONTROL_SOCKET: '/owned/unit/control.sock' } }
    const server = kind === 'external' ? new runner.ManagedRuntimeWebServer(options) : new RustServer(options)
    let pid: number | undefined
    try {
      const info = await server.start()
      pid = info.pid
      const response = await fetch(`${info.baseUrl}/api/server-info`, { headers: { 'x-auth-token': info.token } })
      const observed = await response.json()
      expect(observed.selectedReferenceReadable).toBe(!requestedScrub)
      if (requestedScrub) expect(observed.environmentKeys).not.toContain(referenceKey)
      else expect(observed.environmentKeys).toContain(referenceKey)
      expect(observed.environmentKeys).not.toContain('FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE')
      expect(observed.environmentKeys).not.toContain('OPENAI_UNIT_CREDENTIAL')
      expect(observed.environmentKeys).not.toContain('FRESHELL_MANAGED_CODEX_UNRELATED_CREDENTIAL')
      expect(observed.environmentKeys).toContain('FRESHELL_RUNTIME_CONTROL_SOCKET')
    } finally {
      await server.stop()
      if (pid) await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
      vi.unstubAllEnvs()
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
    const { fixture: directory, entry, setup } = await authenticatedFixture()
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
  it.each(['restart', 'restartAbrupt'] as const)('preserves scratch config and token/port across exact owned %s, then verifies PID absence', async (restart) => {
    const { fixture: directory, entry, home, setup } = await authenticatedFixture()
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
      const next = await server[restart]()
      nextPid = next.pid
      expect(next.baseUrl).toBe(first.baseUrl)
      expect(next.token).toBe(first.token)
      expect(next.pid).not.toBe(first.pid)
      expect((await fetch(`${next.baseUrl}/api/server-info`, { headers: { 'x-auth-token': first.token } })).status).toBe(200)
      expect((await fetch(`${next.baseUrl}/api/server-info`, { headers: { 'x-auth-token': 'foreign-token' } })).status).toBe(401)
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

describe('interrupted ordinary Stop request ACK binding', () => {
  const ownedPane = (sessionId?: string | null) => ({
    pane: { type: 'leaf', id: 'pane-owned', content: {
      kind: 'fresh-agent', soulId: 'soul-owned', createRequestId: 'create-owned',
      provider: 'codex', sessionType: 'freshcodex', sessionId,
      sessionRef: { provider: 'codex', sessionId: 'native-owned' },
    } },
    paneId: 'pane-owned', createRequestId: 'create-owned', soulId: 'soul-owned',
    nativeSessionId: 'native-owned', provider: 'codex', sessionType: 'freshcodex',
  })
  const request = { type: 'freshAgent.kill', sessionId: 'native-owned', provider: 'codex', sessionType: 'freshcodex' }
  const reply = { ...request, type: 'freshAgent.killed', success: false }

  it.each([undefined, null])('accepts the owned native-target failed ACK with presentation ID %s', (sessionId) => {
    const owned = ownedPane(sessionId)
    const hasFailedAck = bindInterruptedOrdinaryStopFailedAck([{ type: 'hello' }, request], 1, owned)
    expect(hasFailedAck([reply], 0)).toBe(true)
  })

  it.each([
    ['none', []],
    ['empty target', [{ ...request, sessionId: '' }]],
    ['missing target', [{ ...request, sessionId: undefined }]],
    ['duplicate', [request, request]],
    ['foreign target', [{ ...request, sessionId: 'native-foreign' }]],
    ['foreign provider', [{ ...request, provider: 'claude' }]],
    ['foreign type', [{ ...request, sessionType: 'freshclaude' }]],
  ])('refuses %s outbound kill evidence', (_reason, frames) => {
    expect(() => bindInterruptedOrdinaryStopFailedAck(frames as any[], 0, ownedPane())).toThrow()
  })

  it.each([
    ['pane', { paneId: 'pane-foreign' }],
    ['create', { createRequestId: 'create-foreign' }],
    ['soul', { soulId: 'soul-foreign' }],
    ['native root', { nativeSessionId: 'native-foreign' }],
    ['provider', { provider: 'claude' }],
    ['type', { sessionType: 'freshclaude' }],
  ])('refuses foreign owned %s identity even if the reply echoes it', (_reason, change) => {
    expect(() => bindInterruptedOrdinaryStopFailedAck([request], 0, { ...ownedPane(), ...change })).toThrow()
  })

  it('refuses a wrong-provider canonical ref and unbound pending target', () => {
    const owned = ownedPane()
    owned.pane.content.sessionRef.provider = 'claude'
    expect(() => bindInterruptedOrdinaryStopFailedAck([request], 0, owned)).toThrow()
    expect(() => bindInterruptedOrdinaryStopFailedAck([request], 0, {
      ...ownedPane(), pendingCreate: { sessionId: 'native-owned' },
    })).toThrow()
    expect(() => bindInterruptedOrdinaryStopFailedAck([request], 0, {
      ...ownedPane(), pendingCreate: { sessionId: 'native-owned', provider: 'claude', sessionType: 'freshcodex' },
    })).toThrow()
    expect(() => bindInterruptedOrdinaryStopFailedAck([request], 0, {
      ...ownedPane(), pendingCreate: { sessionId: 'native-owned', provider: 'codex', sessionType: 'freshclaude' },
    })).toThrow()
  })

  it.each([
    ['presentation over pending', 'presentation-owned', 'pending-owned', 'presentation-owned'],
    ['pending over canonical', undefined, 'pending-owned', 'pending-owned'],
  ])('preserves %s dispatch precedence and its failed reply', (_reason, presentation, pending, target) => {
    const owned = { ...ownedPane(presentation), pendingCreate: {
      sessionId: pending, provider: 'codex', sessionType: 'freshcodex',
    } }
    const hasFailedAck = bindInterruptedOrdinaryStopFailedAck([{ ...request, sessionId: target }], 0, owned)
    expect(hasFailedAck([{ ...reply, sessionId: target }], 0)).toBe(true)
    expect(hasFailedAck([reply], 0)).toBe(false)
    expect(() => bindInterruptedOrdinaryStopFailedAck([request], 0, owned)).toThrow()
  })

  it.each([
    ['wrong outer ID', { ...reply, sessionId: 'native-foreign' }],
    ['wrong outer provider', { ...reply, provider: 'claude' }],
    ['wrong outer type', { ...reply, sessionType: 'freshclaude' }],
    ['success', { ...reply, success: true }],
    ['missing success', { ...reply, success: undefined }],
    ['unrelated event', { ...reply, type: 'freshAgent.event', event: { type: 'freshAgent.created', success: false } }],
    ['inner-only matching ID', { ...reply, type: 'freshAgent.event', sessionId: 'native-foreign', event: reply }],
    ['inner-only provider', { ...reply, type: 'freshAgent.event', provider: undefined, event: reply }],
    ['inner-only type', { ...reply, type: 'freshAgent.event', sessionType: undefined, event: reply }],
    ['foreign envelope', { ...reply, type: 'unrelated', event: reply }],
    ['missing wrapped event', { ...reply, type: 'freshAgent.event' }],
    ['wrapped missing success', { ...reply, type: 'freshAgent.event', event: { ...reply, success: undefined } }],
    ['wrapped success', { ...reply, type: 'freshAgent.event', event: { ...reply, success: true } }],
  ])('rejects %s as the required failed ACK', (_reason, message) => {
    const hasFailedAck = bindInterruptedOrdinaryStopFailedAck([request], 0, ownedPane())
    expect(hasFailedAck([message], 0)).toBe(false)
  })

  it('accepts supported wrapped failure, ignores pre-click frames, and freezes the dispatched tuple', () => {
    const sent = [{ ...request, sessionId: 'old-target' }, { ...request }]
    const owned = ownedPane()
    const hasFailedAck = bindInterruptedOrdinaryStopFailedAck(sent, 1, owned)
    sent[1].sessionId = 'mutated-target'
    owned.pane.content.sessionId = 'mutated-presentation'
    expect(hasFailedAck([reply], 1)).toBe(false)
    expect(hasFailedAck([{ type: 'hello' }, { ...reply, type: 'freshAgent.event', event: reply }], 1)).toBe(true)
    expect(hasFailedAck([{ ...reply, sessionId: 'mutated-target' }], 0)).toBe(false)
  })
})

describe('interrupted ordinary Stop ACK diagnostic', () => {
  const prefix = '[interrupted-ordinary-stop-ack-sockets] '
  const capture = {
    expected: { presentationSessionId: 'presentation-owned', nativeSessionId: 'native-owned', soulId: 'soul-owned' },
    sentAtStop: 1, receivedAtStop: 1, stopSocketAtMs: 50,
    sent: [{ type: 'hello', token: 'PRIVATE_AUTH_TOKEN' },
      { type: 'freshAgent.kill', sessionId: 'presentation-owned', provider: 'codex', sessionType: 'freshcodex',
        observedEpoch: 77, observedGeneration: 9, text: 'PRIVATE_TRANSCRIPT', token: 'PRIVATE_AUTH_TOKEN' }],
    received: [{ type: 'freshAgent.event', event: { type: 'freshAgent.message', text: 'PRIVATE_TRANSCRIPT' } },
      { type: 'freshAgent.event', sessionId: 'other-presentation', provider: 'codex',
        event: { type: 'freshAgent.killed', sessionId: 'native-owned', provider: 'codex', sessionType: 'freshcodex',
          success: false, code: 'STOP_FAILED', text: 'PRIVATE_TRANSCRIPT', url: 'PRIVATE_SOCKET_URL' } },
      { type: 'freshAgent.killed', sessionId: 'presentation-owned', success: false, code: 'ACK_FAILED',
        settings: { token: 'PRIVATE_AUTH_TOKEN' } },
      { type: 'freshAgent.message', text: 'PRIVATE_TRANSCRIPT' }],
    sentSocketFacts: [{ socketOrdinal: 1, atMs: 1 }, { socketOrdinal: 2, atMs: 51 }],
    receivedSocketFacts: [{ socketOrdinal: 1, atMs: 2 }, { socketOrdinal: 2, atMs: 52 },
      { socketOrdinal: 2, atMs: 53 }, { socketOrdinal: 2, atMs: 54 }],
    socketLifecycle: [{ socketOrdinal: 1, atMs: 0, event: 'created' },
      { socketOrdinal: 1, atMs: 49, event: 'closed' }, { socketOrdinal: 2, atMs: 50, event: 'created' },
      { socketOrdinal: 2, atMs: 51, event: 'open-observed-by-frame' }],
  }

  it('retains the complete sanitized failure in actual zero-retry line reporter output', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-ack-output-'))
    try {
      const require = createRequire(import.meta.url)
      const helper = path.join(sourceRoot, 'test/e2e-browser/helpers/runtime-chaos-evidence.ts')
      const config = path.join(directory, 'playwright.config.mjs')
      await fsp.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
      await fsp.writeFile(config, `export default ${JSON.stringify({ testDir: directory, retries: 0, workers: 1,
        reporter: 'line', outputDir: path.join(directory, 'results') })}`)
      await fsp.writeFile(path.join(directory, 'ack.spec.ts'), `
        import playwright from ${JSON.stringify(require.resolve('@playwright/test'))}
        import { reportInterruptedOrdinaryStopAckFailure } from ${JSON.stringify(helper)}
        const { test, expect } = playwright
        test('owned zero-retry ACK failure', async ({}, testInfo) => {
          const failure = new Error('ORIGINAL_ACK_ASSERTION')
          try { await reportInterruptedOrdinaryStopAckFailure(failure, testInfo, ${JSON.stringify(capture)}) }
          catch (observed) { expect(observed).toBe(failure); throw observed }
        })
      `)
      const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config], {
        cwd: sourceRoot, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      const output = `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      expect(output).toContain('ORIGINAL_ACK_ASSERTION')
      expect(output).toMatch(/1 failed/)
      expect(output).not.toContain('retry #')
      const line = output.split(/\r?\n/).find(row => row.startsWith(prefix))
      expect(line, 'diagnostic must survive the collected text output').toBeDefined()
      expect(line!.length).toBeGreaterThan(300)
      const diagnostic = JSON.parse(line!.slice(prefix.length))
      expect(diagnostic).toMatchObject({ severity: 'error', event: 'interrupted_ordinary_stop_ack_missing',
        expected: capture.expected, sentAtStop: 1, receivedAtStop: 1, stopSocketAtMs: 50,
        sent: [{ arrayIndex: 1, socketOrdinal: 2, atMs: 51, type: 'freshAgent.kill', sessionId: 'presentation-owned',
          observedEpoch: 77, observedGeneration: 9 }],
        received: [{ arrayIndex: 1, socketOrdinal: 2, atMs: 52, type: 'freshAgent.event',
          sessionId: 'other-presentation', eventSessionId: 'native-owned', success: false, code: 'STOP_FAILED' },
        { arrayIndex: 2, socketOrdinal: 2, atMs: 53, type: 'freshAgent.killed', success: false, code: 'ACK_FAILED' }],
        socketLifecycle: capture.socketLifecycle })
      expect(diagnostic.sent).toHaveLength(1)
      expect(diagnostic.received).toHaveLength(2)
      expect(line).not.toMatch(/PRIVATE_|token|text|settings|url/)
      // A prefix keeps the record in Cloud textPayload, fetched unchanged by
      // the launcher's existing execution-log failure path.
      expect(() => JSON.parse(line!)).toThrow()
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  })

  it('emits before attachment failure and rethrows the identical original assertion', async () => {
    const failure = new Error('original assertion')
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true })
    let emittedBeforeAttach = false
    const attach = vi.fn<Parameters<typeof reportInterruptedOrdinaryStopAckFailure>[1]['attach']>(async () => {
      emittedBeforeAttach = writes.some(line => line.startsWith(prefix))
      throw new Error('attachment unavailable')
    })
    try {
      await expect(reportInterruptedOrdinaryStopAckFailure(failure, { attach }, capture)).rejects.toBe(failure)
      expect(attach).toHaveBeenCalledOnce()
      expect(emittedBeforeAttach).toBe(true)
      expect(writes.filter(line => line.startsWith(prefix))).toHaveLength(1)
      const attachedBody = attach.mock.calls[0][1].body
      expect(Buffer.isBuffer(attachedBody)).toBe(true)
      expect(writes[0]).toBe(`${prefix}${attachedBody!.toString()}\n`)
    } finally { write.mockRestore() }
  })
})

describe('interrupted ordinary Stop owner transport', () => {
  const selection = { spec: 'test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts',
    grep: 'synthetic interrupted ordinary Stop preserves history$' }
  const supervisorEnv = { FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS: '5000',
    FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS: '10000', FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000' }

  async function fixture() {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-interrupted-stop-'))
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused interrupted Stop web') }, fixtureRepoRoot, 3,
      {}, supervisorEnv, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'stop-soul',
      incarnationId: 'stop-incarnation', containerId: 'b'.repeat(64), hostBootId: 'stop-boot', nativeSessionId: 'stop-root' }
    const runtimeRoot = path.join(directory, 'runtimes')
    const runtimeDir = path.join(runtimeRoot, handle.incarnationId)
    await fsp.mkdir(runtimeDir, { recursive: true })
    await fsp.mkdir(path.join(directory, 'evidence'))
    const hostState = path.join(runtimeDir, 'host-state.json')
    const lifecycle = path.join(directory, 'evidence', 'lifecycle.jsonl')
    await fsp.writeFile(hostState, JSON.stringify({ hostBootId: handle.hostBootId, workerLaunchCount: 1 }))
    await fsp.writeFile(lifecycle, '')
    owned.supervisor = { scenarioId: 'browser-managed-runtime', containerId: 'c'.repeat(64), runtimeRoot,
      controlSocket: path.join(directory, 'control.sock'), controlSecret: 'owner-private-only',
      controlSecretFile: path.join(directory, 'secret'), volumeName: 'stop-registry-volume', binaryKind: 'test' }
    const row = { ...handle, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 4 }
    const inventory = vi.spyOn(owned, 'inventory').mockImplementation(async () => [row])
    owned.runtime.broker = { receipts: () => [{ ...handle, runtimeDir }], unsafeAttempts: () => [] } as unknown as typeof owned.runtime.broker
    vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    Object.assign(owned.runtime, { evidenceDir: directory })
    const databasePath = path.join(directory, 'runtime.sqlite3')
    const db = new DatabaseSync(databasePath)
    db.exec(`CREATE TABLE souls(soul_id TEXT, provider_store_id TEXT, provider_volume_name TEXT, native_session_id TEXT, intent_revision INTEGER, desired_state TEXT);
      CREATE TABLE incarnations(soul_id TEXT, incarnation_id TEXT, container_id TEXT, execution_generation INTEGER, grant_id TEXT, launch_state TEXT, cleanup_state TEXT, created_at INTEGER);
      CREATE TABLE writer_claims(soul_id TEXT);
      CREATE TABLE recovery_attempts(soul_id TEXT);
      CREATE TABLE ordinary_stops(soul_id TEXT, intent_revision INTEGER, outcome TEXT, revoke_pending INTEGER, settled INTEGER);
      CREATE TABLE stop_tombstones(soul_id TEXT);`)
    db.prepare('INSERT INTO souls VALUES(?,?,?,?,?,?)').run(handle.soulId, 'stop-store', 'stop-provider-volume', handle.nativeSessionId, 4, 'running')
    db.prepare('INSERT INTO incarnations VALUES(?,?,?,?,?,?,?,?)').run(handle.soulId, handle.incarnationId, handle.containerId, 3, 'stop-grant', 'running', 'active', 1)
    db.prepare('INSERT INTO writer_claims VALUES(?)').run(handle.soulId)
    const registry = vi.spyOn(owned.runtime, 'execOwnedContainerExact').mockImplementation((containerId, args) => {
      expect(containerId).toBe(owned.supervisor.containerId)
      const result = spawnSync(args[0], [args[1], args[2].replace('/var/lib/freshell-supervisor/runtime.sqlite3', databasePath), ...args.slice(3)], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    })
    const providerHome = path.join(directory, 'provider')
    const canonicalTranscriptPath = path.join(providerHome, '.codex/sessions', `rollout-fixture-${handle.nativeSessionId}.jsonl`)
    const datedTranscriptPath = path.join(providerHome, '.codex/sessions/2026/03/01', `rollout-${handle.nativeSessionId}.jsonl`)
    await fsp.mkdir(path.dirname(canonicalTranscriptPath), { recursive: true })
    await fsp.writeFile(canonicalTranscriptPath, '')
    const provider = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (containerId, args) => {
      expect(containerId).toBe(handle.containerId)
      const providerPath = path.relative('/home/freshell/provider', args[4]!)
      const result = spawnSync(args[0], [...args.slice(1, 4), path.join(providerHome, providerPath), ...args.slice(5)], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    })
    const stop = vi.spyOn(owned.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    const remove = vi.spyOn(owned.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const start = vi.spyOn(owned.runtime, 'startSupervisor').mockImplementation(async () => ({ ...owned.supervisor,
      containerId: (owned.supervisor.containerId === 'c'.repeat(64) ? 'd' : 'e').repeat(64) }))
    const running = vi.spyOn(owned.runtime, 'isContainerRunning').mockReturnValue(true)
    const logs = vi.spyOn(owned.runtime, 'containerLogs').mockReturnValue('')
    const inspect = vi.spyOn(owned.runtime, 'inspectContainer').mockImplementation(containerId => ({
      Id: containerId, State: { Running: running(containerId), ExitCode: running(containerId) ? 0 : 134 },
    }))
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
      try {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      } catch { return new Response(JSON.stringify({ error: 'runtime_owner_refused' }), { status: 409 }) }
    })
    const request = { runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'stop-operation', action: 'interrupted-stop-facts', handle }
    return { owned, rig, handle, row, inventory, directory, db, registry, provider, canonicalTranscriptPath,
      datedTranscriptPath, hostState, lifecycle,
      stop, remove, start, running, logs, inspect, control, request, wire,
      close: async () => { db.close(); vi.restoreAllMocks(); await fsp.rm(directory, { recursive: true, force: true }) } }
  }

  it('registers only the exact synthetic Stop case as a grant-free phase 3 freshcodex test fixture', () => {
    const owned = runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection,
      { FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1' }, () => { throw new Error('unused registration web') })
    expect(owned.fixtureRegistrationFacts()).toEqual({ phase: 3, enabledProviders: [],
      freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    vi.stubEnv('FRESHELL_MANAGED_CODEX_ONECLI_ENV_FILE', '/absent/ambient-native-grant')
    try {
      expect((owned.runtime as unknown as { phase2BootstrapFiles(): string[] }).phase2BootstrapFiles()).toEqual([])
      expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, selection, {}, () => { throw new Error('unused') }))
        .toThrow(/FRESHELL_RUNTIME_SYNTHETIC_RESUME/)
      expect(() => runner.createExternalManagedRuntimeOwner(fixtureRepoRoot, { ...selection, grep: 'synthetic|P2-G01' },
        { FRESHELL_RUNTIME_SYNTHETIC_RESUME: '1' }, () => { throw new Error('unused') })).toThrow(/separate/)
    } finally { vi.unstubAllEnvs() }
  })

  it('seeds real retained turns, awaits exact fault replacement, and derives SQL/worker/lifecycle facts after Stop', async () => {
    const f = await fixture()
    try {
      await f.rig.prepareInterruptedOrdinaryStopHistory(f.handle)
      const transcript = (await fsp.readFile(f.canonicalTranscriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(transcript[0].payload.id).toBe(f.handle.nativeSessionId)
      expect(transcript.filter(row => row.payload.type === 'user_message').map(row => row.payload.message))
        .toEqual([0, 1, 2].map(index => `Synthetic saved prompt ${index}`))
      expect(transcript.filter(row => row.payload.type === 'task_complete').map(row => row.payload.last_agent_message))
        .toEqual([0, 1, 2].map(index => `Synthetic saved answer ${index}`))
      await expect(fsp.access(f.datedTranscriptPath)).rejects.toThrow()
      const previous = f.owned.supervisor
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      f.start.mockImplementationOnce(async () => { await pending; return { ...previous, containerId: 'd'.repeat(64) } })
      let armed = false
      const arm = f.rig.armInterruptedOrdinaryStop(f.handle).then(() => { armed = true })
      try {
        await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
        expect(armed).toBe(false)
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(previous)
        expect(f.remove).toHaveBeenCalledExactlyOnceWith(previous.containerId)
        expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ scenarioId: previous.scenarioId,
          volumeName: previous.volumeName, binaryKind: 'test', reuseSecret: true,
          env: supervisorEnv, crashPoint: 'ordinary_stop_after_intent' }))
      } finally { release(); await arm }
      const before = await f.rig.installInterruptedOrdinaryStopCounters(f.handle)
      expect(before.durable).toMatchObject({ soul: { native_session_id: 'stop-root', intent_revision: 4 }, writers: 1, effects: [] })
      expect(before.workerLaunchCount).toBe(1)
      expect(before.lifecycle).toEqual([])
      f.running.mockReturnValue(false)
      f.logs.mockReturnValue('not JSON\n' + JSON.stringify({ event: 'supervisor.test_crash', point: 'different_point' }))
      await expect(f.rig.interruptedOrdinaryStopCrashFacts(f.handle)).resolves.toMatchObject({ running: false, crashPoint: null, exitCode: 134 })
      f.logs.mockReturnValue(JSON.stringify({ event: 'supervisor.test_crash', point: 'ordinary_stop_after_intent' }))
      await expect(f.rig.interruptedOrdinaryStopCrashFacts(f.handle)).resolves.toEqual({ running: false, crashPoint: 'ordinary_stop_after_intent', exitCode: 134 })
      await f.rig.restartSupervisor()
      expect(f.owned.supervisor.containerId).toBe('e'.repeat(64))
      expect(f.start.mock.calls[1][0].crashPoint).toBeUndefined()
      f.db.exec(`UPDATE souls SET desired_state='stopped',intent_revision=5;
        UPDATE incarnations SET launch_state='stopped',cleanup_state='verified_empty';
        DELETE FROM writer_claims;
        INSERT INTO ordinary_stops VALUES('stop-soul',5,'verified_empty',0,1);
        INSERT INTO stop_tombstones VALUES('stop-soul');`)
      f.row.launchState = 'stopped'
      f.row.intentRevision = 5
      await fsp.writeFile(f.lifecycle, [
        { event: 'supervisor.stop_committed', data: { soulId: f.handle.soulId, intentRevision: 5, privatePayload: 'omitted' } },
        { event: 'supervisor.stop_continuation', data: { soulId: f.handle.soulId, intentRevision: 5 } },
        { event: 'supervisor.stop_committed', data: { soulId: 'other-soul', intentRevision: 9 } },
      ].map(row => JSON.stringify(row)).join('\n'))
      const after = await f.rig.interruptedOrdinaryStopFacts(f.handle)
      expect(after.durable.soul).toEqual({ ...before.durable.soul, desired_state: 'stopped', intent_revision: 5 })
      expect(after.durable.incarnations).toEqual(before.durable.incarnations.map(row => ({ ...row,
        launch_state: 'stopped', cleanup_state: 'verified_empty' })))
      expect(after.durable).toMatchObject({ writers: 0, effects: [], tombstones: 1,
        stops: [{ intent_revision: 5, outcome: 'verified_empty', revoke_pending: 0, settled: 1 }] })
      expect(after.workerLaunchCount).toBe(before.workerLaunchCount)
      expect(after.lifecycle.map(row => row.event)).toEqual(['supervisor.stop_committed', 'supervisor.stop_continuation'])
      const artifact = await f.rig.publishInterruptedOrdinaryStopResult(f.handle, 6)
      expect(artifact.artifactRef).toMatch(/^interrupted-ordinary-stop:[a-f0-9]{64}$/)
      expect(JSON.parse(await fsp.readFile(path.join(f.directory, 'task006-interrupted-stop.json'), 'utf8')))
        .toMatchObject({ soulId: 'stop-soul', nativeSessionId: 'stop-root', intentRevision: 5, retainedTurns: 6,
          workerLaunchCount: 1, effects: [], crashExitCode: 134 })
      expect(JSON.stringify(f.wire)).not.toMatch(/owner-private-only|Synthetic saved answer|privatePayload|omitted/)
    } finally { await f.close() }
  })

  it('reports every real post-setup SQL effect and refuses foreign or changed owner identities before reads', async () => {
    const f = await fixture()
    try {
      await f.rig.prepareInterruptedOrdinaryStopHistory(f.handle)
      await f.rig.armInterruptedOrdinaryStop(f.handle)
      await f.rig.installInterruptedOrdinaryStopCounters(f.handle)
      f.db.exec(`INSERT INTO incarnations SELECT soul_id,'replacement',container_id,execution_generation,grant_id,launch_state,cleanup_state,2 FROM incarnations;
        INSERT INTO writer_claims VALUES('stop-soul');
        INSERT INTO recovery_attempts VALUES('stop-soul');
        UPDATE incarnations SET execution_generation=4 WHERE incarnation_id='stop-incarnation';`)
      await fsp.writeFile(f.hostState, JSON.stringify({ hostBootId: f.handle.hostBootId, workerLaunchCount: 2 }))
      const facts = await f.rig.interruptedOrdinaryStopFacts(f.handle)
      expect(facts.durable.effects).toEqual(['replacement', 'writer', 'recovery', 'grant'])
      expect(facts.workerLaunchCount).toBe(2)
      f.db.exec("UPDATE souls SET native_session_id='changed-root'")
      await expect(f.control({ ...f.request, operationId: 'changed-durable-root' })).rejects.toThrow(/durable identity/)
      f.registry.mockClear()
      for (const [field, value] of Object.entries({ runId: 'foreign', candidateSha: 'f'.repeat(40), soulId: 'foreign',
        incarnationId: 'foreign', containerId: 'f'.repeat(64), hostBootId: 'foreign', nativeSessionId: 'foreign' })) {
        await expect(f.rig.interruptedOrdinaryStopFacts({ ...f.handle, [field]: value })).rejects.toThrow()
      }
      expect(f.registry).not.toHaveBeenCalled()
      await expect(f.control({ ...f.request, action: 'interrupted-stop-facts', path: '/foreign/database' })).rejects.toThrow(/operation/)
      await fsp.writeFile(f.hostState, JSON.stringify({ hostBootId: 'replaced-boot', workerLaunchCount: 2 }))
      await expect(f.control({ ...f.request, operationId: 'replaced-host' })).rejects.toThrow(/boot|identity/)
      await expect(f.rig.interruptedOrdinaryStopFacts(f.handle)).rejects.toThrow(/refused: 409/)
      expect(f.registry).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('awaits owner history preparation in the actual browser case and cleans up when that operation fails', async () => {
    await import('../../../e2e-browser/specs/runtime-terminal-continuity-rust.spec.js')
    const callback = registeredManagedBrowserCases.get('synthetic interrupted ordinary Stop preserves history')
    if (!callback) throw new Error('actual interrupted Stop callback was not registered')
    const f = await fixture()
    vi.spyOn(managedBrowser, 'createManagedRuntimeBrowserRig').mockReturnValue(f.rig)
    vi.spyOn(f.rig, 'runningViewForFreshSession').mockResolvedValue(f.row)
    vi.spyOn(TestHarness.prototype, 'waitForHarness').mockResolvedValue(undefined)
    vi.spyOn(TestHarness.prototype, 'waitForConnection').mockResolvedValue(undefined)
    vi.spyOn(TestHarness.prototype, 'getState').mockResolvedValue({ tabs: { activeTabId: 'stop-tab' },
      panes: { layouts: { 'stop-tab': { type: 'leaf', id: 'stop-pane', content: {
        kind: 'fresh-agent', sessionId: 'stop-session', createRequestId: 'stop-create-request',
      } } } } } as any)
    let fail!: (error: Error) => void
    const pending = new Promise<void>((_resolve, reject) => { fail = reject })
    const prepare = vi.spyOn(f.owned, 'prepareInterruptedOrdinaryStopHistory').mockReturnValue(pending)
    const cleanup = vi.spyOn(f.owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    let webSocketListener: ((socket: { on(event: string, callback: (frame: { payload: string }) => void): void }) => void) | undefined
    let receiveFrame: ((frame: { payload: string }) => void) | undefined
    const page = {
      on: (event: string, callback: (socket: any) => void) => { if (event === 'websocket') webSocketListener = callback },
      goto: async () => { webSocketListener?.({ on: (event, callback) => { if (event === 'framereceived') receiveFrame = callback } }) },
      getByRole: (role: string) => ({ click: async () => {
        if (role === 'option') receiveFrame?.({ payload: JSON.stringify({ type: 'freshAgent.created',
          requestId: 'stop-create-request', sessionId: 'stop-session' }) })
      } }),
    }
    const completion = expect(Reflect.apply(callback, undefined, [{ page }])).rejects.toThrow(/refused: 409/)
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
      expect(fetcher).toHaveBeenCalledOnce()
      expect(fetcher.mock.calls[0][0]).toContain('/api/settings')
      expect(cleanup).not.toHaveBeenCalled()
    } finally {
      fail(new Error('owned history preparation failed'))
      try { await completion; expect(cleanup).toHaveBeenCalledOnce() }
      finally { vi.unstubAllGlobals(); await f.close() }
    }
  })
})

describe('closed external owner control', () => {
  function fixture() {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('web factory unused in controller unit') }, fixtureRepoRoot)
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const inventory = vi.spyOn(owned, 'inventory').mockResolvedValue([])
    const stop = vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    const request = { runId: context.runId, candidateSha: context.candidateSha, scenarioId: 'browser-managed-runtime', operationId: 'operation-owned', action: 'inventory' }
    return { owned, context, inventory, stop, request }
  }
  it('forwards only registered batch IDs and fixed faults while keeping repair IDs distinct from transport retries', async () => {
    const { owned, context, request } = fixture()
    const activity = { setupHelpersCompleted: 9, helperStartRequests: 0, providerContainerStartRequests: 0, providerLaunchRunningEvents: 0 }
    const facts = { fixtureId: 'fixture-batch', sourceStoreId: 'a'.repeat(64), activity, families: Array.from({ length: 7 }, (_, index) => ({ rootId: `ses_root_${index}`,
      childId: `ses_child_${index}`, grandchildId: `ses_grand_${index}`, baselineMessages: {}, baselineParts: {} })),
      targets: Array.from({ length: 9 }, (_, index) => ({ soulId: `soul-${index}`, providerStoreId: `store-${index}`,
        rootSessionId: `ses_root_${index % 7}`, terminalId: `terminal-${index}`, streamId: `stream-${index}`,
        incidentId: `incident-${index}`, viewIds: [] })), canonicalChoices: [0, 1].map(index => ({ rootSessionId: `ses_root_${index}`, soulId: `soul-${index}` })),
      unrelated: { soulId: 'unrelated', incidentId: 'unrelated-incident', viewId: 'unrelated-view', noticeIds: [], outboxEventIds: [], exportSha256: [] } }
    const read = vi.spyOn(owned, 'syntheticStoppedRepairBatchFacts').mockResolvedValue(facts)
    const fault = vi.spyOn(owned, 'setSyntheticStoppedRepairFault').mockResolvedValue({ controlEpoch: 27 })
    const observation = vi.spyOn(owned, 'syntheticStoppedRepairBatchObservation').mockRejectedValue(new Error('actual operation is absent'))
    const control = runner.createExternalRuntimeControl(owned, context)
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        if (req.headers['x-auth-token'] !== context.token) { res.writeHead(401).end(); return }
        control(JSON.parse(Buffer.concat(chunks).toString('utf8'))).then(result => {
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result))
        }, () => res.writeHead(400).end())
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__managed_runtime`
    const remote = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => fetch(endpoint, init))
    try {
    await expect(remote.prepareSyntheticStoppedRepairBatch()).resolves.toEqual(facts)
    await expect(remote.setSyntheticStoppedRepairFault('fixture-batch', 'none')).resolves.toEqual({ controlEpoch: 27 })
    expect(fault).toHaveBeenCalledExactlyOnceWith('fixture-batch', 'none')
    for (const preset of ['source_generation_change', 'pending_withdrawal'] as const) {
      await expect(remote.setSyntheticStoppedRepairFault('fixture-batch', preset)).resolves.toEqual({ controlEpoch: 27 })
      expect(fault).toHaveBeenLastCalledWith('fixture-batch', preset)
    }
    const query = { ...request, action: 'synthetic-stopped-repair-observation', fixtureId: 'fixture-batch', repairOperationId: 'repair-current' }
    await expect(control(query)).rejects.toThrow(/absent/)
    await expect(control(query)).rejects.toThrow(/absent/)
    expect(observation).toHaveBeenCalledExactlyOnceWith('fixture-batch', 'repair-current')
    await expect(control({ ...query, operationId: 'foreign-path', databasePath: '/foreign' })).rejects.toThrow(/operation/)
    await expect(control({ ...request, operationId: 'generic-fault', action: 'synthetic-stopped-repair-fault',
      fixtureId: 'fixture-batch', stoppedRepairFault: 'arbitrary_source_sql' })).rejects.toThrow(/operation/)
    await expect(control({ ...request, operationId: 'missing-id', action: 'synthetic-stopped-repair-observation' })).rejects.toThrow(/fixture|operation/)
    const measured: import('../../../../scripts/testing/runtime-sandbox.js').SyntheticStoppedRepairBatchObservation = {
      fixtureId: facts.fixtureId, operationId: 'repair-current', controlEpoch: 27,
      activity, faultMarkers: { preset: 'none', supervisorContainerId: 'c'.repeat(64), crash: null, firstResumeObservationFailures: [] },
      scope: { scopeId: 'd'.repeat(64), sourceStoreId: facts.sourceStoreId, sourceFingerprint: 'e'.repeat(64),
        targets: facts.targets.map(target => ({ target: { soulId: target.soulId, incidentId: target.incidentId, expectedIntentRevision: 1 },
          providerStoreId: target.providerStoreId, rootSessionId: target.rootSessionId, incidentRevision: 1, identityRevision: 1,
          nativeImportRevision: 1, evidenceRevision: 1 })), roots: facts.families.map(family => ({ rootSessionId: family.rootId,
          graphDigest: 'f'.repeat(64), eligibleOwners: facts.targets.filter(target => target.rootSessionId === family.rootId).map(target => target.soulId), canonicalSoulId: null })) },
      canonicalChoices: facts.canonicalChoices.map(choice => ({ ...choice, expectedIntentRevision: 1 })),
      status: 'complete', withdrawalStatus: 'files_complete', roots: [], installedStores: [], nativeObservations: [],
      souls: facts.targets.map(target => ({ soulId: target.soulId, providerStoreId: target.providerStoreId,
        nativeSessionId: target.rootSessionId, desiredState: 'stopped', recoveryState: 'data_repair_complete', identityRevision: 2,
        intentRevision: 1, nativeImportRevision: 2, activeWriters: 0, writerClaims: [], incidentPresent: false, exportPresent: [false, false] })),
      unrelated: { incidentPresent: true, viewPresent: true, noticeIds: [], outboxEventIds: [], exportSha256: [] },
    }
    observation.mockResolvedValue(measured)
    await expect(remote.syntheticStoppedRepairBatchObservation(facts.fixtureId, 'repair-current')).resolves.toEqual(measured)
    observation.mockResolvedValue({ ...measured, operationId: 'foreign-repair' })
    await expect(remote.syntheticStoppedRepairBatchObservation(facts.fixtureId, 'repair-current')).rejects.toThrow(/operation/)
    observation.mockResolvedValue({ ...measured, fixtureId: 'foreign-fixture' })
    await expect(remote.syntheticStoppedRepairBatchObservation(facts.fixtureId, 'repair-current')).rejects.toThrow(/fixture/)
    observation.mockImplementation(async () => ({ ...measured, roots: [], launchNonce: 'private-forbidden' }))
    await expect(remote.syntheticStoppedRepairBatchObservation(facts.fixtureId, 'repair-current')).rejects.toThrow(/invalid/)
    expect(read).toHaveBeenCalledOnce()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
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
  it.each(['after_session_host_crash', 'after_provider_process_crash'] as const)(
    'retains only the fixed native recall diagnostic through capture and owner refusal (%s)', async stage => {
      const { owned, context, request } = fixture()
      const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul',
        incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
      const failure = new NativeRecoveryValidationError(stage)
      failure.message = 'private-native-response-and-credential-sentinel'
      Object.assign(failure, { cause: { text: 'private-seed-sentinel' } })
      const capture = vi.spyOn(owned, 'captureFreshNativeStage').mockImplementation(() =>
        (owned as any).trackNativeCapture(async () => { throw failure }))
      const log = vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
      const control = runner.createExternalRuntimeControl(owned, context)
      const operation = { ...request, action: 'fresh-native-stage', handle,
        nativeCollectionId: '11111111-1111-4111-8111-111111111111' }
      await expect(control(operation)).rejects.toBe(failure)
      await expect(control(operation)).rejects.toBe(failure)
      const diagnostic = { code: 'recovery_nonce_not_recalled', stage }
      expect(log).toHaveBeenCalledWith('external.native_collection_failed', {
        severity: 'warn', nativeRecoveryDiagnostic: diagnostic,
      })
      expect(log).toHaveBeenCalledWith('external.owner_operation_refused', {
        severity: 'warn', runId: context.runId, candidateSha: context.candidateSha,
        operationId: request.operationId, action: 'fresh-native-stage', reason: 'native_recovery_validation_failed',
        nativeRecoveryDiagnostic: diagnostic, soulId: handle.soulId, incarnationId: handle.incarnationId,
      })
      expect(capture).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledTimes(2)
      expect((owned as any).nativeCaptures.size).toBe(0)
      expect((owned as any).nativeCaptureFailures).toEqual(['native original capture failed'])
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-')
    },
  )
  it('keeps unclassified native capture failures free of exception text and native diagnostic lookalikes', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul',
      incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    const failure = Object.assign(new Error('private-native-response-sentinel'), {
      diagnostic: { code: 'recovery_nonce_not_recalled', stage: 'after_session_host_crash', text: 'private-seed-sentinel' },
    })
    vi.spyOn(owned, 'captureFreshNativeStage').mockImplementation(() =>
      (owned as any).trackNativeCapture(async () => { throw failure }))
    const log = vi.spyOn(owned.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    await expect(control({ ...request, action: 'fresh-native-stage', handle,
      nativeCollectionId: '11111111-1111-4111-8111-111111111111' })).rejects.toBe(failure)
    expect(log).toHaveBeenCalledWith('external.native_collection_failed', { severity: 'warn' })
    expect(log).toHaveBeenCalledWith('external.owner_operation_refused', expect.objectContaining({ reason: 'owner_operation_refused' }))
    for (const [, data] of log.mock.calls) expect(data).not.toHaveProperty('nativeRecoveryDiagnostic')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-')
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
      const git = (...args: string[]) => fixtureGit(directory, ...args)
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
  it('keeps the loss incident body private while observing its fixed file and certificate fields', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-loss-incident-'))
    try {
      const { owned, context, inventory } = fixture()
      const row = { soulId: 'incident-loss-soul', incarnationId: 'incident-loss-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'incident-loss-boot', nativeSessionId: 'incident-loss-root', provider: 'opencode', launchState: 'running', intentRevision: 4 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { phase: 5, evidenceDir: directory, lifecyclePath: path.join(directory, 'lifecycle.jsonl'), broker: { receipts: () => [receipt] } })
      owned.supervisor = { scenarioId: 'loss-owned', containerId: 'a'.repeat(64), controlSocket: '/owned/socket',
        controlSecret: 'private-owned-control', controlSecretFile: '/owned/secret', runtimeRoot: '/owned/runtime',
        volumeName: 'owned-supervisor-volume', binaryKind: 'release' }
      vi.spyOn(owned, 'controlEpoch').mockResolvedValue(12)
      const incidentId = 'incident-actual-owned'
      const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'recovery', data: {
        outcome: 'lost', incidentId, view: { cleanupState: 'verified_empty', nativeSessionId: row.nativeSessionId, intentRevision: 5 } } })
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const transport = vi.fn(async (_url: string, init: RequestInit) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      await rig.recoverLoss(rig.exactRuntimeHandle(row))
      admin.mockResolvedValue({ kind: 'incident_summary', data: { privateDiagnostic: 'private-body-marker' } })
      const source = path.join(directory, 'source-incident.json')
      const artifact = { certificateSha256: 'e'.repeat(64), certificate: {
        intentRevision: 4, nativeSessionRefHash: `sha256:${'f'.repeat(64)}` }, privateDiagnostic: 'private-body-marker' }
      await fsp.writeFile(source, JSON.stringify(artifact))
      const command = vi.spyOn(owned.runtime, 'runCommand').mockImplementation((binary, args) => {
        expect(binary).toBe('docker')
        expect(args.slice(0, 2)).toEqual(['exec', owned.supervisor.containerId])
        expect(args.at(-1)).toBe(`/var/lib/freshell-supervisor/incidents/${incidentId}.closed.json`)
        const child = args[2] === 'test' ? spawnSync('test', ['-s', source], { encoding: 'utf8' })
          : spawnSync('cat', [source], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('fixed incident file unavailable')
        return child.stdout
      })
      const observed = await rig.lossIncidentEvidence(incidentId)
      expect(observed).toMatchObject({ persisted: true, containsNativeSessionId: false, containsControlSecret: false,
        certificateSha256: artifact.certificateSha256, certificate: artifact.certificate })
      const published = path.join(directory, 'phase5-loss-incident.json')
      expect(JSON.parse(await fsp.readFile(published, 'utf8'))).toEqual(artifact)
      expect((await fsp.stat(published)).mode & 0o777).toBe(0o600)
      const digest = createHash('sha256').update(await fsp.readFile(published)).digest('hex')
      expect(observed.artifactRef).toBe(`phase5-loss-incident:${digest}`)
      expect(JSON.stringify(wire)).not.toContain('private-body-marker')
      const assertions: RuntimeLossAssertions = { schemaVersion: 2, caseId: 'P5-G02', test: { total: 1, passed: 1, failed: 0, skipped: 0 },
        identity: { provider: 'opencode', providerVersion: '1.18.21', model: 'custody-only', soulId: row.soulId,
          incarnationId: row.incarnationId, containerId: row.containerId, hostBootId: row.hostBootId,
          nativeSessionIdHash: artifact.certificate.nativeSessionRefHash, incidentId, paneId: 'owned-pane', terminalId: 'owned-terminal' },
        intent: { checkedRevision: 4, lossRevision: 4, endedRevision: 5 },
        providerState: { exactAbsenceChecks: [], credentialIntegrity: [] },
        browser: { routineNoticeCount: 0, recoveryCards: [], endedPane: {} } }
      const assertionRef = await rig.publishLossAssertions(incidentId, assertions)
      const assertionPath = path.join(directory, 'phase5-loss-assertions.json')
      const assertionBytes = await fsp.readFile(assertionPath)
      expect(JSON.parse(assertionBytes.toString())).toEqual({ ...assertions,
        candidateSha: context.candidateSha, receiptRunId: context.runId })
      expect((await fsp.stat(assertionPath)).mode & 0o777).toBe(0o600)
      expect(assertionRef.artifactRef).toBe(`phase5-loss-assertions:${createHash('sha256').update(assertionBytes).digest('hex')}`)
      await expect(owned.publishLossAssertions(incidentId, { ...assertions,
        identity: { ...assertions.identity, nativeSessionIdHash: `sha256:${'0'.repeat(64)}` } })).rejects.toThrow(/incident/)
      expect(await fsp.readFile(assertionPath)).toEqual(assertionBytes)
      command.mockClear()
      await expect(owned.lossIncidentEvidence('incident-foreign')).rejects.toThrow(/observed/)
      expect(command).not.toHaveBeenCalled()
      await fsp.writeFile(source, JSON.stringify({ ...artifact, leaked: row.nativeSessionId,
        leakedControl: owned.supervisor.controlSecret }))
      const leaked = await rig.lossIncidentEvidence(incidentId)
      expect(leaked.containsNativeSessionId).toBe(true)
      expect(leaked.containsControlSecret).toBe(true)
      const retained = await fsp.readFile(published)
      await fsp.writeFile(source, '{malformed incident')
      await expect(owned.lossIncidentEvidence(incidentId)).rejects.toThrow()
      expect(await fsp.readFile(published)).toEqual(retained)
      await fsp.unlink(source)
      await expect(owned.lossIncidentEvidence(incidentId)).rejects.toThrow(/unavailable/)
      const write = vi.spyOn(owned, 'writePhase5LossReceipt')
      await expect(owned.finalizeLossReceipt()).rejects.toThrow(/captured/)
      await rig.captureCandidateIntegrity()
      await expect(owned.finalizeLossReceipt()).rejects.toThrow(/cleanup/)
      Object.assign(owned, { stopSettlement: Promise.resolve({ ok: false, errors: ['owned cleanup fixture failure'] }) })
      await expect(owned.finalizeLossReceipt()).rejects.toThrow(/cleanup failed/)
      Object.assign(owned, { stopSettlement: Promise.resolve({ ok: true, errors: [] }) })
      await rig.stop()
      await expect(rig.finalizeLossReceipt()).rejects.toThrow()
      await expect(owned.finalizeLossReceipt()).rejects.toThrow(/candidate|ENOENT|missing/)
      expect(write).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('validates fresh-agent ingress sources on the owner checkout without a browser-selected root', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused ingress web') }, fixtureRepoRoot, 5)
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.validateFreshAgentIngressInventory()).resolves.toBeUndefined()
    await expect(control({ runId: context.runId, candidateSha: context.candidateSha, operationId: 'foreign-ingress-root',
      action: 'fresh-agent-ingresses', repoRoot: '/foreign/checkout' })).rejects.toThrow(/operation/)
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-empty-ingress-root-'))
    try {
      initializeFixtureCheckout(directory, 'Private ingress validation fixture')
      const missing = new ManagedRuntimeOwner(() => { throw new Error('unused missing ingress web') }, directory, 5)
      await expect(missing.validateFreshAgentIngressInventory()).rejects.toThrow()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('refuses fresh-agent receipt publication for unregistered or custody-only observations after cleanup', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-fresh-receipt-'))
    try {
      initializeFixtureCheckout(directory, 'Private fresh receipt refusal fixture')
      const owned = new ManagedRuntimeOwner(() => { throw new Error('unused fresh receipt web') }, directory, 5,
        {}, {}, 'release', { enabledProviders: [], providerSettings: {}, freshAgentModes: ['freshcodex'] })
      vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
      const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const row: FreshAgentQualificationRow = { mode: 'freshcodex', provider: 'codex', providerVersion: '0.147.0',
        model: 'gpt-5.6-luna', effort: 'low', runtimeVariant: 'codex-app-server', actualProviderProcess: true,
        fixtureTransport: false, ingresses: [], soulId: 'unqualified-fresh-soul', nativeSessionId: 'unqualified-fresh-root',
        providerStoreId: 'unqualified-fresh-store', completedNativeTurns: [], noToolRecall: false,
        crashes: { web: [], host: [] }, pendingApproval: { supported: false },
        writerProof: { activeWriterCount: 0, conflictingWriterCount: 0, dispatchCountForPrompt: 0, completionCountForPrompt: 0 },
        isolation: { providerVolumeNameHash: 'c'.repeat(64), enclosureIdHash: 'd'.repeat(64),
          independentProviderStore: false, independentEnclosure: false },
        limits: { cpuMax: 'fixture', memoryMax: 'fixture', swapMax: 'fixture', pidsMax: 'fixture' },
        oldEnclosure: { verifiedEmptyBeforeResume: false, writerClaimReleasedBeforeResume: false } }
      await expect(rig.publishFreshAgentQualification([row])).rejects.toThrow()
      const finalize = vi.spyOn(owned, 'finalizeFreshAgentQualificationReceipt')
      await expect(owned.publishFreshAgentQualification([{ ...row, mode: 'freshclaude' }])).rejects.toThrow(/registered/)
      await expect(owned.publishFreshAgentQualification([row, row])).rejects.toThrow(/registered/)
      await expect(control({ runId: context.runId, candidateSha: context.candidateSha, operationId: 'foreign-fresh-receipt-path',
        action: 'fresh-agent-receipt', freshAgentObservations: [row], outputPath: '/foreign/receipt.json' })).rejects.toThrow(/operation/)
      await expect(owned.publishFreshAgentQualification([row])).rejects.toThrow(/cleanup/)
      Object.assign(owned, { stopSettlement: Promise.resolve({ ok: false, errors: ['cleanup fixture failure'] }) })
      await expect(owned.publishFreshAgentQualification([row])).rejects.toThrow(/cleanup failed/)
      expect(finalize).not.toHaveBeenCalled()
      Object.assign(owned, { stopSettlement: Promise.resolve({ ok: true, errors: [] }) })
      await rig.stop()
      await expect(rig.publishFreshAgentQualification([row])).rejects.toThrow()
      await expect(owned.publishFreshAgentQualification([row])).rejects.toThrow(/runtime image must be an exact sha256 digest/)
      // A hash-shaped fixture value still supplies no native/build/broker evidence.
      Object.assign(owned.runtime, { imageRef: `sha256:${'0'.repeat(64)}` })
      const boundEvidenceDir = owned.runtime.evidenceDir
      Object.assign(owned.runtime, { evidenceDir: directory })
      await expect(owned.publishFreshAgentQualification([row])).rejects.toThrow(/candidate-bound/)
      Object.assign(owned.runtime, { evidenceDir: boundEvidenceDir })
      await expect(owned.publishFreshAgentQualification([row])).rejects.toThrow(/ENOENT|missing|selected|turn|ingress/)
      expect(finalize).toHaveBeenCalled()
      await expect(fsp.lstat(path.join(owned.runtime.browserDir, 'fresh-agent-qualification.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('routes provider publication after cleanup while refusing unregistered and custody-only rows', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused provider receipt web') }, fixtureRepoRoot, 5)
    vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      try { return new Response(JSON.stringify(await control(JSON.parse(String(init.body)))), { status: 200 }) }
      catch { return new Response(JSON.stringify({ error: 'runtime_owner_refused' }), { status: 409 }) }
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    const row: ProviderQualificationRow = { provider: 'opencode', modes: ['opencode'], providerVersion: '1.18.21',
      model: 'openai/gpt-5.6-luna', reasoningEffort: 'provider-default', nativeSessionId: 'custody-only-root',
      nonceSha256: 'e'.repeat(64), nativeTurnProofs: [
        { schemaVersion: 2, stage: 'initial', nativeSessionId: 'custody-only-root',
          nativeEvidence: { kind: 'identified_message', turnId: 'custody-turn', messageId: 'custody-message', parentMessageId: null },
          completedAt: 1, responseSha256: 'f'.repeat(64), responseContainsNonce: true, toolCallCount: 0, toolCallTypes: [],
          resolvedProvider: 'fixture', resolvedModel: 'fixture', resolvedReasoningEffort: 'fixture',
          providerProvenance: 'fixture', modelProvenance: 'fixture', reasoningEffortProvenance: 'fixture' },
        { schemaVersion: 2, stage: 'after_session_host_crash', nativeSessionId: 'custody-only-root',
          nativeEvidence: { kind: 'append_only_record', recordIndex: 0, byteStart: 1, byteEnd: 2,
            recordSha256: '1'.repeat(64), prefixSha256Before: '2'.repeat(64), completionEventOrdinal: 0, completionEventSha256: '3'.repeat(64) },
          completedAt: 'fixture', responseSha256: 'f'.repeat(64), responseContainsNonce: true, toolCallCount: 0, toolCallTypes: [],
          resolvedProvider: 'fixture', resolvedModel: 'fixture', resolvedReasoningEffort: 'fixture',
          providerProvenance: 'fixture', modelProvenance: 'fixture', reasoningEffortProvenance: 'fixture' },
      ], actualProviderBinary: false, completedTurn: false,
      nativeStateCaptured: false, runtimeOwned: false, limitsVerified: false, swapMaxVerified: false,
      limitEvidence: { cpuMax: 'fixture', memoryMax: 'fixture', swapMax: 'fixture', pidsMax: 'fixture' },
      automaticResume: false, profileVerified: false, releaseBinary: false, nativeRecovery: false,
      exactNativeRecovery: false, sameNativeSession: false, followUpCompleted: false, onlyOneWriter: false,
      writerClaim: { provider: 'opencode', providerStoreId: 'custody-store', nativeSessionId: 'custody-only-root',
        soulId: 'custody-soul', incarnationId: 'custody-incarnation', activeClaimCount: 0, globalConflictingClaimCount: 0 },
      oldEnclosureVerifiedEmpty: false, verifiedEmptyOrdering: { stopOutcome: 'verified_empty',
        activeClaimCountAfterStop: 0, globalConflictingClaimCountAfterStop: 0, oldContainerRunningAfterStop: false },
      lostNoticeCount: 0, crashKinds: [], nonceRecovery: { sameSoul: false, sameNativeSession: false,
        newIncarnation: false, oldEnclosureVerifiedEmpty: false, recalledNonce: false, followUpCompleted: false,
        workspaceOrToolReadUsed: false }, repairedSameSoul: false, repairedSameNativeSession: false,
      blockers: [{ reason: 'fixture', outcome: 'blocked', lost: false }], blockerEvidence: ['fixture'] }
    const finalize = vi.spyOn(owned, 'finalizeProviderQualificationReceipt')
    await expect(owned.publishProviderQualification([row])).rejects.toThrow(/cleanup/)
    await expect(owned.publishProviderQualification([{ ...row, provider: 'codex' }])).rejects.toThrow(/registered/)
    await expect(owned.publishProviderQualification([row, row])).rejects.toThrow(/registered/)
    Object.assign(owned, { stopSettlement: Promise.resolve({ ok: false, errors: ['fixture cleanup failure'] }) })
    await expect(owned.publishProviderQualification([row])).rejects.toThrow(/cleanup failed/)
    expect(finalize).not.toHaveBeenCalled()
    Object.assign(owned, { stopSettlement: Promise.resolve({ ok: true, errors: [] }) })
    await rig.stop()
    await expect(rig.publishProviderQualification([row])).rejects.toThrow(/refused: 409/)
    expect(finalize).toHaveBeenCalledExactlyOnceWith([row])
    await expect(control({ runId: context.runId, candidateSha: context.candidateSha, operationId: 'foreign-provider-path',
      action: 'provider-receipt', providerObservations: [row], outputPath: '/foreign/receipt.json' })).rejects.toThrow(/operation/)
    await expect(rig.publishProviderQualification([{ ...row, transcript: 'private conversation' }])).rejects.toThrow()
    expect(finalize).toHaveBeenCalledTimes(1)
    await expect(owned.publishProviderQualification([row])).rejects.toThrow(/run manifest is missing/)
  })
  it('observes current owner broker counts and supervisor identity without exposing receipts or secrets', async () => {
    const { owned, context, request } = fixture()
    owned.supervisor = { scenarioId: 'facts-owned', containerId: 'a'.repeat(64), controlSocket: '/owned/socket',
      controlSecret: 'private-facts-control', controlSecretFile: '/owned/secret', runtimeRoot: '/owned/runtime',
      volumeName: 'owned-facts-volume', binaryKind: 'release' }
    const receipt: BrokerReceipt = { containerId: 'b'.repeat(64), soulId: 'facts-soul', incarnationId: 'facts-incarnation',
      createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: '/private/facts/runtime' }
    const receipts = [receipt]
    const attempts: string[] = []
    Object.assign(owned.runtime, { broker: { receipts: () => receipts, unsafeAttempts: () => attempts } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const reply = await control(JSON.parse(String(init.body)))
      wire.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    await expect(rig.ownershipFacts()).resolves.toEqual({ receiptCount: 1, unsafeBrokerAttempts: 0,
      supervisorContainerId: owned.supervisor.containerId, supervisorBinaryKind: 'release' })
    receipts.push({ ...receipt, containerId: 'e'.repeat(64) })
    attempts.push('private unsafe attempt fixture')
    owned.supervisor = { ...owned.supervisor, containerId: 'f'.repeat(64), binaryKind: 'test' }
    await expect(rig.ownershipFacts()).resolves.toEqual({ receiptCount: 2, unsafeBrokerAttempts: 1,
      supervisorContainerId: owned.supervisor.containerId, supervisorBinaryKind: 'test' })
    expect(JSON.stringify(wire)).not.toContain('private')
    expect(JSON.stringify(wire)).not.toContain('facts-soul')
    await expect(control({ ...request, action: 'ownership-facts', containerId: '0'.repeat(64) })).rejects.toThrow(/operation/)
    owned.supervisor = { ...owned.supervisor, containerId: 'short-container' }
    await expect(owned.ownershipFacts()).rejects.toThrow()
  })
  it('reads the fixed terminal child marker once and keeps probing its original observed PID', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-terminal-child-'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'child-soul', incarnationId: 'child-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'child-boot', provider: 'shell', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const marker = path.join(directory, 'child-pid')
      const read = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        const command = args[2].replace('/home/freshell/provider/p2-child-pid', '$TEST_TERMINAL_PID_FILE')
        const child = spawnSync('sh', ['-lc', command], { encoding: 'utf8', env: { ...process.env, TEST_TERMINAL_PID_FILE: marker } })
        if (child.status !== 0) throw new Error('private child marker read failed')
        return child.stdout
      })
      const probe = vi.spyOn(owned.runtime, 'execOwnedContainerExact').mockImplementation((containerId, args) => {
        expect(containerId).toBe(row.containerId)
        const child = spawnSync('sh', args.slice(1), { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private process observation failed')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const enclosure = rig.runtimeEnclosureHandle(row)
      await expect(rig.terminalChildFacts(enclosure)).resolves.toEqual({ pid: null, running: false })
      await fsp.writeFile(marker, 'not a pid')
      await expect(rig.terminalChildFacts(enclosure)).resolves.toEqual({ pid: null, running: false })
      expect(probe).not.toHaveBeenCalled()
      await fsp.writeFile(marker, String(process.pid))
      await expect(rig.terminalChildFacts(enclosure)).resolves.toEqual({ pid: process.pid, running: true })
      read.mockClear()
      await fsp.writeFile(marker, '2147483647')
      await expect(rig.terminalChildFacts(enclosure)).resolves.toEqual({ pid: process.pid, running: true })
      expect(read).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement-boot' }])
      probe.mockClear()
      await expect(owned.terminalChildFacts(enclosure)).rejects.toThrow(/current/)
      await expect(control({ ...request, action: 'terminal-child-facts', enclosure, pid: 1 })).rejects.toThrow(/operation/)
      expect(probe).not.toHaveBeenCalled()
      const replacement = rig.runtimeEnclosureHandle({ ...row, hostBootId: 'replacement-boot' })
      await expect(rig.terminalChildFacts(replacement)).resolves.toEqual({ pid: 2147483647, running: false })
      Object.assign(owned.runtime, { phase: 3 })
      read.mockClear()
      probe.mockClear()
      await expect(owned.terminalChildFacts(replacement)).rejects.toThrow(/Phase 2/)
      expect(read).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('publishes continuity observations only to owner-selected receipt files with current identity and provenance', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-continuity-receipt-'))
    vi.stubEnv('FRESHELL_RUNTIME_BROWSER_RECEIPT', path.join(directory, 'shell.json'))
    vi.stubEnv('FRESHELL_RUNTIME_OPENCODE_RECEIPT', path.join(directory, 'opencode.json'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'receipt-soul', incarnationId: 'receipt-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'receipt-boot', nativeSessionId: 'ses_receipt', provider: 'shell', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { imageRef: receipt.imageRef, broker: { receipts: () => [receipt] } })
      const shell = { caseId: 'P2-G01' as const, status: 'PASS' as const, restartCycles: 10 as const,
        soulId: row.soulId, incarnationId: row.incarnationId, containerId: row.containerId, hostBootId: row.hostBootId,
        childPid: 123, outputAdvanced: true as const, inputUsable: true as const, viewAssociations: 1 as const,
        createRequestId: 'request-owned', terminalId: 'terminal-owned' }
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const enclosure = rig.runtimeEnclosureHandle(row)
      const result = await rig.publishTerminalContinuityReceipt(enclosure, shell)
      const bytes = await fsp.readFile(path.join(directory, 'shell.json'))
      expect(result).toEqual({ artifactRef: `terminal-continuity-receipt:${createHash('sha256').update(bytes).digest('hex')}` })
      expect(JSON.parse(bytes.toString())).toEqual({ ...shell, candidateSha: context.candidateSha, runtimeImage: receipt.imageRef })
      expect((await fsp.stat(path.join(directory, 'shell.json'))).mode & 0o777).toBe(0o600)
      const native = { caseId: 'P2-G04' as const, status: 'PASS' as const, provider: 'opencode' as const,
        modelProvider: 'openai', opencodeVersion: '1.18.21', model: 'openai/gpt-5.4', resolvedModel: 'gpt-5.4',
        freeTier: false as const, nativeSessionId: row.nativeSessionId, sameNativeSession: true as const,
        sameIncarnation: true as const, soulId: row.soulId, incarnationId: row.incarnationId,
        containerId: row.containerId, hostBootId: row.hostBootId, toolCompletionCount: 1 as const,
        followupSucceeded: true as const, providerLaunchCount: 1 as const }
      inventory.mockResolvedValue([{ ...row, provider: 'opencode' }])
      await rig.publishTerminalContinuityReceipt(enclosure, native)
      expect(JSON.parse(await fsp.readFile(path.join(directory, 'opencode.json'), 'utf8'))).toEqual({ ...native,
        candidateSha: context.candidateSha, runtimeImage: receipt.imageRef })
      expect(JSON.stringify(wire)).not.toContain(directory)
      await expect(owned.publishTerminalContinuityReceipt(enclosure, { ...native, providerLaunchCount: 2 })).rejects.toThrow(/one observed provider launch/)
      await expect(owned.publishTerminalContinuityReceipt(enclosure, { ...native, nativeSessionId: 'ses_foreign' })).rejects.toThrow(/current.*root/)
      await expect(owned.publishTerminalContinuityReceipt(enclosure, { ...shell, hostBootId: 'foreign' })).rejects.toThrow(/identity/)
      await expect(control({ ...request, action: 'terminal-continuity-receipt', enclosure, continuityObservation: shell, path: '/foreign' })).rejects.toThrow(/operation/)
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(owned.publishTerminalContinuityReceipt(enclosure, shell)).rejects.toThrow(/current/)
    } finally { vi.unstubAllEnvs(); await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('captures fixed terminal continuity diagnostics privately and returns their actual artifact hash', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-terminal-diagnostics-'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'diagnostic-soul', incarnationId: 'diagnostic-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'diagnostic-boot', provider: 'shell', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { evidenceDir: directory, broker: { receipts: () => [receipt] } })
      Object.assign(owned, { web: { capturedOutput: () => ({ stdout: 'private web stdout', stderr: 'private web stderr' }) } })
      const processes = vi.spyOn(owned, 'ownedContainerProcessTable').mockReturnValue('private owned process table')
      const logs = vi.spyOn(owned.runtime, 'containerLogs').mockReturnValue('private owned host log')
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const enclosure = rig.runtimeEnclosureHandle(row)
      const result = await rig.captureTerminalContinuityDiagnostics(enclosure)
      const filename = path.join(directory, 'terminal-continuity-diagnostics.json')
      const bytes = await fsp.readFile(filename)
      expect(result).toEqual({ artifactRef: `terminal-continuity-diagnostics:${createHash('sha256').update(bytes).digest('hex')}` })
      expect((await fsp.stat(filename)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(bytes.toString())).toMatchObject({ runId: context.runId, candidateSha: context.candidateSha,
        containerId: row.containerId, hostBootId: row.hostBootId, ownedProcesses: 'private owned process table',
        hostLogsTail: 'private owned host log', webStdoutTail: 'private web stdout', webStderrTail: 'private web stderr' })
      expect(JSON.stringify(wire)).not.toContain('private')
      logs.mockImplementationOnce(() => { throw new Error('owned host log read failed') })
      await expect(owned.captureTerminalContinuityDiagnostics(enclosure)).rejects.toThrow(/host log read failed/)
      processes.mockClear(); logs.mockClear()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(owned.captureTerminalContinuityDiagnostics(enclosure)).rejects.toThrow(/current/)
      await expect(control({ ...request, action: 'terminal-continuity-diagnostics', enclosure, path: '/foreign' })).rejects.toThrow(/operation/)
      expect(processes).not.toHaveBeenCalled()
      expect(logs).not.toHaveBeenCalled()
      Object.assign(owned.runtime, { phase: 3 })
      await expect(owned.captureTerminalContinuityDiagnostics(enclosure)).rejects.toThrow(/Phase 2/)
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('observes only fixed current terminal web-cycle markers through the owner', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-terminal-cycle-'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'cycle-soul', incarnationId: 'cycle-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'cycle-boot', provider: 'shell', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const read = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        const command = args[2].replace('/home/freshell/provider/', `${directory}/`)
        const child = spawnSync('sh', ['-lc', command], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private cycle marker read failed')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const enclosure = rig.runtimeEnclosureHandle(row)
      await expect(rig.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_1_123')).resolves.toBe(false)
      await fsp.writeFile(path.join(directory, 'p2-web-cycle-1'), 'private unrelated marker')
      await expect(rig.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_1_123')).resolves.toBe(false)
      await fsp.writeFile(path.join(directory, 'p2-web-cycle-1'), 'P2_WEB_CYCLE_1_123\n')
      await expect(rig.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_1_123')).resolves.toBe(true)
      await fsp.writeFile(path.join(directory, 'p2-web-cycle-10'), 'P2_WEB_CYCLE_10_456')
      await expect(rig.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_10_456')).resolves.toBe(true)
      expect(JSON.stringify(wire)).not.toContain('private')
      read.mockClear()
      await expect(owned.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_11_789')).rejects.toThrow(/cycle/)
      await expect(owned.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_1_123; arbitrary')).rejects.toThrow(/cycle/)
      await expect(control({ ...request, action: 'terminal-web-cycle', enclosure, challengeId: 'P2_WEB_CYCLE_1_123', path: '/foreign' })).rejects.toThrow(/operation/)
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(owned.terminalWebCycleCompleted(enclosure, 'P2_WEB_CYCLE_1_123')).rejects.toThrow(/current/)
      expect(read).not.toHaveBeenCalled()
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('reads the original native continuity READY reply on the owner and returns only resolved model facts', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-continuity-reply-'))
    const filename = path.join(directory, 'opencode.db')
    const db = new DatabaseSync(filename)
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'reply-soul', incarnationId: 'reply-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'reply-boot', nativeSessionId: 'ses_reply', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      db.exec('CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)')
      db.prepare('INSERT INTO session VALUES (?)').run(row.nativeSessionId)
      db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg_reply', row.nativeSessionId, 1,
        JSON.stringify({ role: 'assistant', time: { completed: 1 }, providerID: 'openai', modelID: 'gpt-5.4' }))
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part_reply', row.nativeSessionId, 'msg_reply', 1,
        JSON.stringify({ type: 'text', text: 'private unrelated reply' }))
      const read = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        const child = spawnSync(process.execPath, [...args.slice(1, -2), filename, args[args.length - 1]], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private native reply read failed')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const handle = rig.exactRuntimeHandle(row)
      await expect(rig.openCodeContinuityFirstReply(handle)).resolves.toBeNull()
      db.prepare('UPDATE part SET data=?').run(JSON.stringify({ type: 'text', text: 'private READY response body' }))
      await expect(rig.openCodeContinuityFirstReply(handle)).resolves.toEqual({ resolvedProvider: 'openai', resolvedModel: 'gpt-5.4' })
      expect(JSON.stringify(wire)).not.toContain('private')
      expect(JSON.stringify(wire)).not.toContain('msg_reply')
      read.mockResolvedValueOnce(JSON.stringify({ nativeSessionId: 'ses_other', turns: [
        { text: 'READY', resolvedProvider: 'openai', resolvedModel: 'gpt-5.4' },
      ] }))
      await expect(rig.openCodeContinuityFirstReply(handle)).resolves.toBeNull()
      read.mockResolvedValueOnce('{"turns":')
      await expect(rig.openCodeContinuityFirstReply(handle)).rejects.toThrow()
      read.mockClear()
      inventory.mockResolvedValue([{ ...row, provider: 'codex' }])
      await expect(owned.openCodeContinuityFirstReply(handle)).rejects.toThrow(/OpenCode/)
      inventory.mockResolvedValue([{ ...row, nativeSessionId: 'ses_replacement' }])
      await expect(owned.openCodeContinuityFirstReply(handle)).rejects.toThrow(/current/)
      await expect(control({ ...request, action: 'opencode-continuity-first-reply', handle, sql: 'arbitrary' })).rejects.toThrow(/operation/)
      expect(read).not.toHaveBeenCalled()
      Object.assign(owned.runtime, { phase: 3 })
      await expect(owned.openCodeContinuityFirstReply(handle)).rejects.toThrow(/Phase 2/)
    } finally { db.close(); await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('observes the fixed OpenCode continuity startup checks without returning auth or process bodies', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-opencode-startup-'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'startup-soul', incarnationId: 'startup-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'startup-boot', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const auth = path.join(directory, 'unit-auth.json'), ca = path.join(directory, 'unit-ca.txt')
      await fsp.writeFile(auth, JSON.stringify({ openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.now() + 7_200_000 } }))
      await fsp.writeFile(ca, 'private CA readability fixture; never used for TLS')
      const mapper = path.join(directory, 'map-startup-files.cjs')
      await fsp.writeFile(mapper, `const fs=require('node:fs');const read=fs.readFileSync,access=fs.accessSync;fs.readFileSync=function(file,...args){return read.call(fs,file==='/home/freshell/provider/.local/share/opencode/auth.json'?${JSON.stringify(auth)}:file,...args)};fs.accessSync=function(file,...args){return access.call(fs,file==='/home/freshell/provider/.config/onecli/gateway-ca.pem'?${JSON.stringify(ca)}:file,...args)};`)
      let models = 'openai/gpt-5.6-luna\n', processes = '42 opencode --model openai/gpt-5.6-luna --hostname 127.0.0.1 --port 4096'
      const provider = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        if (args[0] === 'opencode') { expect(args).toEqual(['opencode', 'models', 'openai']); return models }
        const child = spawnSync(process.execPath, ['--require', mapper, ...args.slice(1)], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('owned auth probe refused')
        return child.stdout
      })
      const container = vi.spyOn(owned, 'ownedContainerExec').mockImplementation(() => processes)
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const transport = vi.fn(async (_url: string, init: RequestInit) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const enclosure = rig.runtimeEnclosureHandle(row)
      await expect(rig.openCodeContinuityStartupFacts(enclosure)).resolves.toEqual({ authPresent: true, modelAvailable: true,
        explicitModelArg: true, loopbackHostname: true, explicitPort: true })
      models = 'different model'; processes = 'different process'
      await expect(rig.openCodeContinuityStartupFacts(enclosure)).resolves.toEqual({ authPresent: true, modelAvailable: false,
        explicitModelArg: false, loopbackHostname: false, explicitPort: false })
      expect(JSON.stringify(wire)).not.toContain('onecli-managed')
      expect(JSON.stringify(wire)).not.toContain('opencode --model')
      await fsp.writeFile(auth, JSON.stringify({ openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: 0 } }))
      await expect(owned.openCodeContinuityStartupFacts(enclosure)).rejects.toThrow(/auth probe refused/)
      provider.mockClear(); container.mockClear()
      inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
      await expect(owned.openCodeContinuityStartupFacts(enclosure)).rejects.toThrow(/OpenCode/)
      await expect(control({ ...request, action: 'opencode-continuity-startup', enclosure, command: ['arbitrary'] })).rejects.toThrow(/operation/)
      expect(provider).not.toHaveBeenCalled(); expect(container).not.toHaveBeenCalled()
      inventory.mockResolvedValue([row])
      Object.assign(owned.runtime, { phase: 3 })
      await expect(owned.openCodeContinuityStartupFacts(enclosure)).rejects.toThrow(/Phase 2/)
      expect(provider).not.toHaveBeenCalled(); expect(container).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })
  it('publishes only fixed readiness diagnostic metadata to the owner private artifact', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-readiness-diagnostic-'))
    try {
      const { owned, context, inventory, request } = fixture()
      Object.assign(owned.runtime, { phase: 5, browserDir: directory })
      const row = { soulId: 'diagnostic-soul', incarnationId: 'diagnostic-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'diagnostic-boot', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const diagnostic = { soulId: row.soulId, incarnationId: row.incarnationId, terminalId: 'owned-terminal',
        stableLaunchStreamId: 'stable-launch-stream', paneStreamId: 'browser-stream', browserInputReady: false,
        browserModelBanner: true, observedStreamChanges: [{ terminalId: 'owned-terminal', streamId: 'browser-stream',
          reason: 'host_replacement', attachRequestId: null }], observedWebSocketFrameTypes: ['ready'], observedWebSocketCount: 1 }
      const control = runner.createExternalRuntimeControl(owned, context)
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const enclosure = rig.runtimeEnclosureHandle(row)
      const result = await rig.publishOpenCodeReadinessDiagnostic(enclosure, diagnostic)
      const filename = path.join(directory, 'opencode-replacement-readiness.json')
      const bytes = await fsp.readFile(filename)
      expect(result).toEqual({ artifactRef: `opencode-replacement-readiness:${createHash('sha256').update(bytes).digest('hex')}` })
      expect(JSON.parse(bytes.toString())).toEqual(diagnostic)
      expect((await fsp.stat(filename)).mode & 0o777).toBe(0o600)
      await expect(owned.publishOpenCodeReadinessDiagnostic(enclosure, { ...diagnostic, soulId: 'foreign-soul' })).rejects.toThrow(/identity/)
      await expect(control({ ...request, action: 'opencode-readiness-diagnostic', enclosure,
        qualificationDiagnostic: { ...diagnostic, transcript: 'private body' } })).rejects.toThrow(/operation/)
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(owned.publishOpenCodeReadinessDiagnostic(enclosure, diagnostic)).rejects.toThrow(/current/)
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('selects and hashes the existing qualification native turn on the owner without returning response bodies', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-qualification-proof-'))
    const filename = path.join(directory, 'opencode.db')
    const db = new DatabaseSync(filename)
    try {
      const { owned, context, inventory, request } = fixture()
      Object.assign(owned.runtime, { phase: 5 })
      const row = { soulId: 'proof-soul', incarnationId: 'proof-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'proof-boot', nativeSessionId: 'ses_proof', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      const other = { ...row, soulId: 'other-soul', incarnationId: 'other-incarnation', containerId: 'c'.repeat(64),
        hostBootId: 'other-boot', nativeSessionId: 'ses_other' }
      inventory.mockResolvedValue([row, other])
      const receipts: BrokerReceipt[] = [row, other].map(view => ({ containerId: view.containerId, soulId: view.soulId,
        incarnationId: view.incarnationId, createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64),
        imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }))
      Object.assign(owned.runtime, { broker: { receipts: () => receipts } })
      const nonce = `p-${'A'.repeat(22)}`, otherNonce = `p-${'B'.repeat(22)}`
      let text = `${nonce} private native response body`
      db.exec('CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)')
      db.prepare('INSERT INTO session VALUES (?)').run(row.nativeSessionId)
      for (const [order, id] of ['msg_old', 'msg_fresh'].entries()) {
        db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, row.nativeSessionId, order + 1,
          JSON.stringify({ role: 'assistant', time: { completed: order + 1 }, providerID: 'openai', modelID: 'gpt-5.6-luna' }))
        db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(`part_${id}`, row.nativeSessionId, id, order + 1,
          JSON.stringify({ type: 'text', text }))
      }
      const read = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        const child = spawnSync(process.execPath, [...args.slice(1, -2), filename, args[args.length - 1]], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private native turn probe failed')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const handle = rig.exactRuntimeHandle(row)
      const challenge = await rig.registerOpenCodeQualificationNonce(handle, nonce)
      const otherChallenge = await rig.registerOpenCodeQualificationNonce(rig.exactRuntimeHandle(other), otherNonce)
      const result = await rig.openCodeQualificationTurn(handle, challenge.challengeId, 'initial', ['msg_old'], otherChallenge.challengeId)
      expect(result).toMatchObject({ messageId: 'msg_fresh', containsOtherNonce: false,
        proof: { schemaVersion: 2, stage: 'initial', nativeSessionId: row.nativeSessionId,
          nativeEvidence: { kind: 'identified_message', messageId: 'msg_fresh', turnId: 'msg_fresh' },
          responseSha256: createHash('sha256').update(text).digest('hex'), responseContainsNonce: true,
          toolCallCount: 0, toolCallTypes: [], resolvedProvider: 'openai', resolvedModel: 'gpt-5.6-luna' } })
      await expect(rig.openCodeQualificationTurn(handle, challenge.challengeId, 'initial', ['msg_old', 'msg_fresh'])).resolves.toBeNull()
      text += ` ${otherNonce}`
      db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({ type: 'text', text }), 'part_msg_fresh')
      expect(await rig.openCodeQualificationTurn(handle, challenge.challengeId, 'after_session_host_crash', ['msg_old'], otherChallenge.challengeId))
        .toMatchObject({ containsOtherNonce: true, proof: { stage: 'after_session_host_crash' } })
      db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part_tool', row.nativeSessionId, 'msg_fresh', 3,
        JSON.stringify({ type: 'tool', tool: 'bash' }))
      await expect(rig.openCodeQualificationTurn(handle, challenge.challengeId, 'initial', ['msg_old'])).resolves.toBeNull()
      expect(JSON.stringify(wire)).not.toContain('private native response')
      expect(JSON.stringify(wire)).not.toContain(nonce)
      expect(JSON.stringify(wire)).not.toContain(otherNonce)
      read.mockClear()
      await expect(owned.openCodeQualificationTurn(handle, 'unknown-challenge', 'initial', [])).rejects.toThrow(/registered/)
      await expect(control({ ...request, action: 'opencode-qualification-turn', handle, challengeId: challenge.challengeId,
        qualificationProofStage: 'arbitrary', priorMessageIds: [] })).rejects.toThrow(/operation/)
      inventory.mockResolvedValue([{ ...row, nativeSessionId: 'ses_replacement' }, other])
      await expect(owned.openCodeQualificationTurn(handle, challenge.challengeId, 'initial', [])).rejects.toThrow(/current/)
      expect(read).not.toHaveBeenCalled()
    } finally { db.close(); await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('registers only the fixed qualification nonce shape against the exact current native root', async () => {
    const { owned, context, inventory, request } = fixture()
    Object.assign(owned.runtime, { phase: 5 })
    const row = { soulId: 'nonce-soul', incarnationId: 'nonce-incarnation', containerId: 'b'.repeat(64),
      hostBootId: 'nonce-boot', nativeSessionId: 'ses_nonce', provider: 'opencode', launchState: 'running', intentRevision: 1 }
    inventory.mockResolvedValue([row])
    const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
      createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: '/private/nonce/runtime' }
    Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
    const nonce = `p-${'A'.repeat(22)}`
    const read = vi.spyOn(owned, 'ownedProviderExec').mockResolvedValue(JSON.stringify({ requestIds: [], resultIds: [], replayCount: 0 }))
    const control = runner.createExternalRuntimeControl(owned, context)
    const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const handle = rig.exactRuntimeHandle(row)
    const registered = await rig.registerOpenCodeQualificationNonce(handle, nonce)
    expect(registered.challengeId).toMatch(/^[a-f0-9-]{36}$/)
    const operation = { ...request, action: 'opencode-qualification-nonce', handle, qualificationNonce: nonce }
    expect(await control(operation)).toEqual(await control(operation))
    await expect(rig.nativeToolEvidence(handle, registered.challengeId)).resolves.toEqual({ requestIds: [], resultIds: [], replayCount: 0 })
    expect(read.mock.calls[0][1].at(-1)).toBe(nonce)
    read.mockClear()
    await expect(owned.registerOpenCodeQualificationNonce(handle, 'arbitrary response text')).rejects.toThrow(/nonce/)
    await expect(control({ ...request, action: 'opencode-qualification-nonce', handle, qualificationNonce: nonce, path: '/foreign' })).rejects.toThrow(/operation/)
    inventory.mockResolvedValue([{ ...row, nativeSessionId: 'ses_replacement' }])
    await expect(owned.registerOpenCodeQualificationNonce(handle, nonce)).rejects.toThrow(/current/)
    await expect(owned.nativeToolEvidence(handle, registered.challengeId)).rejects.toThrow(/current/)
    inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
    await expect(owned.registerOpenCodeQualificationNonce(handle, nonce)).rejects.toThrow(/OpenCode/)
    Object.assign(owned.runtime, { phase: 2 })
    await expect(owned.registerOpenCodeQualificationNonce(handle, nonce)).rejects.toThrow(/Phase 5/)
    expect(read).not.toHaveBeenCalled()
  })
  it('reads qualification native assistant message IDs on the exact owner root without returning bodies', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-qualification-message-ids-'))
    const filename = path.join(directory, 'opencode.db')
    const db = new DatabaseSync(filename)
    try {
      const { owned, context, inventory, request } = fixture()
      Object.assign(owned.runtime, { phase: 5 })
      const row = { soulId: 'ids-soul', incarnationId: 'ids-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'ids-boot', nativeSessionId: 'ses_ids', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      db.exec('CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)')
      db.prepare('INSERT INTO session VALUES (?)').run(row.nativeSessionId)
      const insert = (id: string, order: number) => {
        db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, row.nativeSessionId, order,
          JSON.stringify({ role: 'assistant', time: { completed: order }, providerID: 'openai', modelID: 'gpt-5.6-luna' }))
        db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(`part_${id}`, row.nativeSessionId, id, order,
          JSON.stringify({ type: 'text', text: 'private native response body' }))
      }
      insert('msg_second', 2); insert('msg_first', 1)
      const read = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        const child = spawnSync(process.execPath, [...args.slice(1, -2), filename, args[args.length - 1]], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private native ID probe failed')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const handle = rig.exactRuntimeHandle(row)
      await expect(rig.openCodeQualificationAssistantMessageIds(handle)).resolves.toEqual(['msg_first', 'msg_second'])
      insert('msg_third', 3)
      await expect(rig.openCodeQualificationAssistantMessageIds(handle)).resolves.toEqual(['msg_first', 'msg_second', 'msg_third'])
      expect(JSON.stringify(wire)).not.toContain('private')
      expect(JSON.stringify(wire)).not.toContain('resolvedModel')
      read.mockResolvedValueOnce(JSON.stringify({ schemaVersion: 1, nativeSessionId: row.nativeSessionId, turns: [{ messageId: '' }] }))
      await expect(owned.openCodeQualificationAssistantMessageIds(handle)).rejects.toThrow()
      read.mockResolvedValueOnce(JSON.stringify({ schemaVersion: 1, nativeSessionId: 'ses_foreign', turns: [{ messageId: 'msg_fake' }] }))
      await expect(owned.openCodeQualificationAssistantMessageIds(handle)).rejects.toThrow()
      read.mockClear()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(owned.openCodeQualificationAssistantMessageIds(handle)).rejects.toThrow(/current/)
      await expect(control({ ...request, action: 'opencode-qualification-message-ids', handle, sql: 'arbitrary' })).rejects.toThrow(/operation/)
      expect(read).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
      await expect(owned.openCodeQualificationAssistantMessageIds(handle)).rejects.toThrow(/OpenCode/)
      Object.assign(owned.runtime, { phase: 2 })
      await expect(owned.openCodeQualificationAssistantMessageIds(handle)).rejects.toThrow(/Phase 5/)
    } finally { db.close(); await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('counts only the fixed qualification notices at the current epoch without returning notice bodies', async () => {
    const { owned, context, request } = fixture()
    Object.assign(owned.runtime, { phase: 5 })
    const epoch = vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'pending_notices', data: [] })
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
      const reply = await control(JSON.parse(String(init.body)))
      wire.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    await expect(rig.openCodeQualificationNoticeCount()).resolves.toBe(0)
    expect(admin).toHaveBeenCalledWith(owned.supervisor, { method: 'pending_notices', params: {
      profileId: 'profile:opencode-provider-qualification', limit: 100, expectedControlEpoch: 4 } })
    epoch.mockResolvedValue(9)
    admin.mockResolvedValue({ kind: 'pending_notices', data: [{ nativeSessionId: 'private native root', message: 'private notice body' }] })
    await expect(rig.openCodeQualificationNoticeCount()).resolves.toBe(1)
    expect(admin.mock.calls.at(-1)?.[1]).toMatchObject({ params: { expectedControlEpoch: 9 } })
    expect(JSON.stringify(wire)).not.toContain('private')
    admin.mockResolvedValue({ kind: 'pending_notices', data: { truncated: true } })
    await expect(owned.openCodeQualificationNoticeCount()).rejects.toThrow()
    admin.mockClear()
    await expect(control({ ...request, action: 'opencode-qualification-notice-count', profileId: 'foreign' })).rejects.toThrow(/operation/)
    Object.assign(owned.runtime, { phase: 2 })
    await expect(owned.openCodeQualificationNoticeCount()).rejects.toThrow(/Phase 5/)
    expect(admin).not.toHaveBeenCalled()
  })
  it('applies only the fixed qualification second-view preset at the current address revision and epoch', async () => {
    const { owned, context, inventory, request } = fixture()
    Object.assign(owned.runtime, { phase: 5 })
    const row = { soulId: 'view-soul', incarnationId: 'view-incarnation', containerId: 'b'.repeat(64),
      hostBootId: 'view-boot', nativeSessionId: 'ses_view', provider: 'opencode', projectKey: 'owned-project', launchState: 'running', intentRevision: 7 }
    inventory.mockResolvedValue([row])
    const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
      createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: '/private/view/runtime' }
    Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'view_intent', data: { private: 'ignored observation' } })
    const control = runner.createExternalRuntimeControl(owned, context)
    const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => new Response(JSON.stringify(
      await control(JSON.parse(String(init.body)))), { status: 200 }))
    const handle = rig.exactRuntimeHandle(row)
    await rig.addOpenCodeQualificationSecondView(handle, 7, 4)
    expect(admin).toHaveBeenCalledWith(owned.supervisor, { method: 'upsert_view_intent', params: {
      soulId: row.soulId, expectedSoulIntentRevision: 7, expectedControlEpoch: 4,
      intent: { ownerId: 'opencode-qualification-second-view', workspaceId: 'owned-project', kind: 'explicit',
        preferredTabId: 'opencode-qualification-second-tab', preferredPaneId: 'opencode-qualification-second-pane',
        title: 'OpenCode qualification second view', placementGroup: 'Recovered agents', visibility: 'visible' },
    } })
    inventory.mockResolvedValue([{ ...row, projectKey: undefined }])
    await rig.addOpenCodeQualificationSecondView(handle, 7, 4)
    expect(admin.mock.calls.at(-1)?.[1]).toMatchObject({ params: { intent: { workspaceId: 'opencode-qualification' } } })
    admin.mockClear()
    await expect(owned.addOpenCodeQualificationSecondView(handle, 6, 4)).rejects.toThrow(/revision/)
    await expect(owned.addOpenCodeQualificationSecondView(handle, 7, 3)).rejects.toThrow(/epoch/)
    await expect(control({ ...request, action: 'opencode-qualification-second-view', handle,
      expectedIntentRevision: 7, expectedControlEpoch: 4, intent: { title: 'arbitrary' } })).rejects.toThrow(/operation/)
    inventory.mockResolvedValue([{ ...row, nativeSessionId: 'ses_replacement' }])
    await expect(owned.addOpenCodeQualificationSecondView(handle, 7, 4)).rejects.toThrow(/current/)
    inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
    await expect(owned.addOpenCodeQualificationSecondView(handle, 7, 4)).rejects.toThrow(/OpenCode/)
    Object.assign(owned.runtime, { phase: 2 })
    await expect(owned.addOpenCodeQualificationSecondView(handle, 7, 4)).rejects.toThrow(/Phase 5/)
    expect(admin).not.toHaveBeenCalled()
  })
  it('checks private replacement source readiness on the exact owner stream without exposing terminal text', async () => {
    const { owned, context, inventory, request } = fixture()
    Object.assign(owned.runtime, { phase: 5 })
    const row = { soulId: 'readiness-soul', incarnationId: 'readiness-incarnation', containerId: 'b'.repeat(64),
      hostBootId: 'readiness-boot', terminalId: 'readiness-terminal', provider: 'opencode', launchState: 'running', intentRevision: 1 }
    inventory.mockResolvedValue([row])
    const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
      createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: '/private/readiness/runtime' }
    Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
    vi.spyOn(owned, 'controlEpoch').mockResolvedValue(4)
    const output = { incarnationId: row.incarnationId, streamEpoch: 'owned-host-stream', terminalId: row.terminalId,
      exited: false, headSeq: 12, frames: [{ streamEpoch: 'owned-host-stream', terminalId: row.terminalId,
        data: '\x1b[?2004hBuild GPT-5.6 Luna\nprivate terminal conversation body' }] }
    const admin = vi.spyOn(owned.runtime, 'adminOk').mockResolvedValue({ kind: 'terminal_output', data: output })
    const assertion = vi.spyOn(owned.runtime, 'assert').mockImplementation(() => undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    const wire: unknown[] = []
    const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
      const reply = await control(JSON.parse(String(init.body)))
      wire.push(reply)
      return new Response(JSON.stringify(reply), { status: 200 })
    })
    const enclosure = rig.runtimeEnclosureHandle(row)
    const confirmation = { terminalId: row.terminalId, streamEpoch: output.streamEpoch, headSeq: output.headSeq }
    await expect(owned.confirmOpenCodeReplacementReadiness(enclosure, confirmation)).rejects.toThrow(/observed/)
    await expect(rig.openCodeReplacementReadiness(enclosure, row.terminalId)).resolves.toEqual({ incarnationId: row.incarnationId,
      streamEpoch: 'owned-host-stream', terminalId: row.terminalId, exited: false, headSeq: 12, sourceReady: true })
    expect(admin).toHaveBeenCalledWith(owned.supervisor, { method: 'terminal_read_output', params: {
      soulId: row.soulId, afterSeq: 0, maxBytes: 256 * 1024, expectedControlEpoch: 4 } })
    expect(JSON.stringify(wire)).not.toContain('private')
    expect(JSON.stringify(wire)).not.toContain('Build')
    await rig.confirmOpenCodeReplacementReadiness(enclosure, confirmation)
    expect(assertion).toHaveBeenCalledExactlyOnceWith('PC-OPENCODE', true,
      'replacement TUI prompt is source-observed and rendered before input', { soulId: row.soulId,
        incarnationId: row.incarnationId, terminalId: row.terminalId, streamEpoch: output.streamEpoch, cursor: output.headSeq })
    assertion.mockClear()
    await expect(owned.confirmOpenCodeReplacementReadiness(enclosure, { ...confirmation, streamEpoch: 'foreign-stream' })).rejects.toThrow(/observed/)
    output.frames[0].data += '\x1b[?2004l'
    expect(await rig.openCodeReplacementReadiness(enclosure, row.terminalId)).toMatchObject({ sourceReady: false })
    await expect(owned.confirmOpenCodeReplacementReadiness(enclosure, confirmation)).rejects.toThrow(/observed/)
    expect(assertion).not.toHaveBeenCalled()
    output.frames[0].streamEpoch = 'foreign-stream'
    await expect(owned.openCodeReplacementReadiness(enclosure, row.terminalId)).rejects.toThrow(/frame.*ownership/)
    output.frames[0].streamEpoch = output.streamEpoch
    output.incarnationId = 'foreign-incarnation'
    await expect(owned.openCodeReplacementReadiness(enclosure, row.terminalId)).rejects.toThrow(/source.*identity/)
    admin.mockClear()
    inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement-boot' }])
    await expect(owned.openCodeReplacementReadiness(enclosure, row.terminalId)).rejects.toThrow(/current/)
    await expect(control({ ...request, action: 'opencode-replacement-readiness', enclosure, path: '/foreign' })).rejects.toThrow(/operation/)
    expect(admin).not.toHaveBeenCalled()
  })
  it('executes only the existing fixed OpenCode blocker matrix on the owner and refuses failed prerequisites', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-qualification-blockers-'))
    try {
      const { owned, context, request } = fixture()
      Object.assign(owned.runtime, { phase: 5, evidenceDir: directory })
      const child = vi.spyOn(owned.runtime, 'runCommand').mockReturnValue('private bounded Cargo output')
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const evidence = await rig.runOpenCodeQualificationBlockers()
      expect(evidence).toEqual([
        'freshell-agent-runtime:release_qualified_opencode_blocker_matrix_is_explicit',
        'freshell-agent-runtime:opencode_probe_reads_exact_row_without_guessing_latest',
        'freshell-supervisor:retry_budget_is_persisted_and_manual_retry_rearms_without_identity_change',
      ])
      expect(child).toHaveBeenCalledTimes(3)
      for (const [index, call] of child.mock.calls.entries()) {
        const [crate, filter] = evidence[index].split(':')
        expect(call[0]).toBe(path.join(os.homedir(), '.local', 'bin', 'mise'))
        expect(call[1]).toEqual(['exec', 'rust@1.96', '--', 'cargo', 'test', '-p', crate, filter, '--', '--nocapture'])
        expect(call[2]).toEqual({ cwd: owned.repoRoot })
      }
      expect(JSON.stringify(wire)).not.toContain('private')
      child.mockClear()
      child.mockImplementationOnce(() => { throw new Error('owned Cargo prerequisite failed') })
      await expect(owned.runOpenCodeQualificationBlockers()).rejects.toThrow(/prerequisite failed/)
      expect(child).toHaveBeenCalledOnce()
      child.mockClear()
      await expect(control({ ...request, action: 'opencode-qualification-blockers', command: 'arbitrary' })).rejects.toThrow(/operation/)
      Object.assign(owned.runtime, { phase: 2 })
      await expect(owned.runOpenCodeQualificationBlockers()).rejects.toThrow(/Phase 5/)
      expect(child).not.toHaveBeenCalled()
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('observes qualification auth model process and exact cgroup limits privately on the owner', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-qualification-startup-'))
    try {
      const { owned, context, inventory, request } = fixture()
      Object.assign(owned.runtime, { phase: 5 })
      const row = { soulId: 'qualification-soul', incarnationId: 'qualification-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'qualification-boot', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const auth = path.join(directory, 'auth.json'), ca = path.join(directory, 'gateway-ca.pem'), mapper = path.join(directory, 'mapper.cjs')
      await fsp.writeFile(auth, JSON.stringify({ openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.now() + 7_200_000 } }))
      await fsp.writeFile(ca, 'private readability fixture')
      await fsp.writeFile(mapper, `const fs=require('node:fs');const read=fs.readFileSync,access=fs.accessSync;fs.readFileSync=function(file,...args){return read.call(fs,file==='/home/freshell/provider/.local/share/opencode/auth.json'?${JSON.stringify(auth)}:file,...args)};fs.accessSync=function(file,...args){return access.call(fs,file==='/home/freshell/provider/.config/onecli/gateway-ca.pem'?${JSON.stringify(ca)}:file,...args)};`)
      const limitValues = { 'cpu.max': '200000 100000', 'memory.max': '4294967296', 'memory.swap.max': '0', 'pids.max': '512' }
      for (const [name, value] of Object.entries(limitValues)) await fsp.writeFile(path.join(directory, name), value)
      let models = 'openai/gpt-5.6-luna', processTable = '40 opencode --model openai/gpt-5.6-luna'
      const read = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        if (args[0] === 'opencode') return models
        const child = spawnSync(process.execPath, ['--require', mapper, ...args.slice(1)], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private qualification auth probe refused')
        return child.stdout
      })
      const processes = vi.spyOn(owned, 'ownedContainerProcessTable').mockImplementation(() => processTable)
      const limits = vi.spyOn(owned, 'ownedContainerExec').mockImplementation((_id, args) => {
        const child = spawnSync('sh', ['-lc', args[2].replaceAll('/sys/fs/cgroup/', `${directory}/`)], { encoding: 'utf8' })
        if (child.status !== 0) throw new Error('private qualification limits probe refused')
        return child.stdout
      })
      const control = runner.createExternalRuntimeControl(owned, context)
      const wire: unknown[] = []
      const rig = new runner.ExternalManagedRuntimeRig(context, async (_url, init) => {
        const reply = await control(JSON.parse(String(init.body)))
        wire.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      const enclosure = rig.runtimeEnclosureHandle(row)
      await expect(rig.openCodeQualificationStartupFacts(enclosure)).resolves.toEqual({ modelProcessPresent: true,
        authPresent: true, modelAvailable: true, limits: { cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '512' } })
      await fsp.writeFile(path.join(directory, 'pids.max'), '256')
      await expect(rig.openCodeQualificationLimits(enclosure)).resolves.toEqual({ cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '256' })
      models = 'different model'; processTable = 'unrelated process'
      expect(await rig.openCodeQualificationStartupFacts(enclosure)).toMatchObject({ modelProcessPresent: false, modelAvailable: false })
      expect(JSON.stringify(wire)).not.toContain('onecli-managed')
      expect(JSON.stringify(wire)).not.toContain('opencode --model')
      await fsp.writeFile(auth, JSON.stringify({ openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: 0 } }))
      await expect(owned.openCodeQualificationStartupFacts(enclosure)).rejects.toThrow(/auth probe refused/)
      read.mockClear(); processes.mockClear(); limits.mockClear()
      await expect(rig.openCodeQualificationLimits(enclosure)).resolves.toMatchObject({ pidsMax: '256' })
      expect(read).not.toHaveBeenCalled(); expect(processes).not.toHaveBeenCalled()
      limits.mockReturnValueOnce('{"cpuMax":')
      await expect(owned.openCodeQualificationLimits(enclosure)).rejects.toThrow()
      limits.mockClear()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(owned.openCodeQualificationStartupFacts(enclosure)).rejects.toThrow(/current/)
      await expect(owned.openCodeQualificationLimits(enclosure)).rejects.toThrow(/current/)
      await expect(control({ ...request, action: 'opencode-qualification-startup', enclosure, command: ['arbitrary'] })).rejects.toThrow(/operation/)
      expect(read).not.toHaveBeenCalled(); expect(processes).not.toHaveBeenCalled(); expect(limits).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
      await expect(owned.openCodeQualificationStartupFacts(enclosure)).rejects.toThrow(/OpenCode/)
      await expect(owned.openCodeQualificationLimits(enclosure)).rejects.toThrow(/OpenCode/)
      Object.assign(owned.runtime, { phase: 2 })
      await expect(owned.openCodeQualificationStartupFacts(enclosure)).rejects.toThrow(/Phase 5/)
      await expect(owned.openCodeQualificationLimits(enclosure)).rejects.toThrow(/Phase 5/)
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  })
  it('observes only the fixed continuity markers, effect count and long-tool process', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-continuity-effects-'))
    try {
      const { owned, context, inventory, request } = fixture()
      const row = { soulId: 'effect-soul', incarnationId: 'effect-incarnation', containerId: 'b'.repeat(64),
        hostBootId: 'effect-boot', provider: 'opencode', launchState: 'running', intentRevision: 1 }
      inventory.mockResolvedValue([row])
      const receipt: BrokerReceipt = { containerId: row.containerId, soulId: row.soulId, incarnationId: row.incarnationId,
        createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64), imageRef: `sha256:${'d'.repeat(64)}`, runtimeDir: directory }
      Object.assign(owned.runtime, { broker: { receipts: () => [receipt] } })
      const names = ['p2-opencode-first-turn', 'p2-opencode-tool-count', 'p2-opencode-followup']
      const provider = vi.spyOn(owned, 'ownedProviderExec').mockImplementation(async (_id, args) => {
        let command = args[2]
        names.forEach((name, index) => { command = command.replaceAll(`/home/freshell/provider/${name}`, `$TEST_EFFECT_FILE_${index}`) })
        const child = spawnSync('sh', ['-lc', command], { encoding: 'utf8', env: { ...process.env,
          TEST_EFFECT_FILE_0: path.join(directory, names[0]), TEST_EFFECT_FILE_1: path.join(directory, names[1]),
          TEST_EFFECT_FILE_2: path.join(directory, names[2]) } })
        if (child.status !== 0) throw new Error('fixed private effect read failed')
        return child.stdout
      })
      const table = vi.spyOn(owned, 'ownedContainerProcessTable').mockReturnValue('40 sleep 12\n41 unrelated')
      const control = runner.createExternalRuntimeControl(owned, context)
      const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
        await control(JSON.parse(String(init.body)))), { status: 200 }))
      const rig = new runner.ExternalManagedRuntimeRig(context, transport)
      const enclosure = rig.runtimeEnclosureHandle(row)
      await expect(rig.openCodeContinuityFirstTurnCompleted(enclosure)).resolves.toBe(false)
      await expect(rig.openCodeContinuityEffectCount(enclosure)).resolves.toBe(0)
      await expect(rig.openCodeContinuityFollowUpCompleted(enclosure)).resolves.toBe(false)
      await fsp.writeFile(path.join(directory, names[0]), 'P2_OPENCODE_FIRST_TURN_DONE\n')
      await fsp.writeFile(path.join(directory, names[1]), 'one\n')
      await fsp.writeFile(path.join(directory, names[2]), 'P2_OPENCODE_FOLLOWUP_DONE\n')
      await expect(rig.openCodeContinuityFirstTurnCompleted(enclosure)).resolves.toBe(true)
      await expect(rig.openCodeContinuityEffectCount(enclosure)).resolves.toBe(1)
      await expect(rig.openCodeContinuityFollowUpCompleted(enclosure)).resolves.toBe(true)
      await expect(rig.openCodeContinuityLongToolRunning(enclosure)).resolves.toBe(true)
      table.mockReturnValue('41 unrelated')
      await expect(rig.openCodeContinuityLongToolRunning(enclosure)).resolves.toBe(false)
      await fsp.writeFile(path.join(directory, names[1]), 'one\ntwo\n')
      await expect(rig.openCodeContinuityEffectCount(enclosure)).resolves.toBe(2)
      provider.mockClear(); table.mockClear()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement-boot' }])
      await expect(owned.openCodeContinuityFirstTurnCompleted(enclosure)).rejects.toThrow(/current/)
      await expect(control({ ...request, action: 'opencode-continuity-long-tool', enclosure, pattern: 'arbitrary' })).rejects.toThrow(/operation/)
      expect(provider).not.toHaveBeenCalled(); expect(table).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(directory, { recursive: true, force: true })
    }
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
  it('awaits finite native collection and retries a lost reply without repeating capture', async () => {
    const { owned, context, request } = fixture()
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul', incarnationId: 'owned-inc',
      containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    const collectionId = '11111111-1111-4111-8111-111111111111'
    const registered = vi.spyOn(owned, 'registerFreshNativeCollection').mockResolvedValue({ collectionId, completedStages: 0, closed: false })
    let captures = 0
    const capture = vi.spyOn(owned, 'captureFreshNativeStage').mockImplementation(async () => {
      captures++
      await new Promise(resolve => setTimeout(resolve, 10))
      return { collectionId, completedStages: 1, closed: false }
    })
    const nativeResult = { collectionId, completedStages: 3, closed: true, providerStoreId: 'observed-store',
      completedNativeTurns: [1, 2, 3].map(index => ({ turnId: `native-turn-${index}`, assistantMessageId: `native-message-${index}`, completionKind: 'provider_native_completed' as const })) }
    const closed = vi.spyOn(owned, 'finishFreshNativeCollection').mockResolvedValue(nativeResult)
    const control = runner.createExternalRuntimeControl(owned, context)
    let lost = false
    const requests: Record<string, any>[] = []
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body)
      let result
      try { result = await control(body) } catch { return new Response('{}', { status: 409 }) }
      if (body.action === 'fresh-native-stage' && !lost) { lost = true; throw new Error('lost settled reply') }
      return new Response(JSON.stringify(result), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    const nonce = `codename-${'a'.repeat(32)}`
    await expect(rig.registerFreshNativeCollection(handle, nonce)).resolves.toEqual({ collectionId, completedStages: 0, closed: false })
    await expect(rig.captureFreshNativeStage(handle, collectionId)).resolves.toEqual({ collectionId, completedStages: 1, closed: false })
    expect(captures).toBe(1)
    const original = requests.find(body => body.action === 'fresh-native-stage')!
    await expect(control({ ...original, nativeCollectionId: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow(/reused/)
    await expect(control({ ...request, action: 'fresh-native-stage', handle, nativeCollectionId: collectionId, path: '/source' })).rejects.toThrow(/operation/)
    await expect(control({ ...request, action: 'fresh-native-stage', handle })).rejects.toThrow(/collection/)
    await expect(rig.finishFreshNativeCollection(handle, collectionId)).resolves.toEqual(nativeResult)
    expect(registered).toHaveBeenCalledExactlyOnceWith(handle, nonce)
    expect(capture).toHaveBeenCalledExactlyOnceWith(handle, collectionId)
    expect(closed).toHaveBeenCalledExactlyOnceWith(handle, collectionId)
    vi.spyOn(owned, 'stop').mockResolvedValue({ ok: true, errors: [] })
    await rig.stop()
    await expect(rig.captureFreshNativeStage(handle, collectionId)).rejects.toThrow(/refused/)
    await expect(control({ ...original, operationId: 'capture-after-finish' })).rejects.toThrow(/finished/)
    expect(captures).toBe(1)
  })

  it('runs finite browser and native approval consumers through the exact owner RPCs', async () => {
    const { owned, context, request } = fixture()
    const address = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul', incarnationId: 'owned-inc',
      containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    const id = '11111111-1111-4111-8111-111111111111', challengeId = '22222222-2222-4222-8222-222222222222'
    const observe = vi.spyOn(owned, 'observeFreshBrowserIngress').mockResolvedValue(undefined)
    const uiRegister = vi.spyOn(owned, 'registerFreshBrowserTurn').mockResolvedValue({ challengeId, prompt: 'Reply ready. Do not use tools.' })
    const uiFinish = vi.spyOn(owned, 'finishFreshBrowserTurn').mockResolvedValue(undefined)
    const approvalRegister = vi.spyOn(owned, 'registerFreshApproval').mockResolvedValue({ challengeId, prompt: 'owned fixed solo Bash instruction' })
    const approvalCheckpoint = vi.spyOn(owned, 'captureFreshApprovalCheckpoint').mockResolvedValue({ challengeId, decisionId: 'actual-current-card', toolUseID: 'toolu_original', nativeRequestId: 'actual-current-native-request' })
    const approvalFinish = vi.spyOn(owned, 'finishFreshApproval').mockResolvedValue(undefined)
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    const ingress = { ingress: 'ws-attach' as const, request: { type: 'freshAgent.attach', sessionId: 'actual-browser-session' } }
    await rig.observeFreshBrowserIngress(address, id, ingress)
    await expect(rig.registerFreshBrowserTurn(address, id)).resolves.toMatchObject({ challengeId })
    const send = { type: 'freshAgent.send', requestId: 'real-send', text: 'Reply ready. Do not use tools.' }
    const accepted = { type: 'freshAgent.send.accepted', requestId: 'real-send' }
    await rig.finishFreshBrowserTurn(address, challengeId, send, accepted)
    await rig.registerFreshApproval(address, false, 'provider')
    await rig.captureFreshApprovalCheckpoint(address, challengeId)
    const decision = { type: 'freshAgent.approval.respond', requestId: 'actual-current-card', decision: { behavior: 'deny' } }
    await rig.finishFreshApproval(address, challengeId, decision)
    expect(observe).toHaveBeenCalledExactlyOnceWith(address, id, ingress)
    expect(uiRegister).toHaveBeenCalledExactlyOnceWith(address, id)
    expect(uiFinish).toHaveBeenCalledExactlyOnceWith(address, challengeId, send, accepted)
    expect(approvalRegister).toHaveBeenCalledExactlyOnceWith(address, false, 'provider')
    expect(approvalCheckpoint).toHaveBeenCalledExactlyOnceWith(address, challengeId)
    expect(approvalFinish).toHaveBeenCalledExactlyOnceWith(address, challengeId, decision)
    await expect(control({ ...request, action: 'fresh-approval-finish', handle: address, challengeId })).rejects.toThrow(/actual browser decision/)
    await expect(control({ ...request, operationId: 'invalid-native-source', action: 'fresh-approval-register', handle: address, freshApprovalAllowed: false, freshApprovalRecovery: 'provider', path: '/arbitrary' })).rejects.toThrow(/operation/)
    expect(approvalFinish).toHaveBeenCalledOnce()
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
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused receipt web') }, fixtureRepoRoot, 5)
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
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3, {}, {}, 'test', {
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
  it('finds a materialized native alias through the actual original presentation lookup', async () => {
    const { aliasActivation } = await import('../../../e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.js')
    const original = { soulId: 'owned-soul', incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64),
      hostBootId: 'owned-boot', nativeSessionId: 'ses_owned_native', freshAgentSessionId: 'freshopencode-owned-create',
      freshAgentSessionType: 'freshopencode', provider: 'opencode', launchState: 'running', intentRevision: 1 }
    const unrelated = { ...original, soulId: 'another-soul', freshAgentSessionId: 'another-presentation-of-same-native' }
    const rows = [unrelated, original]
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      expect(request.action).toBe('inventory')
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: rows }), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(runner.resolveManagedExternalDescriptor(descriptor)!, transport)
    const created = { reply: { sessionId: original.freshAgentSessionId }, view: original }
    const aliasReply = { sessionId: original.nativeSessionId }
    vi.useFakeTimers()
    try {
      await expect(rig.runningViewForFreshSession(aliasReply.sessionId)).resolves.toBeNull()
      const outcome = aliasActivation(rig, created, aliasReply).then(view => ({ view }), error => ({ error: String(error) }))
      await vi.advanceTimersByTimeAsync(240_000)
      expect(await outcome).toEqual({ view: original })
      expect(aliasReply.sessionId).toBe(original.nativeSessionId)
      await expect(aliasActivation(rig, created, { sessionId: 'another-native-root' })).rejects.toThrow(/alias reply differs/)
      for (const [field, value] of [['soulId', 'another-soul'], ['nativeSessionId', 'another-native-root'], ['provider', 'claude'],
        ['freshAgentSessionType', 'freshclaude'], ['incarnationId', 'old-incarnation']]) {
        rows[1] = { ...original, [field]: value }
        await expect(aliasActivation(rig, created, aliasReply)).rejects.toThrow(/alias activation differs/)
      }
    } finally { vi.useRealTimers() }
  })
  it.each(['freshopencode', 'freshclaude'])('finds a materialized %s replacement through the actual external lookup', async (mode) => {
    const { replacement } = await import('../../../e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.js')
    const presentationId = mode + '-owned-picker-request', nativeId = 'ses_owned_native'
    const observation = { tabId: 'owned-tab', paneId: 'owned-pane', createRequestId: 'owned-picker-request',
      sessionType: mode, provider: mode === 'freshopencode' ? 'opencode' : 'claude',
      createdSessionId: presentationId, nativeSessionId: nativeId }
    vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => ({ panes: { layouts: {
      'owned-tab': { type: 'leaf', id: 'owned-pane', content: { kind: 'fresh-agent',
        createRequestId: observation.createRequestId, sessionType: mode, provider: observation.provider,
        sessionId: nativeId, sessionRef: { provider: observation.provider, sessionId: nativeId } } },
    } } }) } })
    const created = { reply: { sessionId: presentationId }, ...runner.observeOwnedFreshBrowserPane(observation)! }
    const original = { soulId: 'owned-soul', incarnationId: 'prior-incarnation', containerId: 'b'.repeat(64),
      hostBootId: 'owned-boot', nativeSessionId: nativeId, freshAgentSessionId: presentationId,
      freshAgentSessionType: mode, provider: observation.provider, launchState: 'running', intentRevision: 1 }
    const healthy = { ...original, incarnationId: 'replacement-incarnation', containerId: 'c'.repeat(64) }
    // Another presentation of the same native conversation is never the target.
    const unrelated = { ...healthy, soulId: 'other-soul', freshAgentSessionId: 'other-presentation' }
    let rows: ManagedRuntimeView[] = [original, unrelated]
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      expect(request.action).toBe('inventory')
      return new Response(JSON.stringify({ runId: request.runId, candidateSha: request.candidateSha,
        operationId: request.operationId, result: rows }), { status: 200 })
    })
    const rig = new runner.ExternalManagedRuntimeRig(runner.resolveManagedExternalDescriptor(descriptor)!, transport)
    try {
      expect(created).toMatchObject({ paneId: observation.paneId, sessionId: nativeId, reply: { sessionId: presentationId } })
      await expect(rig.runningViewForFreshSession(nativeId)).resolves.toBeNull()
      await expect(rig.runningViewForFreshSession(presentationId)).resolves.toEqual(original)
      vi.useFakeTimers()
      let settled = false
      const outcome = replacement(rig, created, original.incarnationId).then(
        view => { settled = true; return { view } }, error => ({ error: String(error) }))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      rows = [{ ...healthy, containerId: undefined }, unrelated]
      await vi.advanceTimersByTimeAsync(250)
      expect(settled).toBe(false)
      rows = [healthy, unrelated]
      await vi.advanceTimersByTimeAsync(240_000)
      expect(await outcome).toEqual({ view: healthy })
      expect(created.sessionId).toBe(nativeId)
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
  it('awaits the owner terminal notice count and validates the body-free reply', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('unused notice web') }, fixtureRepoRoot)
    const context = { ...runner.resolveManagedExternalDescriptor(descriptor)!, runId: owned.runtime.runId, candidateSha: owned.runtime.candidateSha }
    const handle = { runId: context.runId, candidateSha: context.candidateSha, soulId: 'owned-soul',
      incarnationId: 'owned-incarnation', containerId: 'b'.repeat(64), hostBootId: 'owned-boot', nativeSessionId: 'owned-root' }
    let release: (value: number) => void = () => { throw new Error('owner count was not requested') }
    const count = vi.spyOn(owned, 'managedProviderPendingNoticeCount').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const control = runner.createExternalRuntimeControl(owned, context)
    const transport = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(await control(JSON.parse(String(init.body)))), { status: 200 }))
    const rig = new runner.ExternalManagedRuntimeRig(context, transport)
    let settled = false
    const observation = rig.managedProviderPendingNoticeCount(handle).then(value => { settled = true; return value })
    await vi.waitFor(() => expect(count).toHaveBeenCalledExactlyOnceWith(handle))
    expect(settled).toBe(false)
    release(2)
    await expect(observation).resolves.toBe(2)
    count.mockResolvedValue(-1)
    await expect(rig.managedProviderPendingNoticeCount(handle)).rejects.toThrow()
    const startup: ManagedTerminalStartupFacts = { provider: 'codex', version: 'codex-cli 0.147.0\n', providerProcessPresent: true,
      processIdentities: ['low', 'gpt-5.6-luna'], reasoningFlagsAbsent: false,
      limits: { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '32' } }
    const launch = vi.spyOn(owned, 'managedTerminalStartupFacts').mockResolvedValue(startup)
    await expect(rig.managedTerminalStartupFacts(handle)).resolves.toEqual(startup)
    expect(launch).toHaveBeenCalledExactlyOnceWith(rig.runtimeEnclosureHandle(handle))
  })
  it('retries a lost mutation reply with the same operation ID and settles owner cleanup once', async () => {
    const owned = new ManagedRuntimeOwner(() => { throw new Error('web factory unused in RPC unit') }, fixtureRepoRoot)
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
  async function launch(external: boolean, digest: string, observedImage?: string, executionImage?: string,
    registryDocuments?: Record<string, unknown>, diagnosticLog?: string) {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-cloud-image-'))
    try {
      const scripts = path.join(directory, 'scripts')
      const bin = path.join(directory, 'bin')
      const calls = path.join(directory, 'calls.jsonl')
      await fsp.mkdir(path.join(scripts, 'lib'), { recursive: true })
      await fsp.mkdir(bin)
      await fsp.copyFile('scripts/e2e-cloud.sh', path.join(scripts, 'e2e-cloud.sh'))
      await fsp.copyFile('scripts/e2e-cloud-duration.mjs', path.join(scripts, 'e2e-cloud-duration.mjs'))
      await fsp.copyFile('scripts/lib/gcp-identity.sh', path.join(scripts, 'lib/gcp-identity.sh'))
      const command = `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const name=path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({name,args})+'\\n');
if(name==='git'){if(args.includes('status'))process.exit(0);console.log(args.includes('--short=12')?'aaaaaaaaaaaa':'${'a'.repeat(40)}');process.exit(0)}
if(name==='pnpm'){
  if(args.some(x=>x.includes('cleanupOwnedExternalCloudJob')))JSON.parse(fs.readFileSync(0,'utf8'));
  if(args.includes('cloud-metadata')&&process.env.TEST_EXTERNAL==='1')console.log('FRESHELL_RUNTIME_EXTERNAL_RUN_ID: "${descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID}"');
  process.exit(0);
}
if(args[0]==='info')process.exit(0);
if(args[0]==='auth'){console.log('fixture-token');process.exit(0)}
if(args[0]==='artifacts'){console.log(process.env.TEST_DIGEST);process.exit(0)}
if(args.includes('create')){const image=args.find(x=>x.startsWith('--image=')).slice(8);fs.writeFileSync(process.env.TEST_CALLS+'.image',image);process.exit(0)}
if(args.includes('describe')){const job=args.find(x=>x.startsWith('freshell-e2e-'));const observed=args.includes('executions')?process.env.TEST_EXECUTION_IMAGE:process.env.TEST_OBSERVED_IMAGE;const containers=[{image:observed||fs.readFileSync(process.env.TEST_CALLS+'.image','utf8')}];console.log(JSON.stringify({metadata:{name:job,labels:{'freshell-managed-run':'${descriptor.FRESHELL_RUNTIME_EXTERNAL_RUN_ID}','freshell-managed-candidate':'${'a'.repeat(40)}'}},spec:{template:{spec:args.includes('executions')?{containers}:{template:{spec:{containers}}}}}}));process.exit(0)}
if(args.includes('execute')){const job=args.find(x=>x.startsWith('freshell-e2e-'));console.log('Execution ['+job+'-fixture] has failed.');process.exit(73)}
if(args.includes('logs')&&args.includes('read')){process.stdout.write(process.env.TEST_DIAGNOSTIC_LOG||'');process.exit(0)}
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
          TEST_EXECUTION_IMAGE: executionImage, TEST_REGISTRY_DOCUMENTS: JSON.stringify(registryDocuments ?? { [digest]: imageManifest }),
          TEST_DIAGNOSTIC_LOG: diagnosticLog },
        encoding: 'utf8', timeout: 20_000,
      })
      const operations = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { name: string; args: string[] })
      const events = child.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } })
      return { child, operations, events }
    } finally { await fsp.rm(directory, { recursive: true, force: true }) }
  }

  it('retains interrupted ordinary Stop ACK diagnostic through the actual failed-execution log consumer', async () => {
    const writes: string[] = []
    const failure = new Error('original ACK failure')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true })
    try {
      await expect(reportInterruptedOrdinaryStopAckFailure(failure, { attach: async () => undefined }, {
        expected: { presentationSessionId: 'presentation-owned', nativeSessionId: 'native-owned', soulId: 'soul-owned' },
        sentAtStop: 0, receivedAtStop: 0, stopSocketAtMs: 10,
        sent: [{ type: 'freshAgent.kill', sessionId: 'presentation-owned', observedEpoch: 77,
          observedGeneration: 9, token: 'PRIVATE_AUTH_TOKEN', text: 'PRIVATE_TRANSCRIPT' }],
        received: [], sentSocketFacts: [{ socketOrdinal: 1, atMs: 11 }], receivedSocketFacts: [],
        socketLifecycle: [{ socketOrdinal: 1, atMs: 0, event: 'created' }],
      })).rejects.toBe(failure)
    } finally { write.mockRestore() }
    const diagnosticLog = writes.join('')
    expect(diagnosticLog.length).toBeGreaterThan(300)
    const result = await launch(true, fixtureDigest, undefined, undefined, undefined, diagnosticLog)
    expect(result.child.status).toBe(1)
    expect(result.operations.some(row => row.name === 'gcloud' && row.args.includes('logs') && row.args.includes('read'))).toBe(true)
    expect(result.child.stdout).toContain(diagnosticLog)
    expect(result.child.stdout).not.toMatch(/PRIVATE_AUTH_TOKEN|PRIVATE_TRANSCRIPT/)
  })

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
    expect(create?.args, result.child.stderr).toContain(`--image=${image}`)
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
