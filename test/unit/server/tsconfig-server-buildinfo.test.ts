import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Regression guard for the server incremental-build cache location.
 *
 * Worktrees symlink `node_modules` to the primary checkout. If
 * `tsBuildInfoFile` lives under `node_modules/.cache`, tsc's incremental
 * state is SHARED across every worktree, so `npm run build:server` in a fresh
 * worktree (empty `dist/`) reads the primary checkout's "already emitted"
 * state and skips emitting — producing a partial `dist/` (e.g. a missing
 * `opencode-listing-runner.js`). The compiled-worker integration tests then
 * fail, but ONLY inside a worktree — CI's fresh checkout never catches it.
 *
 * Keeping the buildinfo inside the per-worktree `outDir` ties the incremental
 * cache lifetime to the output: an empty `dist/` means no buildinfo, which
 * forces a full emit. This unit test runs in CI and fails fast if the cache
 * is ever moved back into shared `node_modules`.
 */
describe('tsconfig.server incremental build cache', () => {
  const tsconfig = JSON.parse(
    readFileSync(path.join(process.cwd(), 'tsconfig.server.json'), 'utf8'),
  ) as { compilerOptions?: { tsBuildInfoFile?: string; outDir?: string } }
  const compilerOptions = tsconfig.compilerOptions ?? {}
  const buildInfoFile = String(compilerOptions.tsBuildInfoFile ?? '')
  const outDir = String(compilerOptions.outDir ?? './dist')

  it('does not store tsBuildInfoFile under the symlink-shared node_modules', () => {
    expect(buildInfoFile).not.toBe('')
    expect(buildInfoFile).not.toMatch(/(^|[\\/])node_modules([\\/]|$)/)
  })

  it('co-locates tsBuildInfoFile inside the per-worktree outDir', () => {
    const normalize = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '')
    const info = normalize(buildInfoFile)
    const out = normalize(outDir)
    expect(info === out || info.startsWith(`${out}/`)).toBe(true)
  })
})
