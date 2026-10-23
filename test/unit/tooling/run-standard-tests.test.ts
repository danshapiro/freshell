import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildCloudCompanionRun,
  buildVitestArgs,
  createStandardTestPlan,
  parseLocalOnlyTestDirs,
  resolveCloudCompanionScope,
  resolveDesktopWorkerPlan,
  resolvePriorityValue,
  resolveScriptPhaseCommand,
  type StandardTestRun,
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

  it('puts the prebuild safety guard before source-runtime artifact writers', () => {
    expect(buildSourceRuntimePhases('npm')).toEqual([
      { command: 'npm', args: ['run', 'prebuild'] },
      { command: 'npm', args: ['run', 'build:client'] },
      { command: 'npm', args: ['run', 'build:tools'] },
      { command: 'cargo', args: ['build', '--release', '-p', 'freshell-server', '--locked'] },
    ])
  })

  describe('parseLocalOnlyTestDirs', () => {
    it('extracts test-directory exclusions from dockerignore content in file order', () => {
      const text = [
        '# Build artifacts (rebuilt in Docker — never copy from host)',
        '.worktrees/',
        'node_modules/',
        '/test/server/',
        '/test/unit/server/',
        '/test/integration/server/',
        'docs/plans/',
        '',
      ].join('\n')
      expect(parseLocalOnlyTestDirs(text)).toEqual([
        'test/server',
        'test/unit/server',
        'test/integration/server',
      ])
    })

    it('ignores comments, re-includes, and glob patterns', () => {
      expect(parseLocalOnlyTestDirs([
        '# /test/commented/',
        '!test/re-included/',
        '/test/globbed/*/',
        '/test/star*/',
        'port/*',
        '',
      ].join('\n'))).toEqual([])
    })

    it('accepts paths without a leading slash and with or without a trailing slash', () => {
      expect(parseLocalOnlyTestDirs('test/integration/server\ntest/server\n')).toEqual([
        'test/integration/server',
        'test/server',
      ])
    })

    it('deduplicates repeated entries', () => {
      expect(parseLocalOnlyTestDirs('/test/integration/server/\n/test/integration/server/\n')).toEqual([
        'test/integration/server',
      ])
    })

    it('ignores non-test paths and nested build-artifact re-includes', () => {
      expect(parseLocalOnlyTestDirs([
        '/server/',
        'dist/',
        'test/fixtures/distribution/rust-only/dist/*',
        '',
      ].join('\n'))).toEqual([])
    })
  })

  describe('resolveCloudCompanionScope', () => {
    const localOnlyDirs = ['test/integration/server']

    it('runs every local-only dir on a broad run with no path selectors', () => {
      expect(resolveCloudCompanionScope([], localOnlyDirs)).toEqual(['test/integration/server'])
      expect(resolveCloudCompanionScope(['--reporter=basic'], localOnlyDirs))
        .toEqual(['test/integration/server'])
    })

    it('narrows to the local-only paths a mixed selector intersects', () => {
      expect(resolveCloudCompanionScope(
        [
          'test/unit/client/lib/foo.test.ts',
          'test/integration/server/managed-provider-parity.test.ts',
        ],
        localOnlyDirs,
      )).toEqual(['test/integration/server/managed-provider-parity.test.ts'])
    })

    it('skips focused runs that do not intersect the local-only dirs', () => {
      expect(resolveCloudCompanionScope(['test/unit/client/store/foo.test.ts'], localOnlyDirs))
        .toEqual([])
    })

    it('matches the directory itself when it is passed as a selector', () => {
      expect(resolveCloudCompanionScope(['test/integration/server'], localOnlyDirs))
        .toEqual(['test/integration/server'])
    })

    it('normalizes Windows separators and ./ prefixes before matching', () => {
      expect(resolveCloudCompanionScope(
        ['./test/integration/server\\provider-parity-contract.test.ts'],
        localOnlyDirs,
      )).toEqual(['test/integration/server/provider-parity-contract.test.ts'])
    })
  })

  describe('buildCloudCompanionRun', () => {
    it('uses normal priority in aggressive mode', () => {
      expect(buildCloudCompanionRun({
        mode: 'aggressive',
        scope: ['test/integration/server'],
      }).priority).toBe('normal')
    })
  })

  describe('resolveScriptPhaseCommand', () => {
    const sourceRuntimeRun: StandardTestRun = {
      name: 'source-runtime',
      runner: 'npm',
      script: 'test:source-runtime',
      priority: 'background',
    }
    const rustRun: StandardTestRun = {
      name: 'rust',
      runner: 'npm',
      script: 'test:rust',
      priority: 'background',
    }
    const pnpmEntry = path.join(os.tmpdir(), 'freshell-pnpm-entry', 'pnpm.cjs')
    const npmEntry = path.join(os.tmpdir(), 'freshell-npm-entry', 'npm-cli.js')

    it('forwards source-runtime selectors through pnpm without a separator', () => {
      const command = resolveScriptPhaseCommand(
        sourceRuntimeRun,
        ['test/integration/tooling/source-runtime-rust.test.ts'],
        'pnpm',
        { npm_execpath: pnpmEntry },
      )
      expect(command).toEqual({
        command: process.execPath,
        args: [pnpmEntry, 'run', 'test:source-runtime', 'test/integration/tooling/source-runtime-rust.test.ts'],
      })
    })

    it('preserves the npm separator for source-runtime selectors in legacy npm roots', () => {
      const command = resolveScriptPhaseCommand(
        sourceRuntimeRun,
        ['test/integration/tooling/source-runtime-rust.test.ts'],
        'npm',
        { npm_execpath: npmEntry },
      )
      expect(command).toEqual({
        command: process.execPath,
        args: [npmEntry, 'run', 'test:source-runtime', '--', 'test/integration/tooling/source-runtime-rust.test.ts'],
      })
    })

    it('never forwards selectors to the rust lane under either manager', () => {
      expect(resolveScriptPhaseCommand(rustRun, ['test/server/ws-protocol.test.ts'], 'pnpm', { npm_execpath: pnpmEntry }))
        .toEqual({ command: process.execPath, args: [pnpmEntry, 'run', 'test:rust'] })
      expect(resolveScriptPhaseCommand(rustRun, ['test/server/ws-protocol.test.ts'], 'npm', { npm_execpath: npmEntry }))
        .toEqual({ command: process.execPath, args: [npmEntry, 'run', 'test:rust'] })
    })
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
