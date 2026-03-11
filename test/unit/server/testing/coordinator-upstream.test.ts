import { createRequire } from 'node:module'
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

let tempDir: string
let captureFile: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coordinator-upstream-'))
  captureFile = path.join(tempDir, 'capture.jsonl')
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

function fakeEnv(behavior: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FIXTURE_PATH,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify(behavior),
    FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: REPO_ROOT,
  }
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
    expect(command.args).toEqual([require.resolve('vitest/vitest.mjs')])
  })

  it('passes delegated help and watch invocations through the repo-local vitest entry with the recursion guard env set', async () => {
    const expectedVitest = require.resolve('vitest/vitest.mjs')
    const serverHelpPhase: UpstreamPhase = {
      runner: 'vitest',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', '--help'],
    }
    const watchPhase: UpstreamPhase = {
      runner: 'vitest',
      config: 'default',
      args: ['--watch'],
    }

    expect(await runUpstreamPhase(serverHelpPhase, fakeEnv())).toBe(0)
    expect(await runUpstreamPhase(watchPhase, fakeEnv())).toBe(0)

    const captures = await readCaptureLines()
    expect(captures).toHaveLength(2)
    expect(captures[0]).toMatchObject({
      selector: 'vitest:server:--config vitest.server.config.ts --help',
      command: process.execPath,
      args: [expectedVitest, '--config', 'vitest.server.config.ts', '--help'],
      active: '1',
    })
    expect(captures[1]).toMatchObject({
      selector: 'vitest:default:--watch',
      command: process.execPath,
      args: [expectedVitest, '--watch'],
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

    expect(exitCode).toBe(128 + osConstants.signals.SIGTERM)
  })

  it('rejects recursive public coordinator entry', () => {
    expect(() => assertNoCoordinatorRecursion({
      FRESHELL_TEST_COORDINATOR_ACTIVE: '1',
    })).toThrow(/recursive/i)
  })
})
