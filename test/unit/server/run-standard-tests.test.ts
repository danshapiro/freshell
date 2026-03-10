import { describe, expect, it } from 'vitest'
import {
  buildVitestArgs,
  createStandardTestPlan,
  resolveDesktopWorkerPlan,
  resolvePriorityValue,
} from '../../../scripts/run-standard-tests.js'

describe('run-standard-tests', () => {
  describe('resolveDesktopWorkerPlan', () => {
    it('caps the shared desktop budget on large machines', () => {
      expect(resolveDesktopWorkerPlan(32)).toEqual({
        clientWorkers: '5',
        serverWorkers: '3',
      })
    })

    it('keeps both suites parallel on smaller machines', () => {
      expect(resolveDesktopWorkerPlan(8)).toEqual({
        clientWorkers: '2',
        serverWorkers: '2',
      })
    })

    it('biases the shared budget toward the slower client suite', () => {
      expect(resolveDesktopWorkerPlan(20)).toEqual({
        clientWorkers: '3',
        serverWorkers: '2',
      })
    })
  })

  describe('buildVitestArgs', () => {
    it('adds passWithNoTests so forwarded file filters do not fail sibling suites', () => {
      expect(buildVitestArgs({
        maxWorkers: '5',
        forwardedArgs: ['test/unit/server/prebuild-guard.test.ts'],
      })).toEqual([
        'run',
        '--passWithNoTests',
        '--maxWorkers',
        '5',
        'test/unit/server/prebuild-guard.test.ts',
      ])
    })

    it('includes config when present', () => {
      expect(buildVitestArgs({
        configPath: 'vitest.server.config.ts',
        maxWorkers: '3',
        forwardedArgs: ['-t', 'prebuild'],
      })).toEqual([
        'run',
        '--passWithNoTests',
        '--config',
        'vitest.server.config.ts',
        '--maxWorkers',
        '3',
        '-t',
        'prebuild',
      ])
    })
  })

  describe('createStandardTestPlan', () => {
    it('uses the desktop-balanced two-stage plan outside CI', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: [],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [
            { name: 'client', maxWorkers: '5', priority: 'background' },
            { name: 'server', configPath: 'vitest.server.config.ts', maxWorkers: '3', priority: 'background' },
          ],
          [
            { name: 'electron', configPath: 'vitest.electron.config.ts', priority: 'background' },
          ],
        ],
      })
    })

    it('switches to the aggressive plan in CI by default', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: true,
        forwardedArgs: [],
      })).toEqual({
        mode: 'aggressive',
        stages: [
          [
            { name: 'client', maxWorkers: '50%', priority: 'normal' },
            { name: 'server', configPath: 'vitest.server.config.ts', maxWorkers: '50%', priority: 'normal' },
            { name: 'electron', configPath: 'vitest.electron.config.ts', priority: 'normal' },
          ],
        ],
      })
    })

    it('allows the mode to be forced explicitly', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        mode: 'aggressive',
        forwardedArgs: [],
      }).mode).toBe('aggressive')
    })

    it('routes server-targeted paths to the server suite only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/unit/server/run-standard-tests.test.ts'],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [
            { name: 'server', configPath: 'vitest.server.config.ts', maxWorkers: '3', priority: 'background' },
          ],
        ],
      })
    })

    it('routes electron-targeted paths to the electron suite only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['test/unit/electron/menu.test.ts'],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [
            { name: 'electron', configPath: 'vitest.electron.config.ts', priority: 'background' },
          ],
        ],
      })
    })

    it('routes absolute server paths to the server suite only', () => {
      expect(createStandardTestPlan({
        availableParallelism: 32,
        ci: false,
        forwardedArgs: ['/home/user/code/freshell/test/unit/server/run-standard-tests.test.ts'],
      })).toEqual({
        mode: 'desktop',
        stages: [
          [
            { name: 'server', configPath: 'vitest.server.config.ts', maxWorkers: '3', priority: 'background' },
          ],
        ],
      })
    })
  })

  describe('resolvePriorityValue', () => {
    it('uses a below-normal priority class on windows', () => {
      expect(resolvePriorityValue('background', 'win32')).not.toBe(resolvePriorityValue('normal', 'win32'))
    })

    it('uses a positive nice value on unix-like systems', () => {
      expect(resolvePriorityValue('background', 'linux')).toBe(10)
      expect(resolvePriorityValue('normal', 'linux')).toBe(0)
    })
  })
})
