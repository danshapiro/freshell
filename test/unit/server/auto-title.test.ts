import { describe, it, expect } from 'vitest'
import { computeAutoTitlePatch, computeSessionTitleSync } from '../../../server/auto-title'

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

describe('computeSessionTitleSync', () => {
  const term = (terminalId: string, title?: string) => ({ terminalId, title })

  it('seeds dir and pushes it to a default-titled terminal', () => {
    const r = computeSessionTitleSync({
      sessionTitle: 'Claude', override: undefined, cwd: '/home/dan/code/freshell',
      firstUserMessage: undefined, aiWillAutoName: false, terminals: [term('t1', 'Claude')],
    })
    expect(r.overridePatch).toEqual({ titleOverride: 'freshell', titleSource: 'dir' })
    expect(r.canonicalTitle).toBe('freshell')
    expect(r.terminalIdsToUpdate).toEqual(['t1'])
    expect(r.shouldGenerateAi).toBe(false)
  })

  it('upgrades dir -> first-message and pushes to a terminal already showing the dir name', () => {
    const r = computeSessionTitleSync({
      sessionTitle: 'freshell', override: { titleOverride: 'freshell', titleSource: 'dir' },
      cwd: '/home/dan/code/freshell', firstUserMessage: 'Fix the login bug',
      aiWillAutoName: false, terminals: [term('t1', 'freshell')],
    })
    expect(r.overridePatch).toEqual({ titleOverride: 'Fix the login bug', titleSource: 'first-message' })
    expect(r.canonicalTitle).toBe('Fix the login bug')
    expect(r.terminalIdsToUpdate).toEqual(['t1'])
  })

  it('pushes an already-finalized (e.g. manual ai) override to a stale terminal without re-writing it', () => {
    const r = computeSessionTitleSync({
      sessionTitle: 'AI Name', override: { titleOverride: 'AI Name', titleSource: 'ai' },
      cwd: '/x/proj', firstUserMessage: 'whatever', aiWillAutoName: false,
      terminals: [term('t1', 'freshell')],
    })
    expect(r.overridePatch).toBeNull()
    expect(r.canonicalTitle).toBe('AI Name')
    expect(r.terminalIdsToUpdate).toEqual(['t1'])
    expect(r.shouldGenerateAi).toBe(false)
  })

  it('leaves the dir placeholder and flags AI generation when a key is set', () => {
    const r = computeSessionTitleSync({
      sessionTitle: 'freshell', override: { titleOverride: 'freshell', titleSource: 'dir' },
      cwd: '/home/dan/code/freshell', firstUserMessage: 'Add a logout button',
      aiWillAutoName: true, terminals: [term('t1', 'freshell')],
    })
    expect(r.overridePatch).toBeNull()
    expect(r.canonicalTitle).toBe('freshell')
    expect(r.terminalIdsToUpdate).toEqual([])
    expect(r.shouldGenerateAi).toBe(true)
  })

  it('does not flag AI generation once the name is finalized', () => {
    const r = computeSessionTitleSync({
      sessionTitle: 'My Name', override: { titleOverride: 'My Name', titleSource: 'user' },
      cwd: '/x', firstUserMessage: 'hi', aiWillAutoName: true, terminals: [term('t1', 'My Name')],
    })
    expect(r.shouldGenerateAi).toBe(false)
    expect(r.terminalIdsToUpdate).toEqual([])
  })

  it('does not flag AI generation when the parsed title is provider-generated', () => {
    const r = computeSessionTitleSync({
      sessionTitle: 'Auth Redirect Fix',
      override: { titleOverride: 'freshell', titleSource: 'dir' },
      cwd: '/x', firstUserMessage: 'hi', aiWillAutoName: true,
      parsedTitleSource: 'provider-generated',
      terminals: [term('t1', 'Auth Redirect Fix')],
    })
    expect(r.shouldGenerateAi).toBe(false)
  })
})
