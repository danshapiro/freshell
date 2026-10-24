import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupRuntimeBuildPreflight } from '../../../setup/runtime-build-preflight.js'
import { RUNTIME_BUILD_MANIFEST_ENV, preparedRuntimeBinary } from '../../../../scripts/testing/runtime-build-preflight.js'
import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { ManagedRuntimeBrowserRig } from '../../../e2e-browser/helpers/managed-runtime.js'

const owned: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-preflight-'))
  owned.push(root)
  execFileSync('git', ['init', '--quiet', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'])
  const cargo = path.join(root, 'cargo.cjs')
  fs.writeFileSync(cargo, `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BUILD_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAIL_BUILD && args.includes(process.env.FAIL_BUILD)) process.exit(17);
if (process.env.BUILD_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BUILD_DELAY_MS));
const profile = args.includes('--release') ? 'release' : 'debug';
const features = args.includes('--features') ? args[args.indexOf('--features') + 1] : 'default';
const stamp = process.env.BUILD_STAMP ? fs.readFileSync(process.env.BUILD_STAMP, 'utf8') : '';
const target = path.resolve(process.cwd(), process.env.CARGO_TARGET_DIR || 'target', profile);
fs.mkdirSync(target, {recursive:true});
for (let i=0; i<args.length; i++) if (args[i] === '-p') {
  const binary = path.join(target, args[i+1] + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(binary, '#!/bin/sh\\n# ' + profile + ':' + features + ':' + stamp + '\\n', {mode:0o755});
}
`)
  const env: NodeJS.ProcessEnv & { CARGO_TARGET_DIR: string; BUILD_LOG: string } = { ...process.env, CARGO_TARGET_DIR: path.join(root, 'custom target'), BUILD_LOG: path.join(root, 'builds.jsonl') }
  env[RUNTIME_BUILD_MANIFEST_ENV] = undefined
  const project = {
    config: { root, env },
    vitest: { state: { getPaths: () => [path.join(root, 'test/integration/server/managed-provider-parity.test.ts')] } },
    onTestsRerun: () => {},
  }
  const command = { program: process.execPath, args: [cargo] }
  const rows = () => fs.existsSync(env.BUILD_LOG) ? fs.readFileSync(env.BUILD_LOG, 'utf8').trim().split('\n').map(row => JSON.parse(row) as string[]) : []
  return { root, project, command, rows }
}

describe('managed runtime build preparation before suite startup', () => {
  it('does no builds or artifact work for an unrelated selected unit file', async () => {
    const f = fixture()
    f.project.vitest.state.getPaths = () => [path.join(f.root, 'test/unit/ordinary.test.ts')]
    const teardown = await setupRuntimeBuildPreflight(f.project, { command: f.command })
    expect(f.rows()).toEqual([])
    expect(preparedRuntimeBinary(f.root, 'supervisor-test', f.project.config.env)).toBeUndefined()
    await teardown?.()
  })

  it('builds selected variants once and preserves their exact executable copies across later Cargo builds', async () => {
    vi.stubEnv(RUNTIME_BUILD_MANIFEST_ENV, path.join(os.tmpdir(), 'unrelated-parent-build-manifest'))
    const f = fixture()
    f.project.vitest.state.getPaths = () => [
      path.join(f.root, 'test/integration/server/managed-provider-parity.test.ts'),
      path.join(f.root, 'test/integration/server/fresh-agent-parity.test.ts'),
      path.join(f.root, 'test/integration/server/provider-parity-contract.test.ts'),
    ]
    const teardown = await setupRuntimeBuildPreflight(f.project, { command: f.command })
    expect(f.rows()).toHaveLength(5)
    const terminal = preparedRuntimeBinary(f.root, 'server-managed-provider-qualification', f.project.config.env)!
    const fresh = preparedRuntimeBinary(f.root, 'server-managed-fresh-agent-fixtures', f.project.config.env)!
    expect(fs.readFileSync(terminal, 'utf8')).toContain('release:managed-provider-qualification')
    expect(fs.readFileSync(fresh, 'utf8')).toContain('release:managed-fresh-agent-fixtures')
    expect(fs.readFileSync(preparedRuntimeBinary(f.root, 'supervisor-test', f.project.config.env)!, 'utf8')).toContain('debug:freshell-supervisor/runtime-test-faults')
    expect(fs.statSync(terminal).mode & 0o111).not.toBe(0)
    await teardown?.()
    expect(fs.existsSync(terminal)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(false)
  })

  it('reuses the parent invocation artifacts for nested parity runners without compiling or owning their cleanup', async () => {
    const f = fixture()
    f.project.vitest.state.getPaths = () => [path.join(f.root, 'test/integration/server/provider-parity-contract.test.ts')]
    const teardown = await setupRuntimeBuildPreflight(f.project, { command: f.command })
    const binary = preparedRuntimeBinary(f.root, 'server-managed-provider-qualification', f.project.config.env)!
    const nested = { ...f.project, config: { ...f.project.config, env: { ...f.project.config.env } } }
    const childTeardown = await setupRuntimeBuildPreflight(nested, { command: f.command })
    expect(f.rows()).toHaveLength(5)
    await childTeardown?.()
    expect(fs.existsSync(binary)).toBe(true)
    await teardown?.()
    expect(fs.existsSync(binary)).toBe(false)
  })

  it('fails preparation before publishing a partial bundle when a prerequisite build fails', async () => {
    const f = fixture()
    Object.assign(f.project.config.env, { FAIL_BUILD: 'provider-qualification' })
    await expect(setupRuntimeBuildPreflight(f.project, { command: f.command })).rejects.toThrow(/17|build/)
    expect(f.rows()).toHaveLength(3)
    expect(preparedRuntimeBinary(f.root, 'supervisor-test', f.project.config.env)).toBeUndefined()
    expect(fs.existsSync(path.join(f.root, '.runtime-build')) ? fs.readdirSync(path.join(f.root, '.runtime-build')) : []).toEqual([])
  })

  it('refuses missing prepared variants and artifacts from another checkout instead of silently building', async () => {
    const f = fixture()
    const teardown = await setupRuntimeBuildPreflight(f.project, { command: f.command })
    expect(() => preparedRuntimeBinary(f.root, 'server-managed-fresh-agent-fixtures', f.project.config.env)).toThrow(/prepared.*variant|not prepared/i)
    const other = fixture()
    expect(() => preparedRuntimeBinary(other.root, 'supervisor-test', f.project.config.env)).toThrow(/checkout|root/)
    expect(other.rows()).toEqual([])
    await teardown?.()
  })

  it('uses the prepared executables in the actual runtime and browser rig build methods without invoking Cargo again', async () => {
    const f = fixture()
    const teardown = await setupRuntimeBuildPreflight(f.project, { command: f.command })
    vi.stubEnv(RUNTIME_BUILD_MANIFEST_ENV, f.project.config.env[RUNTIME_BUILD_MANIFEST_ENV])
    const runtime = new RuntimeHarness(f.root, undefined, 2)
    const rig = new ManagedRuntimeBrowserRig(f.root, 2, {}, {}, 'test', { enabledProviders: ['claude'] })
    fs.mkdirSync(rig.runtime.buildDir, { recursive: true })
    ;(runtime as unknown as { buildBinaries(): void }).buildBinaries()
    const methods = rig as unknown as { buildManagedServer(): string; buildQualificationSupervisor(): string }
    const server = methods.buildManagedServer()
    const supervisor = methods.buildQualificationSupervisor()
    expect(fs.readFileSync(runtime.testHostBinary, 'utf8')).toContain('debug:freshell-supervisor/runtime-test-faults')
    expect(fs.readFileSync(runtime.releaseHostBinary, 'utf8')).toContain('release:default')
    expect(fs.readFileSync(server, 'utf8')).toContain('release:managed-provider-qualification')
    expect(fs.readFileSync(supervisor, 'utf8')).toContain('release:provider-qualification')
    expect(f.rows()).toHaveLength(4)
    await teardown?.()
    expect(fs.readFileSync(server, 'utf8')).toContain('release:managed-provider-qualification')
  })

  it('runs preflight before a real Vitest startup hook, selects only requested files, and never starts after a build failure', () => {
    const f = fixture()
    const sourceRoot = path.resolve(import.meta.dirname, '../../../..')
    const url = (file: string) => JSON.stringify(pathToFileURL(path.join(sourceRoot, file)).href)
    const marker = path.join(f.root, 'started')
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ type: 'module' }))
    const setup = path.join(f.root, 'setup.ts')
    fs.writeFileSync(setup, `import { setupRuntimeBuildPreflight } from ${url('test/setup/runtime-build-preflight.ts')};
export default project => setupRuntimeBuildPreflight(project, ${JSON.stringify({ command: f.command })});`)
    const config = path.join(f.root, 'vitest.config.ts')
    fs.writeFileSync(config, `export default ${JSON.stringify({ root: f.root, test: { environment: 'node', globalSetup: [setup], maxWorkers: 1 } })}`)
    const ordinary = 'test/unit/ordinary.test.ts'
    const managed = 'test/integration/server/managed-provider-parity.test.ts'
    for (const file of [ordinary, managed]) {
      fs.mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true })
      fs.writeFileSync(path.join(f.root, file), `import fs from 'node:fs';
import { it, beforeAll, expect } from ${url('node_modules/vitest/dist/index.js')};
import { preparedRuntimeBinary } from ${url('scripts/testing/runtime-build-preflight.ts')};
let binary;
beforeAll(() => { binary = preparedRuntimeBinary(${JSON.stringify(f.root)}, 'server-managed-provider-qualification'); fs.writeFileSync(${JSON.stringify(marker)}, binary || 'unit'); }, 250);
it('starts with the exact selected artifacts', () => expect(${JSON.stringify(file)}.includes('/server/')).toBe(Boolean(binary)));`)
    }
    const run = (file: string, extra: NodeJS.ProcessEnv = {}) => execFileSync(process.execPath, [
      path.join(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run', file, '--config', config,
    ], { cwd: f.root, env: { ...f.project.config.env, BUILD_DELAY_MS: '100', ...extra }, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })
    run(ordinary)
    expect(f.rows()).toEqual([])
    expect(fs.readFileSync(marker, 'utf8')).toBe('unit')
    fs.rmSync(marker)
    run(managed)
    expect(f.rows()).toHaveLength(4)
    expect(fs.readFileSync(marker, 'utf8')).toContain('server-managed-provider-qualification')
    fs.rmSync(marker)
    expect(() => run(managed, { FAIL_BUILD: 'provider-qualification' })).toThrow()
    expect(fs.existsSync(marker)).toBe(false)
  }, 30_000)

  it('consumes the latest prepared artifacts on real Vitest reruns and cleans every observed bundle', () => {
    const f = fixture()
    const sourceRoot = path.resolve(import.meta.dirname, '../../../..')
    const url = (file: string) => JSON.stringify(pathToFileURL(path.join(sourceRoot, file)).href)
    const stamp = path.join(f.root, 'stamp')
    const observations = path.join(f.root, 'observations.jsonl')
    fs.writeFileSync(stamp, 'initial')
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ type: 'module' }))
    const setup = path.join(f.root, 'setup.ts')
    fs.writeFileSync(setup, `import { setupRuntimeBuildPreflight } from ${url('test/setup/runtime-build-preflight.ts')};
export default project => setupRuntimeBuildPreflight(project, ${JSON.stringify({ command: f.command })});`)
    const managed = 'test/integration/server/managed-provider-parity.test.ts'
    fs.mkdirSync(path.dirname(path.join(f.root, managed)), { recursive: true })
    fs.writeFileSync(path.join(f.root, managed), `import fs from 'node:fs';
import { it, expect } from ${url('node_modules/vitest/dist/index.js')};
import { preparedRuntimeBinary, RUNTIME_BUILD_MANIFEST_ENV } from ${url('scripts/testing/runtime-build-preflight.ts')};
it('observes the exact rebuilt binary', () => {
  const binary = preparedRuntimeBinary(${JSON.stringify(f.root)}, 'server-managed-provider-qualification');
  const bytes = fs.readFileSync(binary, 'utf8');
  expect(bytes).toContain(fs.readFileSync(${JSON.stringify(stamp)}, 'utf8'));
  fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ manifest: process.env[RUNTIME_BUILD_MANIFEST_ENV], binary, bytes }) + '\\n');
});`)
    const config = path.join(f.root, 'vitest.config.ts')
    fs.writeFileSync(config, `export default ${JSON.stringify({ root: f.root, test: { environment: 'node', globalSetup: [setup], maxWorkers: 1 } })}`)
    const driver = path.join(f.root, 'rerun.mjs')
    fs.writeFileSync(driver, `import fs from 'node:fs';
import { startVitest } from ${url('node_modules/vitest/dist/node.js')};
const ctx = await startVitest('test', [${JSON.stringify(managed)}], { root: ${JSON.stringify(f.root)}, config: ${JSON.stringify(config)}, watch: true });
if (!ctx) throw new Error('Vitest did not start');
try {
  const specs = await ctx.globTestSpecifications([${JSON.stringify(managed)}]);
  for (const next of ['rerun-one', 'rerun-two']) {
    fs.writeFileSync(${JSON.stringify(stamp)}, next);
    await ctx.rerunTestSpecifications(specs);
  }
} finally { await ctx.close(); }
`)
    execFileSync(process.execPath, [driver], { cwd: f.root, env: { ...f.project.config.env, BUILD_STAMP: stamp }, timeout: 30_000, stdio: 'pipe' })
    const rows = fs.readFileSync(observations, 'utf8').trim().split('\n').map(row => JSON.parse(row))
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.bytes)).toEqual([
      expect.stringContaining(':initial'), expect.stringContaining(':rerun-one'), expect.stringContaining(':rerun-two'),
    ])
    for (const row of rows) {
      expect(fs.existsSync(row.binary)).toBe(false)
      expect(fs.existsSync(row.manifest)).toBe(false)
    }
  }, 30_000)
})
