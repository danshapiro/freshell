import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { nodeBuildStampIsCurrent } from '../../../port/oracle/harness/external-server.js'

// Pure-logic coverage for the oracle node dist's stamp-freshness guard: the
// predicate decides whether `ensureServerBuilt` reuses or rebuilds the
// compiled node artifact before the oracle boots it.
//
// The predicate's cwd (git probe) is injectable: tests pass an explicit
// `head` (or force the git-less path via `gitAvailable: false`) so no test
// depends on this scratch root actually being a git worktree.
describe('nodeBuildStampIsCurrent', () => {
  const dirs: string[] = []

  function scratchDist(buildId: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-freshness-'))
    dirs.push(root)
    fs.mkdirSync(path.join(root, 'dist', 'server'), { recursive: true })
    if (buildId !== undefined) {
      const content = typeof buildId === 'string' ? JSON.stringify({ buildId }) : buildId
      fs.writeFileSync(path.join(root, 'dist', 'server', 'build-id.json'), content)
    }
    fs.writeFileSync(path.join(root, 'dist', 'server', 'index.js'), '// entry')
    return root
  }

  beforeEach(() => {
    /* fresh dirs per test */
  })
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  })

  it('is current when the stamp exactly equals the checkout HEAD', () => {
    const root = scratchDist('a'.repeat(40))
    expect(nodeBuildStampIsCurrent(root, { head: 'a'.repeat(40) })).toBe(true)
  })

  it('rebuilds when the stamp is a different sha', () => {
    const root = scratchDist('f'.repeat(40))
    expect(nodeBuildStampIsCurrent(root, { head: 'a'.repeat(40) })).toBe(false)
  })

  it('rebuilds when the bake file is missing', () => {
    const root = scratchDist(undefined)
    expect(nodeBuildStampIsCurrent(root, { head: 'a'.repeat(40) })).toBe(false)
  })

  it('rebuilds when the stamp is "unknown" or malformed but HEAD is available', () => {
    const unknownRoot = scratchDist('unknown')
    expect(nodeBuildStampIsCurrent(unknownRoot, { head: 'a'.repeat(40) })).toBe(false)
    const malformedRoot = scratchDist('not json {')
    expect(nodeBuildStampIsCurrent(malformedRoot, { head: 'a'.repeat(40) })).toBe(false)
  })

  it('keeps legacy reuse when HEAD is unavailable (no stamp semantics to violate)', () => {
    const unknownRoot = scratchDist('unknown')
    expect(nodeBuildStampIsCurrent(unknownRoot, { gitAvailable: false })).toBe(true)
    const staleRoot = scratchDist('f'.repeat(40))
    expect(nodeBuildStampIsCurrent(staleRoot, { gitAvailable: false })).toBe(true)
  })
})
