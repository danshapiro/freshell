import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  classifyCommand,
  type CommandDisposition,
  type CommandKey,
  type UpstreamPhase,
} from '../../../../scripts/testing/coordinator-command-matrix.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')

function expectVitestPhase(
  phase: UpstreamPhase,
  expected: {
    config: 'default' | 'server'
    args: string[]
  },
) {
  expect(phase).toMatchObject({
    runner: 'vitest',
    config: expected.config,
    args: expected.args,
  })
}

function expectSinglePhase(
  disposition: CommandDisposition,
  expected: {
    kind: 'coordinated' | 'delegated' | 'passthrough'
    config: 'default' | 'server'
    args: string[]
    suiteKey?: string
  },
) {
  expect(disposition.kind).toBe(expected.kind)
  if (expected.kind === 'coordinated') {
    expect(disposition.suiteKey).toBe(expected.suiteKey)
  }
  expect(disposition.phases).toHaveLength(1)
  expectVitestPhase(disposition.phases[0], {
    config: expected.config,
    args: expected.args,
  })
}

describe('classifyCommand()', () => {
  it.each([
    {
      commandKey: 'test',
      expected: {
        kind: 'coordinated',
        suiteKey: 'full-suite',
        phases: [
          { config: 'default', args: ['run'] },
          { config: 'server', args: ['run', '--config', 'vitest.server.config.ts'] },
        ],
      },
    },
    {
      commandKey: 'test:all',
      expected: {
        kind: 'coordinated',
        suiteKey: 'full-suite',
        phases: [
          { config: 'default', args: ['run'] },
          { config: 'server', args: ['run', '--config', 'vitest.server.config.ts'] },
        ],
      },
    },
    {
      commandKey: 'check',
      expected: {
        kind: 'coordinated',
        suiteKey: 'full-suite',
        phases: [
          { config: 'default', args: ['run'] },
          { config: 'server', args: ['run', '--config', 'vitest.server.config.ts'] },
        ],
      },
    },
    {
      commandKey: 'verify',
      expected: {
        kind: 'coordinated',
        suiteKey: 'full-suite',
        phases: [
          { config: 'default', args: ['run'] },
          { config: 'server', args: ['run', '--config', 'vitest.server.config.ts'] },
        ],
      },
    },
    {
      commandKey: 'test:coverage',
      expected: {
        kind: 'coordinated',
        suiteKey: 'default:coverage',
        phases: [
          { config: 'default', args: ['run', '--coverage'] },
        ],
      },
    },
    {
      commandKey: 'test:unit',
      expected: {
        kind: 'coordinated',
        suiteKey: 'default:test/unit',
        phases: [
          { config: 'default', args: ['run', 'test/unit'] },
        ],
      },
    },
    {
      commandKey: 'test:client',
      expected: {
        kind: 'coordinated',
        suiteKey: 'default:test/unit/client',
        phases: [
          { config: 'default', args: ['run', 'test/unit/client'] },
        ],
      },
    },
    {
      commandKey: 'test:integration',
      expected: {
        kind: 'coordinated',
        suiteKey: 'server:test/server',
        phases: [
          { config: 'server', args: ['run', '--config', 'vitest.server.config.ts', 'test/server'] },
        ],
      },
    },
    {
      commandKey: 'test:server',
      expected: {
        kind: 'delegated',
        phases: [
          { config: 'server', args: ['--config', 'vitest.server.config.ts'] },
        ],
      },
    },
    {
      commandKey: 'test:watch',
      expected: {
        kind: 'passthrough',
        phases: [
          { config: 'default', args: [] },
        ],
      },
    },
    {
      commandKey: 'test:ui',
      expected: {
        kind: 'passthrough',
        phases: [
          { config: 'default', args: ['--ui'] },
        ],
      },
    },
    {
      commandKey: 'test:vitest',
      expected: {
        kind: 'passthrough',
        phases: [
          { config: 'default', args: [] },
        ],
      },
    },
  ])('freezes the no-arg matrix for $commandKey', ({ commandKey, expected }) => {
    const disposition = classifyCommand({ commandKey: commandKey as CommandKey, forwardedArgs: [] })

    expect(disposition.kind).toBe(expected.kind)
    if (disposition.kind === 'coordinated') {
      expect(disposition.suiteKey).toBe(expected.suiteKey)
    }
    expect(disposition.phases).toHaveLength(expected.phases.length)
    expected.phases.forEach((phase, index) => {
      expectVitestPhase(disposition.phases[index], phase)
    })
  })

  it('keeps test:unit mapped to the default-config test/unit workload', () => {
    const disposition = classifyCommand({ commandKey: 'test:unit', forwardedArgs: [] })

    expect(disposition).toMatchObject({
      kind: 'coordinated',
      suiteKey: 'default:test/unit',
    })
  })

  it('keeps test:integration mapped to the server-config test/server workload', () => {
    const disposition = classifyCommand({ commandKey: 'test:integration', forwardedArgs: [] })

    expect(disposition).toMatchObject({
      kind: 'coordinated',
      suiteKey: 'server:test/server',
    })
  })

  it('preserves test:server default delegation and coordinates only explicit broad --run', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test:server',
      forwardedArgs: [],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:server',
      forwardedArgs: ['--run'],
    }), {
      kind: 'coordinated',
      suiteKey: 'server:all:run',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', '--run'],
    })
  })

  it('delegates narrowed paths to the truthful owning config', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['test/unit/server/coding-cli/utils.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/unit/server/coding-cli/utils.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['test/unit/server/terminal-registry.test.ts', '-t', 'reaping exited terminals'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/unit/server/terminal-registry.test.ts', '-t', 'reaping exited terminals'],
    })
  })

  it('always delegates watch and ui flows', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['--watch'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', 'test/unit', '--watch'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:coverage',
      forwardedArgs: ['--ui'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--coverage', '--ui'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--watch'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--watch'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--ui'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--ui'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:watch',
      forwardedArgs: ['test/server/ws-protocol.test.ts'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:ui',
      forwardedArgs: ['test/server/ws-protocol.test.ts'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', '--ui', 'test/server/ws-protocol.test.ts'],
    })
  })

  it('delegates composite commands when forwarded Vitest flags narrow behavior without changing config ownership', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--changed'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--changed'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--bail=1'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--bail=1'],
    })
  })

  it('bypasses coordination for help and version flags while preserving truthful target ownership', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--help'],
    }), {
      kind: 'passthrough',
      config: 'default',
      args: ['run', '--help'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:server',
      forwardedArgs: ['-v'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', '-v'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['test/server/ws-protocol.test.ts', '--help'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts', '--help'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['test/unit/server/coding-cli/utils.test.ts', '--help'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/unit/server/coding-cli/utils.test.ts', '--help'],
    })
  })

  it('rejects --reporter on composite commands and allows it on delegated single-phase commands', () => {
    const composite = classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--reporter', 'dot'],
    })

    expect(composite).toMatchObject({
      kind: 'rejected',
    })
    if (composite.kind === 'rejected') {
      expect(composite.reason).toContain('--reporter')
    }

    expectSinglePhase(classifyCommand({
      commandKey: 'test:client',
      forwardedArgs: ['--reporter', 'dot', 'test/unit/client/components/Sidebar.test.tsx'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--reporter', 'dot', 'test/unit/client/components/Sidebar.test.tsx'],
    })
  })

  it('rejects explicit --config overrides on public commands and directs callers to test:vitest', () => {
    const composite = classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--config', 'vitest.server.config.ts'],
    })

    expect(composite).toMatchObject({
      kind: 'rejected',
    })
    if (composite.kind === 'rejected') {
      expect(composite.reason).toContain('--config')
      expect(composite.reason).toContain('test:vitest')
    }

    const compositeWithTarget = classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    })
    expect(compositeWithTarget).toMatchObject({
      kind: 'rejected',
    })

    const singlePhase = classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['--config=vitest.server.config.ts'],
    })
    expect(singlePhase).toMatchObject({
      kind: 'rejected',
    })
    if (singlePhase.kind === 'rejected') {
      expect(singlePhase.reason).toContain('test:vitest')
    }

    const shortForm = classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['-c', 'vitest.server.config.ts'],
    })
    expect(shortForm).toMatchObject({
      kind: 'rejected',
    })
    if (shortForm.kind === 'rejected') {
      expect(shortForm.reason).toContain('--config')
      expect(shortForm.reason).toContain('test:vitest')
    }

    const shortFormEquals = classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['-c=vitest.server.config.ts'],
    })
    expect(shortFormEquals).toMatchObject({
      kind: 'rejected',
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['-c', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['-c', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    })
  })

  it('treats --run on test and test:all as a compatibility no-op', () => {
    expect(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--run'],
    })).toMatchObject({
      kind: 'coordinated',
      suiteKey: 'full-suite',
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:all',
      forwardedArgs: ['--run', 'test/unit/client/store/panesSlice.test.ts'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', 'test/unit/client/store/panesSlice.test.ts'],
    })
  })

  it('normalizes dotted and windows-style target paths before ownership detection', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['./test/server/ws-protocol.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', './test/server/ws-protocol.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['test\\server\\ws-protocol.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test\\server\\ws-protocol.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['./test/unit/server/coding-cli/utils.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', './test/unit/server/coding-cli/utils.test.ts'],
    })
  })

  it('rejects mixed client and server selectors on composite commands', () => {
    const disposition = classifyCommand({
      commandKey: 'test',
      forwardedArgs: [
        'test/unit/client/components/Sidebar.test.tsx',
        'test/unit/server/sessions-sync/diff.test.ts',
      ],
    })

    expect(disposition).toMatchObject({
      kind: 'rejected',
    })
    if (disposition.kind === 'rejected') {
      expect(disposition.reason).toContain('split the command')
    }
  })

  it('preserves the frozen real-world command forms', () => {
    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['test/unit/server/terminal-registry.test.ts', '-t', 'reaping exited terminals'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/unit/server/terminal-registry.test.ts', '-t', 'reaping exited terminals'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test',
      forwardedArgs: ['--run', 'test/unit/client/store/panesSlice.test.ts'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', 'test/unit/client/store/panesSlice.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:server',
      forwardedArgs: ['test/unit/server/sessions-sync/diff.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', 'test/unit/server/sessions-sync/diff.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:client',
      forwardedArgs: ['--run', 'test/unit/client/components/Sidebar.test.tsx'],
    }), {
      kind: 'delegated',
      config: 'default',
      args: ['run', '--run', 'test/unit/client/components/Sidebar.test.tsx'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:integration',
      forwardedArgs: ['test/integration/server/port-forward-api.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/integration/server/port-forward-api.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:unit',
      forwardedArgs: ['test/unit/server/coding-cli/utils.test.ts'],
    }), {
      kind: 'delegated',
      config: 'server',
      args: ['run', '--config', 'vitest.server.config.ts', 'test/unit/server/coding-cli/utils.test.ts'],
    })

    expectSinglePhase(classifyCommand({
      commandKey: 'test:vitest',
      forwardedArgs: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    }), {
      kind: 'passthrough',
      config: 'server',
      args: ['--config', 'vitest.server.config.ts', 'test/server/ws-protocol.test.ts'],
    })
  })

  it('rewires every public test script through the coordinator entrypoint and publishes direct status/vitest scripts', async () => {
    const packageJson = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const scripts = packageJson.scripts as Record<string, string>

    expect(scripts.test).toBe('tsx scripts/testing/test-coordinator.ts run test')
    expect(scripts['test:all']).toBe('tsx scripts/testing/test-coordinator.ts run test:all')
    expect(scripts.check).toBe('tsx scripts/testing/test-coordinator.ts run check')
    expect(scripts.verify).toBe('tsx scripts/testing/test-coordinator.ts run verify')
    expect(scripts['test:watch']).toBe('tsx scripts/testing/test-coordinator.ts run test:watch')
    expect(scripts['test:ui']).toBe('tsx scripts/testing/test-coordinator.ts run test:ui')
    expect(scripts['test:server']).toBe('tsx scripts/testing/test-coordinator.ts run test:server')
    expect(scripts['test:coverage']).toBe('tsx scripts/testing/test-coordinator.ts run test:coverage')
    expect(scripts['test:unit']).toBe('tsx scripts/testing/test-coordinator.ts run test:unit')
    expect(scripts['test:integration']).toBe('tsx scripts/testing/test-coordinator.ts run test:integration')
    expect(scripts['test:client']).toBe('tsx scripts/testing/test-coordinator.ts run test:client')
    expect(scripts['test:status']).toBe('tsx scripts/testing/test-coordinator.ts status')
    expect(scripts['test:vitest']).toBe('tsx scripts/testing/test-coordinator.ts run test:vitest')
  })
})
