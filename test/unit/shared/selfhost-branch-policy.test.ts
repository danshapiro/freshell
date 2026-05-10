import { describe, expect, it } from 'vitest'
import {
  classifySelfHostBranch,
  getExpectedSelfHostBranch,
  shouldSkipSourceUpdateForBranch,
} from '../../../shared/selfhost-branch-policy.js'

describe('selfhost branch policy', () => {
  it('defaults the expected self-host branch to dev', () => {
    expect(getExpectedSelfHostBranch({})).toBe('dev')
  })

  it('allows overriding the expected self-host branch', () => {
    expect(getExpectedSelfHostBranch({ FRESHELL_SELFHOST_BRANCH: 'dev/pr-queue' })).toBe('dev/pr-queue')
  })

  it('rejects self-host launch from main', () => {
    expect(classifySelfHostBranch({ branch: 'main', env: {} })).toEqual({
      ok: false,
      code: 'mirror-branch',
      message: "Refusing to self-host from local 'main'. Local 'main' must mirror 'origin/main'. Switch to 'dev' or set FRESHELL_SELFHOST_BRANCH.",
    })
  })

  it('rejects self-host launch from main even if configured by env', () => {
    expect(classifySelfHostBranch({
      branch: 'main',
      env: { FRESHELL_SELFHOST_BRANCH: 'main' },
    })).toMatchObject({
      ok: false,
      code: 'mirror-branch',
    })
  })

  it('accepts self-host launch from dev by default', () => {
    expect(classifySelfHostBranch({ branch: 'dev', env: {} })).toEqual({ ok: true, expectedBranch: 'dev' })
  })

  it('rejects unexpected non-main branches unless they are configured', () => {
    expect(classifySelfHostBranch({ branch: 'feature/x', env: {} })).toMatchObject({
      ok: false,
      code: 'unexpected-branch',
    })
  })

  it('accepts a configured non-main self-host branch', () => {
    expect(classifySelfHostBranch({
      branch: 'dev/pr-queue',
      env: { FRESHELL_SELFHOST_BRANCH: 'dev/pr-queue' },
    })).toEqual({ ok: true, expectedBranch: 'dev/pr-queue' })
  })

  it('skips source updates on dev and feature branches', () => {
    expect(shouldSkipSourceUpdateForBranch({ branch: 'dev', env: {} })).toBe(true)
    expect(shouldSkipSourceUpdateForBranch({ branch: 'feature/x', env: {} })).toBe(true)
  })

  it('does not skip source updates on main unless another skip condition applies', () => {
    expect(shouldSkipSourceUpdateForBranch({ branch: 'main', env: {} })).toBe(false)
  })

  it('skips source updates when the explicit skip env var is set', () => {
    expect(shouldSkipSourceUpdateForBranch({
      branch: 'main',
      env: { SKIP_UPDATE_CHECK: 'true' },
    })).toBe(true)
  })

  it('skips source updates when branch detection fails', () => {
    expect(shouldSkipSourceUpdateForBranch({ branch: undefined, env: {} })).toBe(true)
  })
})
