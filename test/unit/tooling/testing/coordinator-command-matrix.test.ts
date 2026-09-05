import { describe, expect, it } from 'vitest'

import {
  classifyCommand,
  type UpstreamPhase,
} from '../../../../scripts/testing/coordinator-command-matrix.js'

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

  it('keeps bare and selector-based test:vitest invocations on the default config', () => {
    expect(classifyCommand({ commandKey: 'test:vitest', forwardedArgs: [] })).toEqual({
      kind: 'passthrough',
      phases: [{ runner: 'vitest', config: 'default', args: ['--config', 'config/vitest/vitest.config.ts'] }],
    })
    expect(classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['run', 'test/unit/tooling/testing/coordinator-command-matrix.test.ts'],
    })).toEqual({
      kind: 'passthrough',
      phases: [{
        runner: 'vitest',
        config: 'default',
        args: ['run', '--config', 'config/vitest/vitest.config.ts', 'test/unit/tooling/testing/coordinator-command-matrix.test.ts'],
      }],
    })
  })

  it.each([
    'config/vitest/server.config.ts',
    'config/vitest/vitest.server.config.ts',
    'test/server/ws-protocol.test.ts',
    './test/server/ws-protocol.test.ts',
  ])('rejects retired server selectors (%s) with a Rust-lane hint', (selector) => {
    const disposition = classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['run', '--config', selector],
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

  it.each(['test/server/ws-protocol.test.ts', './test/server/ws-protocol.test.ts', 'crates/freshell-server/src/main.rs'])
    ('rejects Rust/path selectors in composite commands instead of passing them to Cargo as test names (%s)', (selector) => {
      for (const commandKey of ['test', 'test:all', 'check', 'verify'] as const) {
        const disposition = classifyCommand({ commandKey, forwardedArgs: ['--run', selector] })
        expect(disposition.kind).toBe('rejected')
        if (disposition.kind === 'rejected') {
          expect(disposition.reason).toContain('Rust/path selectors')
        }
      }
    })

})
