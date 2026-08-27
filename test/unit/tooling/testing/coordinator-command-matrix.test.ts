import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  classifyCommand,
  type UpstreamPhase,
} from '../../../../scripts/testing/coordinator-command-matrix.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(TEST_DIR, '../../../..')

function expectPhase(disposition: ReturnType<typeof classifyCommand>, expected: UpstreamPhase): void {
  if (disposition.kind === 'rejected') {
    throw new Error(disposition.reason)
  }
  expect(disposition.phases).toEqual([expected])
}

describe('coordinator command matrix', () => {
  it('coordinates the full test/check/verify workloads through the standard Rust-first runner', () => {
    for (const commandKey of ['test', 'test:all', 'check', 'verify'] as const) {
      const disposition = classifyCommand({ commandKey, forwardedArgs: [] })
      expect(disposition).toMatchObject({
        kind: 'coordinated',
        suiteKey: 'full-suite',
        phases: [{ runner: 'npm', script: 'test:balanced', args: [] }],
      })
    }
  })

  it('uses explicit Rust cargo phases for server and integration commands', () => {
    expect(classifyCommand({ commandKey: 'test:server', forwardedArgs: [] })).toEqual({
      kind: 'coordinated',
      suiteKey: 'rust:server',
      phases: [{ runner: 'cargo', args: ['test', '-p', 'freshell-server', '--locked'] }],
    })
    expect(classifyCommand({ commandKey: 'test:integration', forwardedArgs: [] })).toEqual({
      kind: 'coordinated',
      suiteKey: 'rust:integration',
      phases: [{ runner: 'cargo', args: ['test', '--workspace', '--tests', '--locked'] }],
    })
  })

  it('keeps help/version requests on the Cargo lane instead of starting a broad test run', () => {
    expect(classifyCommand({ commandKey: 'test:server', forwardedArgs: ['--help'] })).toEqual({
      kind: 'passthrough',
      phases: [{ runner: 'cargo', args: ['test', '-p', 'freshell-server', '--locked', '--help'] }],
    })
  })

  it('keeps unit and client commands on the default config', () => {
    expect(classifyCommand({ commandKey: 'test:unit', forwardedArgs: [] })).toEqual({
      kind: 'coordinated',
      suiteKey: 'default:test/unit',
      phases: [{ runner: 'vitest', config: 'default', args: ['run', '--config', 'config/vitest/vitest.config.ts', 'test/unit'] }],
    })
    expect(classifyCommand({ commandKey: 'test:client', forwardedArgs: [] })).toEqual({
      kind: 'coordinated',
      suiteKey: 'default:test/unit/client',
      phases: [{ runner: 'vitest', config: 'default', args: ['run', '--config', 'config/vitest/vitest.config.ts', 'test/unit/client'] }],
    })
  })

  it('rejects the retired server config with a Rust-lane hint', () => {
    const disposition = classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['run', '--config', ['config/vitest', 'server.config.ts'].join('/')],
    })
    expect(disposition.kind).toBe('rejected')
    if (disposition.kind === 'rejected') {
      expect(disposition.reason).toContain('Rust cargo lane')
    }
  })

  it('never emits passWithNoTests and accepts direct retained Vitest configs', () => {
    const disposition = classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['run', '--config', 'config/vitest/vitest.runtime.config.ts', 'test/integration/tooling/source-runtime-rust.test.ts'],
    })
    expectPhase(disposition, {
      runner: 'vitest',
      config: 'direct',
      args: ['run', '--config', 'config/vitest/vitest.runtime.config.ts', 'test/integration/tooling/source-runtime-rust.test.ts'],
    })
    expect(JSON.stringify(disposition)).not.toContain('passWithNoTests')
  })

  it('keeps the package command inventory free of deleted server scripts', async () => {
    const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const deletedScripts = [
      'typecheck:server',
      'build:server',
      'test:server:standard',
      'test:server:aggressive',
      ['test:real', 'coding-cli-contracts'].join(':'),
    ]
    for (const key of deletedScripts) {
      expect(packageJson.scripts?.[key]).toBeUndefined()
    }
  })
})
