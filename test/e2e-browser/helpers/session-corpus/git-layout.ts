/**
 * HARNESS-04 — on-disk git fixtures (hand-written, no git binary required).
 *
 * Shapes mirror `test/unit/server/coding-cli/resolve-git-root.test.ts` and were
 * validated against the shared repository-context resolvers
 * (load-bearing L1):
 *  - a VALID `.git` directory = directory containing a `HEAD` file
 *    (`isGitDirectory`); nested repos resolve to the innermost valid root.
 *  - a worktree checkout = `.git` FILE with `gitdir: <main>/.git/worktrees/<n>`
 *    and `<n>/commondir` containing `../..`; repo root collapses to the main
 *    checkout, checkout root stays the worktree dir.
 *
 * Fixture-internal files are hashed like every other corpus file and also
 * enumerated in `gitFixtures[].internalFiles` for structural assertions.
 */

import path from 'path'
import fsp from 'fs/promises'
import type { CorpusContext, CorpusGitFixture } from './types.js'
import { recordFile } from './manifest.js'

async function makeGitDir(ctx: CorpusContext, gitDir: string, relExtra: string[] = []): Promise<string[]> {
  await fsp.mkdir(gitDir, { recursive: true })
  const head = path.join(gitDir, 'HEAD')
  await fsp.writeFile(head, 'ref: refs/heads/main\n')
  const files = [head, ...relExtra]
  for (const file of files) {
    await recordFile(ctx.files, ctx.homeDir, file, 'git-fixture')
  }
  return files.map((f) => path.relative(ctx.homeDir, f).split(path.sep).join('/'))
}

export interface NestedGitRepos {
  outer: string
  inner: string
  /** A plain subdirectory inside the outer repo (a repo-subdir session cwd). */
  subdir: string
  fixture: CorpusGitFixture
}

export async function createNestedGitRepos(ctx: CorpusContext): Promise<NestedGitRepos> {
  const outer = path.join(ctx.workspace, 'repos', 'outer-repo')
  const inner = path.join(outer, 'inner-repo')
  const subdir = path.join(outer, 'src', 'pkg')
  await fsp.mkdir(subdir, { recursive: true })
  await fsp.mkdir(inner, { recursive: true })

  const outerFiles = await makeGitDir(ctx, path.join(outer, '.git'))
  const innerFiles = await makeGitDir(ctx, path.join(inner, '.git'))

  const rel = (p: string) => path.relative(ctx.homeDir, p).split(path.sep).join('/')
  const fixture: CorpusGitFixture = {
    kind: 'nested-repo',
    path: rel(inner),
    expectedProjectPath: inner,
    internalFiles: [...outerFiles, ...innerFiles],
  }
  const subdirFixture: CorpusGitFixture = {
    kind: 'repo-subdir',
    path: rel(subdir),
    expectedProjectPath: outer,
    internalFiles: [],
  }
  ctx.gitFixtures.push(fixture, subdirFixture)
  return { outer, inner, subdir, fixture }
}

export interface WorktreePair {
  mainRepo: string
  wtCheckout: string
  fixture: CorpusGitFixture
}

export async function createWorktreePair(ctx: CorpusContext): Promise<WorktreePair> {
  const mainRepo = path.join(ctx.workspace, 'repos', 'main-repo')
  const wtName = 'wt-session'
  const mainGit = path.join(mainRepo, '.git')
  const wtGitDir = path.join(mainGit, 'worktrees', wtName)
  const wtCheckout = path.join(ctx.workspace, 'repos', wtName)

  await fsp.mkdir(wtGitDir, { recursive: true })
  await fsp.mkdir(wtCheckout, { recursive: true })

  const commondir = path.join(wtGitDir, 'commondir')
  await fsp.writeFile(commondir, '../..\n')
  const gitFile = path.join(wtCheckout, '.git')
  await fsp.writeFile(gitFile, `gitdir: ${wtGitDir}\n`)

  const mainFiles = await makeGitDir(ctx, mainGit)

  const rel = (p: string) => path.relative(ctx.homeDir, p).split(path.sep).join('/')
  const extra = [commondir, gitFile]
  for (const file of extra) {
    await recordFile(ctx.files, ctx.homeDir, file, 'git-fixture')
  }
  const fixture: CorpusGitFixture = {
    kind: 'worktree',
    path: rel(wtCheckout),
    expectedProjectPath: mainRepo,
    expectedCheckoutPath: wtCheckout,
    internalFiles: [...mainFiles, ...extra.map(rel)],
  }
  ctx.gitFixtures.push(fixture)
  return { mainRepo, wtCheckout, fixture }
}
