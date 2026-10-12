import { describe, expect, it } from 'vitest'
import {
  resolveManagedProviderEnvironmentTargetMode,
  runManagedProviderEnvironmentTarget,
} from '../../../../scripts/testing/managed-provider-environment-target.js'

describe('managed provider environment target mode', () => {
  it('keeps the existing managed target as the default and selects checkpoint only explicitly', () => {
    expect(resolveManagedProviderEnvironmentTargetMode([])).toBe('managed-environment')
    expect(resolveManagedProviderEnvironmentTargetMode(['--checkpoint'])).toBe('code-checkpoint')
  })

  it.each([['--managed'], ['--checkpoint', '--checkpoint'], ['--checkpoint', 'other'], ['--unknown']])(
    'rejects unsupported or ambiguous target arguments %j', (...args) => {
      expect(() => resolveManagedProviderEnvironmentTargetMode(args)).toThrow(/usage/i)
    },
  )

  it('fails closed on a local backend instead of falling back from checkpoint mode', async () => {
    const priorBackend = process.env.FRESHELL_E2E_BACKEND
    process.env.FRESHELL_E2E_BACKEND = 'local'
    try {
      await expect(runManagedProviderEnvironmentTarget(['--checkpoint']))
        .rejects.toThrow('Checkpoint acceptance requires configured Cloud')
    } finally {
      if (priorBackend === undefined) delete process.env.FRESHELL_E2E_BACKEND
      else process.env.FRESHELL_E2E_BACKEND = priorBackend
    }
  })
})
