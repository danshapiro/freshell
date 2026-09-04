// test/unit/electron/profile-choice-handler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChooseProfileHandler } from '../../../electron/profile-choice-handler.js'

const entries = [
  { id: 'default', label: 'Default' },
  { id: 'work', label: 'Work' },
]

function harness(overrides: Partial<Parameters<typeof createChooseProfileHandler>[0]> = {}) {
  const deps = {
    entries,
    isAllowedSender: vi.fn().mockReturnValue(true),
    relaunchWithProfile: vi.fn(),
    ...overrides,
  }
  return { deps, handler: createChooseProfileHandler(deps) }
}

describe('choose-profile handler', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects events from a foreign sender', async () => {
    const { deps, handler } = harness({ isAllowedSender: () => false })
    expect(await handler({}, 'work')).toEqual({ ok: false, error: 'Unexpected profile request.' })
    expect(deps.relaunchWithProfile).not.toHaveBeenCalled()
  })

  it('rejects non-string and unknown ids', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 42)).toEqual({ ok: false, error: 'Unknown profile.' })
    expect(await handler({}, 'unknown')).toEqual({ ok: false, error: 'Unknown profile.' })
    expect(deps.relaunchWithProfile).not.toHaveBeenCalled()
  })

  it('the default choice relaunches as the explicit default profile', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 'default')).toEqual({ ok: true })
    expect(deps.relaunchWithProfile).toHaveBeenCalledWith('default')
  })

  it('a named profile relaunches with it', async () => {
    const { deps, handler } = harness()
    expect(await handler({}, 'work')).toEqual({ ok: true })
    expect(deps.relaunchWithProfile).toHaveBeenCalledWith('work')
  })
})
