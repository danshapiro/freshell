import { createRequire } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants as osConstants } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { UpstreamPhase } from '../../../../scripts/testing/coordinator-command-matrix.js'
import {
  assertNoCoordinatorRecursion,
  resolveVitestCommand,
  runUpstreamPhase,
} from '../../../../scripts/testing/coordinator-upstream.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const FIXTURE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'testing', 'fake-coordinated-workload.mjs')
const require = createRequire(import.meta.url)
const vitestPackagePath = require.resolve('vitest/package.json')
const vitestManifest = JSON.parse(fs.readFileSync(vitestPackagePath, 'utf8')) as { bin: { vitest: string } }
const expectedVitestEntrypoint = path.resolve(path.dirname(vitestPackagePath), vitestManifest.bin.vitest)

let tempDir: string
let captureFile: string
let fakePnpmEntry: string
let fakeNpmEntry: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coordinator-upstream-'))
  captureFile = path.join(tempDir, 'capture.jsonl')
  fakePnpmEntry = path.join(tempDir, 'pnpm.cjs')
  fakeNpmEntry = path.join(tempDir, 'npm-cli.js')
  await fsp.writeFile(fakePnpmEntry, '')
  await fsp.writeFile(fakeNpmEntry, '')
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

interface FakeEnvOptions {
  repoRoot?: string
  npmExecpath?: string
}

function fakeEnv(behavior: Record<string, unknown> = {}, options: FakeEnvOptions = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FIXTURE_PATH,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify(behavior),
    FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: options.repoRoot ?? REPO_ROOT,
    npm_execpath: options.npmExecpath ?? fakePnpmEntry,
  }
}

async function makeRepoRootFixture(manifest: Record<string, unknown>): Promise<string> {
  const repoRoot = path.join(tempDir, 'repo-root')
  await fsp.mkdir(repoRoot, { recursive: true })
  await fsp.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(manifest))
  return repoRoot
}

async function readCaptureLines() {
  const raw = await fsp.readFile(captureFile, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('coordinator-upstream', () => {
  it('resolves the repo-local vitest entry module under process.execPath', () => {
    const command = resolveVitestCommand(REPO_ROOT)

    expect(command.command).toBe(process.execPath)
    expect(command.args).toEqual([expectedVitestEntrypoint])
  })

  it('passes delegated help and watch invocations through the repo-local vitest entry with the recursion guard env set', async () => {
    const rustHelpPhase: UpstreamPhase = {
      runner: 'cargo',
      args: ['test', '-p', 'freshell-server', '--locked', '--help'],
    }
    const watchPhase: UpstreamPhase = {
      runner: 'vitest',
      config: 'default',
      args: ['--watch'],
    }

    expect(await runUpstreamPhase(rustHelpPhase, fakeEnv())).toBe(0)
    expect(await runUpstreamPhase(watchPhase, fakeEnv())).toBe(0)

    const captures = await readCaptureLines()
    expect(captures).toHaveLength(2)
    expect(captures[0]).toMatchObject({
      selector: 'cargo:test -p freshell-server --locked --help',
      command: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
      args: ['test', '-p', 'freshell-server', '--locked', '--help'],
      active: '1',
    })
    expect(captures[1]).toMatchObject({
      selector: 'vitest:default:--watch',
      command: process.execPath,
      args: [expectedVitestEntrypoint, '--watch'],
      active: '1',
    })
  })

  it('propagates exact numeric exit codes from upstream children', async () => {
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'build',
      args: [],
    }, fakeEnv({
      'npm:build': { exitCode: 23 },
    }))

    expect(exitCode).toBe(23)
  })

  it('returns the conventional nonzero exit code when an upstream child exits by signal', async () => {
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'typecheck',
      args: [],
    }, fakeEnv({
      'npm:typecheck': { signal: 'SIGTERM' },
    }))

    const expectedExitCode = process.platform === 'win32'
      ? 1
      : 128 + osConstants.signals.SIGTERM
    expect(exitCode).toBe(expectedExitCode)
  })

  it('rejects recursive public coordinator entry', () => {
    expect(() => assertNoCoordinatorRecursion({
      FRESHELL_TEST_COORDINATOR_ACTIVE: '1',
    })).toThrow(/recursive/i)
  })

  it('runs script phases through pnpm without a separator when the repo root pins pnpm', async () => {
    const repoRoot = await makeRepoRootFixture({ packageManager: 'pnpm@10.34.5' })
    const phase: UpstreamPhase = { runner: 'npm', script: 'test:balanced', args: ['--reporter=dot'] }

    expect(await runUpstreamPhase(phase, fakeEnv({}, { repoRoot }))).toBe(0)

    const [capture] = await readCaptureLines()
    expect(capture).toMatchObject({
      selector: 'npm:test:balanced --reporter=dot',
      command: process.execPath,
      args: [fakePnpmEntry, 'run', 'test:balanced', '--reporter=dot'],
    })
  })

  it('keeps the npm separator for script phases in a repo root without the packageManager field', async () => {
    const repoRoot = await makeRepoRootFixture({ name: 'legacy-repo' })
    const phase: UpstreamPhase = { runner: 'npm', script: 'test:balanced', args: ['--reporter=dot'] }

    expect(await runUpstreamPhase(phase, fakeEnv({}, { repoRoot, npmExecpath: fakeNpmEntry }))).toBe(0)

    const [capture] = await readCaptureLines()
    expect(capture).toMatchObject({
      selector: 'npm:test:balanced --reporter=dot',
      command: process.execPath,
      args: [fakeNpmEntry, 'run', 'test:balanced', '--', '--reporter=dot'],
    })
  })
})
