import { describe, expect, it } from 'vitest'

import {
  buildVitestArgs,
  createStandardTestPlan,
  parseStandardTestCliArgs,
  resolveDesktopWorkerPlan,
  resolvePriorityValue,
  resolveStandardTestExecution,
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

    it('routes Electron integration paths to the dedicated Electron runtime lane', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/integration/electron/checkout-free-runtime.test.ts'],
      }).stages.flat()).toEqual([{
        name: 'electron-runtime',
        runner: 'vitest',
        configPath: 'config/vitest/vitest.electron-runtime.config.ts',
        priority: 'background',
      }])
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

  describe('parseStandardTestCliArgs', () => {
    it('strips runner-only mode and skip-suite flags from the forwarded arguments', () => {
      expect(parseStandardTestCliArgs(['--mode', 'aggressive', '--skip-suite=client', '-t', 'prebuild', '--skip-suite', 'electron'])).toEqual({
        mode: 'aggressive',
        skipSuites: ['client', 'electron'],
        forwardedArgs: ['-t', 'prebuild'],
      })
    })

    it('rejects an unknown suite name instead of silently running it', () => {
      expect(() => parseStandardTestCliArgs(['--skip-suite=clients'])).toThrow(/clients/)
    })
  })

  describe('resolveStandardTestExecution', () => {
    const stageNames = (stages: Array<Array<{ name: string }>>) => stages.map((stage) => stage[0]?.name)
    const base = { availableParallelism: 32, ci: false }

    it('dispatches the client lane to the cloud script and keeps the other lanes local', () => {
      const execution = resolveStandardTestExecution({ ...base, argv: [], env: { FRESHELL_VITEST_BACKEND: 'cloud' } })
      expect(execution.cloudClient).toEqual({
        command: expect.stringMatching(/scripts[\\/]vitest-cloud\.sh$/),
        args: ['run', '--cloud', '--config=default'],
      })
      expect(stageNames(execution.localStages)).toEqual(['source-runtime', 'rust', 'electron'])
    })

    it('honors an injected cloud script and forwards Vitest arguments without runner-only flags', () => {
      const execution = resolveStandardTestExecution({
        ...base,
        argv: ['--mode=aggressive', '-t', 'prebuild'],
        env: { FRESHELL_VITEST_BACKEND: 'cloud', FRESHELL_VITEST_CLOUD_SCRIPT: '/fake/cloud.sh' },
      })
      expect(execution.cloudClient).toEqual({
        command: '/fake/cloud.sh',
        args: ['run', '--cloud', '--config=default', '-t', 'prebuild'],
      })
    })

    it('neither dispatches nor runs the client lane when the coordinator owns it', () => {
      const execution = resolveStandardTestExecution({ ...base, argv: ['--skip-suite=client'], env: { FRESHELL_VITEST_BACKEND: 'cloud' } })
      expect(execution.cloudClient).toBeUndefined()
      expect(stageNames(execution.localStages)).toEqual(['source-runtime', 'rust', 'electron'])
    })

    it('runs every lane locally for git-dependent selectors and reports the fallback', () => {
      const execution = resolveStandardTestExecution({ ...base, argv: ['--changed'], env: { FRESHELL_VITEST_BACKEND: 'cloud' } })
      expect(execution.cloudClient).toBeUndefined()
      expect(execution.gitDependentCloudFallback).toBe(true)
      expect(stageNames(execution.localStages)).toEqual(['client', 'source-runtime', 'rust', 'electron'])
    })

    it('runs every lane locally with the local backend', () => {
      const execution = resolveStandardTestExecution({ ...base, argv: [], env: {} })
      expect(execution.cloudClient).toBeUndefined()
      expect(execution.gitDependentCloudFallback).toBe(false)
      expect(stageNames(execution.localStages)).toEqual(['client', 'source-runtime', 'rust', 'electron'])
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
