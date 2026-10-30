// @vitest-environment node
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const fixtureUrl = new URL('./fixtures/cloud-vitest-child.mjs', import.meta.url).href
const outputSize = 2 * 1024 * 1024
const stdoutPayload = `CLOUD_STDOUT_BEGIN\n${'o'.repeat(outputSize)}\nCLOUD_STDOUT_END\n`
const stderrPayload = `CLOUD_STDERR_BEGIN\n${'e'.repeat(outputSize)}\nAssertionError: expected 4 sessions, received 3\nCLOUD_STDERR_END\n`
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FixtureOptions {
  cloudExit?: number
  companionExit?: number
  largeOutput?: boolean
  concurrent?: boolean
  missingCloudScript?: boolean
}

interface FixtureEvent {
  role: 'cloud' | 'companion'
  event: 'start' | 'complete'
  args: string[]
}

async function runFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cloud-vitest-output-'))
  fixtureRoots.push(root)
  // A small independent checkout keeps the companion selection deterministic
  // even in the source-only Cloud image, where its real test dir is absent.
  // Dependencies are read-only; no fixture phase builds or writes artifacts.
  for (const file of [
    'package.json',
    '.dockerignore',
    'scripts/run-standard-tests.ts',
    'scripts/lib/package-manager.ts',
    'scripts/testing/coordinator-upstream.ts',
    'scripts/testing/process-tree.ts',
  ]) {
    const destination = path.join(root, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(path.resolve(file), destination)
  }
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction')
  mkdirSync(path.join(root, 'test/integration/server'), { recursive: true })
  const runner = path.join(root, 'scripts/run-standard-tests.ts')
  const events = path.join(root, 'events.jsonl')
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${fixtureUrl}`,
    FRESHELL_VITEST_BACKEND: 'cloud',
    FRESHELL_VITEST_LOCAL_COMPANION: 'on',
    FRESHELL_VITEST_CLOUD_SCRIPT: options.missingCloudScript ? path.join(root, 'missing-cloud-script') : process.execPath,
    FRESHELL_VITEST_COMPANION_SCRIPT: process.execPath,
    CLOUD_OUTPUT_FIXTURE: JSON.stringify({ root, events, outputSize, cloudExit: 0, companionExit: 0, ...options }),
  }
  // Concurrent cases always contain a synthetic failure, so the broad plan
  // stops after these two fixture children and never launches builds/tests.
  const args = options.concurrent ? [] : ['test/unit/cloud-output-fixture.test.ts']
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, runner, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
  const recorded: FixtureEvent[] = options.missingCloudScript ? [] : readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { ...result, events: recorded }
}

describe('Cloud Vitest child output', () => {
  it.each([0, 17])('streams complete stdout and stderr beyond execFile limits, preserving exit %s', async cloudExit => {
    const result = await runFixture({ cloudExit, largeOutput: true })
    expect(result.code).toBe(cloudExit === 0 ? 0 : 1)
    expect(result.stdout.includes(stdoutPayload), 'all emitted stdout bytes remain visible').toBe(true)
    expect(result.stderr.includes(stderrPayload), 'all emitted stderr bytes remain visible').toBe(true)
    expect(result.events.map(event => event.event)).toEqual(['start', 'complete'])
    expect(result.events[0].args).toEqual(['--cloud', '--config=default', 'test/unit/cloud-output-fixture.test.ts'])
    if (cloudExit !== 0) expect(result.stderr).toContain('code 17')
  })

  it('preserves small failure diagnostics and reports the child exit code', async () => {
    const result = await runFixture({ cloudExit: 23 })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('cloud stdout diagnostic\n')
    expect(result.stderr).toContain('cloud stderr diagnostic\n')
    expect(result.stderr).toContain('code 23')
  })

  it('reports spawn errors without claiming that the cloud phase passed', async () => {
    const result = await runFixture({ missingCloudScript: true })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ENOENT')
    expect(result.stderr).toContain('Cloud Vitest phase failed')
    expect(result.stdout).not.toContain('Cloud default phase complete')
  })

  it.each([
    { cloudExit: 17, companionExit: 0 },
    { cloudExit: 0, companionExit: 31 },
  ])('waits for concurrent cloud and companion diagnostics after failure: %j', async options => {
    const result = await runFixture({ ...options, concurrent: true })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('cloud stdout diagnostic\n')
    expect(result.stdout).toContain('companion stdout diagnostic\n')
    expect(result.stderr).toContain('cloud stderr diagnostic\n')
    expect(result.stderr).toContain('companion stderr diagnostic\n')
    expect(result.events.filter(event => event.event === 'start').map(event => event.role).sort()).toEqual(['cloud', 'companion'])
    expect(result.events.filter(event => event.event === 'complete').map(event => event.role).sort()).toEqual(['cloud', 'companion'])
    expect(result.stdout).not.toContain('Cloud default phase complete')
    if (options.cloudExit) expect(result.stderr).toContain('Cloud Vitest phase failed')
    if (options.companionExit) expect(result.stderr).toContain('Local companion phase failed')
  })
})
