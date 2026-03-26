import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import fsp from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  resolveGitBranchAndDirty,
  resolveGitCheckoutRoot,
  resolveGitCommonDir,
  resolveGitRepoRoot,
  clearRepoRootCache,
} from '../../../../server/coding-cli/utils'

const execFileAsync = promisify(execFile)

let tempDir: string

async function runGit(args: string[], cwd: string) {
  await execFileAsync('git', args, { cwd })
}

async function initRepo(repoDir: string, branchName: string) {
  await fsp.mkdir(repoDir, { recursive: true })
  await runGit(['init'], repoDir)
  await runGit(['config', 'user.email', 'test@example.com'], repoDir)
  await runGit(['config', 'user.name', 'Freshell Test'], repoDir)
  await fsp.writeFile(path.join(repoDir, 'README.md'), '# test\n')
  await runGit(['add', 'README.md'], repoDir)
  await runGit(['commit', '-m', 'init'], repoDir)
  await runGit(['checkout', '-B', branchName], repoDir)
}

async function createLinkedWorktreeFixture(baseDir: string) {
  const repoDir = path.join(baseDir, 'repo')
  const worktreeDir = path.join(baseDir, 'repo-feature')

  await initRepo(repoDir, 'main')
  await runGit(['worktree', 'add', '-b', 'feature/worktree', worktreeDir], repoDir)

  return { repoDir, worktreeDir }
}

beforeEach(async () => {
  tempDir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-git-meta-')))
  clearRepoRootCache()
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

describe('resolveGitBranchAndDirty()', () => {
  it('returns current branch and clean state for git directories', async () => {
    const repoDir = path.join(tempDir, 'repo')
    await initRepo(repoDir, 'feature/metadata')

    const nestedDir = path.join(repoDir, 'src', 'deep')
    await fsp.mkdir(nestedDir, { recursive: true })

    const result = await resolveGitBranchAndDirty(nestedDir)

    expect(result).toEqual({
      branch: 'feature/metadata',
      isDirty: false,
    })
  })

  it('returns isDirty=true when porcelain status has entries', async () => {
    const repoDir = path.join(tempDir, 'repo')
    await initRepo(repoDir, 'main')

    await fsp.writeFile(path.join(repoDir, 'untracked.txt'), 'dirty\n')

    const result = await resolveGitBranchAndDirty(repoDir)

    expect(result.branch).toBe('main')
    expect(result.isDirty).toBe(true)
  })

  it('handles non-git directories gracefully', async () => {
    const plainDir = path.join(tempDir, 'plain')
    await fsp.mkdir(plainDir, { recursive: true })

    const result = await resolveGitBranchAndDirty(plainDir)

    expect(result).toEqual({})
  })

  it('resolves branch, dirty state, checkout root, repo root, and common-dir for linked worktrees', async () => {
    const { repoDir, worktreeDir } = await createLinkedWorktreeFixture(tempDir)
    const nestedDir = path.join(worktreeDir, 'src', 'deep')
    await fsp.mkdir(nestedDir, { recursive: true })

    await fsp.writeFile(path.join(worktreeDir, 'dirty.txt'), 'dirty\n')

    expect(await resolveGitCheckoutRoot(nestedDir)).toBe(worktreeDir)
    expect(await resolveGitRepoRoot(nestedDir)).toBe(repoDir)
    expect(await resolveGitCommonDir(nestedDir)).toBe(path.join(repoDir, '.git'))

    const result = await resolveGitBranchAndDirty(nestedDir)

    expect(result).toEqual({
      branch: 'feature/worktree',
      isDirty: true,
    })
    expect(result).not.toHaveProperty('cleanWorktree')
  })
})
