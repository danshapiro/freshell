import { describe, expect, it } from 'vitest'

import {
  buildVitestArgs,
  createStandardTestPlan,
  resolveDesktopWorkerPlan,
  resolvePriorityValue,
} from '../../../scripts/run-standard-tests.js'
import { buildSourceRuntimePhases } from '../../../scripts/testing/run-source-runtime-tests.js'

describe('run-standard-tests', () => {
  describe('resolveDesktopWorkerPlan', () => {
    it('caps the shared desktop budget on large machines', () => {
      expect(resolveDesktopWorkerPlan(32)).toEqual({
        clientWorkers: '5',
        rustWorkers: '3',
      })
    })

    it('keeps client and Rust lanes parallel on smaller machines', () => {
      expect(resolveDesktopWorkerPlan(8)).toEqual({
        clientWorkers: '2',
        rustWorkers: '2',
      })
    })

    it('biases the shared budget toward the slower client lane', () => {
      expect(resolveDesktopWorkerPlan(20)).toEqual({
        clientWorkers: '3',
        rustWorkers: '2',
      })
    })
  })

  describe('buildVitestArgs', () => {
    it('does not make a narrowed selector vacuous', () => {
      expect(buildVitestArgs({
        maxWorkers: '5',
        forwardedArgs: ['test/unit/tooling/prebuild-guard.test.ts'],
      })).toEqual([
        'run',
        '--maxWorkers',
        '5',
        'test/unit/tooling/prebuild-guard.test.ts',
      ])
    })

    it('includes config when present', () => {
      expect(buildVitestArgs({
        configPath: 'config/vitest/vitest.config.ts',
        maxWorkers: '3',
        forwardedArgs: ['-t', 'prebuild'],
      })).toEqual([
        'run',
        '--config',
        'config/vitest/vitest.config.ts',
        '--maxWorkers',
        '3',
        '-t',
        'prebuild',
      ])
    })
  })

  describe('createStandardTestPlan', () => {
    it('uses sequential artifact-owning phases outside CI', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: [],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [{ name: 'client', runner: 'vitest', configPath: 'config/vitest/vitest.config.ts', maxWorkers: '5', priority: 'background' }],
          [{ name: 'source-runtime', runner: 'npm', script: 'test:source-runtime', priority: 'background' }],
          [{ name: 'rust', runner: 'npm', script: 'test:rust', priority: 'background' }],
          [{ name: 'electron', runner: 'vitest', configPath: 'config/vitest/vitest.electron.config.ts', priority: 'background' }],
        ],
      })
    })

    it('switches to the aggressive plan in CI by default', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: true,
        forwardedArgs: [],
      }).stages.flat().map((run) => run.name)).toEqual(['client', 'source-runtime', 'rust', 'electron'])
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: true,
        forwardedArgs: [],
      }).mode).toBe('aggressive')
    })

    it('routes Rust-targeted paths to the Rust lane only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/server/ws-protocol.test.ts'],
      }).stages.flat().map((run) => run.name)).toEqual(['rust'])
    })

    it('routes source-runtime integration paths to the source-runtime lane only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/integration/tooling/source-runtime-rust.test.ts'],
      }).stages.flat().map((run) => run.name)).toEqual(['source-runtime'])
    })

    it('routes Electron paths to the Electron lane only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/unit/electron/menu.test.ts'],
      }).stages.flat().map((run) => run.name)).toEqual(['electron'])
    })

    it('routes absolute Rust paths to the Rust lane only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['/home/user/code/freshell/test/server/ws-protocol.test.ts'],
      }).stages.flat().map((run) => run.name)).toEqual(['rust'])
    })
  })

  it('puts the prebuild safety guard before source-runtime artifact writers', () => {
    expect(buildSourceRuntimePhases('npm')).toEqual([
      { command: 'npm', args: ['run', 'prebuild'] },
      { command: 'npm', args: ['run', 'build:client'] },
      { command: 'npm', args: ['run', 'build:tools'] },
      { command: 'cargo', args: ['build', '--release', '-p', 'freshell-server', '--locked'] },
    ])
  })

  describe('resolvePriorityValue', () => {
    it('uses a below-normal priority class on Windows', () => {
      expect(resolvePriorityValue('background', 'win32')).not.toBe(resolvePriorityValue('normal', 'win32'))
    })

    it('uses a positive nice value on Unix-like systems', () => {
      expect(resolvePriorityValue('background', 'linux')).toBe(10)
      expect(resolvePriorityValue('normal', 'linux')).toBe(0)
    })
  })
})
