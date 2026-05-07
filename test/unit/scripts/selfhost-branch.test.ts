import { describe, expect, it, vi } from 'vitest'
import { validateLaunchBranch } from '../../../scripts/selfhost-branch.js'

describe('selfhost branch CLI helper', () => {
  it('returns success on dev', async () => {
    const result = await validateLaunchBranch({
      env: {},
      getBranch: async () => 'dev',
    })

    expect(result).toEqual({ ok: true, branch: 'dev' })
  })

  it('returns a clear error on main', async () => {
    const result = await validateLaunchBranch({
      env: {},
      getBranch: async () => 'main',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("Refusing to self-host from local 'main'")
    }
  })

  it('rejects main even when FRESHELL_SELFHOST_BRANCH is main', async () => {
    const result = await validateLaunchBranch({
      env: { FRESHELL_SELFHOST_BRANCH: 'main' },
      getBranch: async () => 'main',
    })

    expect(result.ok).toBe(false)
  })

  it('surfaces git branch lookup failures', async () => {
    const result = await validateLaunchBranch({
      env: {},
      getBranch: vi.fn(async () => undefined),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Could not determine the current Git branch')
    }
  })
})
