import { describe, it, expect } from 'vitest'
import { computeAutoTitlePatch } from '../../../server/auto-title'

describe('computeAutoTitlePatch', () => {
  it('seeds the dir placeholder when there is no override and no first message yet', () => {
    expect(
      computeAutoTitlePatch({ cwd: '/home/dan/code/freshell', existing: undefined, aiWillAutoName: false }),
    ).toEqual({ titleOverride: 'freshell', titleSource: 'dir' })
  })

  it('finalizes from the first message when AI auto-naming is off', () => {
    expect(
      computeAutoTitlePatch({
        cwd: '/x/proj',
        firstUserMessage: 'Fix the login redirect bug',
        existing: undefined,
        aiWillAutoName: false,
      }),
    ).toEqual({ titleOverride: 'Fix the login redirect bug', titleSource: 'first-message' })
  })

  it('upgrades a dir placeholder to first-message when AI auto-naming is off', () => {
    expect(
      computeAutoTitlePatch({
        cwd: '/x/proj',
        firstUserMessage: 'Add a logout button',
        existing: { titleOverride: 'proj', titleSource: 'dir' },
        aiWillAutoName: false,
      }),
    ).toEqual({ titleOverride: 'Add a logout button', titleSource: 'first-message' })
  })

  it('leaves an existing dir placeholder untouched when AI will auto-name (AI finalizes via ai source)', () => {
    expect(
      computeAutoTitlePatch({
        cwd: '/x/proj',
        firstUserMessage: 'Add a logout button',
        existing: { titleOverride: 'proj', titleSource: 'dir' },
        aiWillAutoName: true,
      }),
    ).toBeNull()
  })

  it('still seeds the dir placeholder when AI will auto-name but no override exists yet', () => {
    expect(
      computeAutoTitlePatch({
        cwd: '/x/proj',
        firstUserMessage: 'Add a logout button',
        existing: undefined,
        aiWillAutoName: true,
      }),
    ).toEqual({ titleOverride: 'proj', titleSource: 'dir' })
  })

  it('never touches a finalized name', () => {
    expect(
      computeAutoTitlePatch({
        cwd: '/x/proj',
        firstUserMessage: 'whatever',
        existing: { titleOverride: 'My Name', titleSource: 'user' },
        aiWillAutoName: false,
      }),
    ).toBeNull()
    expect(
      computeAutoTitlePatch({
        cwd: '/x/proj',
        firstUserMessage: 'whatever',
        existing: { titleOverride: 'AI', titleSource: 'ai' },
        aiWillAutoName: false,
      }),
    ).toBeNull()
  })

  it('returns null when there is nothing to do (no cwd, no first message)', () => {
    expect(computeAutoTitlePatch({ existing: undefined, aiWillAutoName: false })).toBeNull()
  })
})
