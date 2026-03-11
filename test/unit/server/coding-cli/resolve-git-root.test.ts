import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import {
  resolveGitRepoRoot,
  resolveGitCheckoutRoot,
  resolveGitCommonDir,
  resolveInvocationCwd,
  clearRepoRootCache,
} from '../../../../server/coding-cli/utils'

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-git-root-'))
  clearRepoRootCache()
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

describe('resolveGitRepoRoot()', () => {
  it('returns the repo root for a regular git repo', async () => {
    const repoDir = path.join(tempDir, 'repo')
    await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true })

    expect(await resolveGitRepoRoot(repoDir)).toBe(repoDir)
  })

  it('returns the parent repo root for a git worktree', async () => {
    // Set up parent repo with .git directory
    const repoDir = path.join(tempDir, 'repo')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    // Set up worktree's gitdir inside the parent repo
    const worktreeGitDir = path.join(gitDir, 'worktrees', 'my-worktree')
    await fsp.mkdir(worktreeGitDir, { recursive: true })
    // commondir points to the shared .git directory (relative)
    await fsp.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n')

    // Set up the worktree directory with a .git file
    const worktreeDir = path.join(tempDir, 'my-worktree')
    await fsp.mkdir(worktreeDir, { recursive: true })
    await fsp.writeFile(
      path.join(worktreeDir, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
    )

    expect(await resolveGitRepoRoot(worktreeDir)).toBe(repoDir)
  })

  it('returns the submodule directory for a git submodule (not the superproject)', async () => {
    // Set up superproject
    const superDir = path.join(tempDir, 'super')
    const superGitDir = path.join(superDir, '.git')
    await fsp.mkdir(superGitDir, { recursive: true })

    // Set up submodule gitdir inside superproject
    const submoduleGitDir = path.join(superGitDir, 'modules', 'sub')
    await fsp.mkdir(submoduleGitDir, { recursive: true })

    // Set up submodule directory with .git file
    const subDir = path.join(superDir, 'sub')
    await fsp.mkdir(subDir, { recursive: true })
    await fsp.writeFile(
      path.join(subDir, '.git'),
      `gitdir: ${submoduleGitDir}\n`,
    )

    // Should return the submodule dir, NOT the superproject
    expect(await resolveGitRepoRoot(subDir)).toBe(subDir)
  })

  it('returns the original cwd when no .git directory exists', async () => {
    const plainDir = path.join(tempDir, 'plain')
    await fsp.mkdir(plainDir, { recursive: true })

    expect(await resolveGitRepoRoot(plainDir)).toBe(plainDir)
  })

  it('returns the original cwd for a deleted/nonexistent path', async () => {
    const deletedPath = path.join(tempDir, 'deleted', 'worktree', 'path')

    expect(await resolveGitRepoRoot(deletedPath)).toBe(deletedPath)
  })

  it('finds the repo root from a nested path within a repo', async () => {
    const repoDir = path.join(tempDir, 'repo')
    await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true })
    const nestedDir = path.join(repoDir, 'src', 'deep', 'nested')
    await fsp.mkdir(nestedDir, { recursive: true })

    expect(await resolveGitRepoRoot(nestedDir)).toBe(repoDir)
  })

  it('expands tilde paths', async () => {
    // We can't easily test real ~ expansion without creating files in $HOME,
    // so test that the function handles ~ by verifying it resolves to homedir.
    // Use a path that definitely won't have .git, so it returns the expanded path.
    const tildeResult = await resolveGitRepoRoot('~/nonexistent-test-path-xyzzy')
    const expected = path.join(os.homedir(), 'nonexistent-test-path-xyzzy')
    expect(tildeResult).toBe(expected)
  })

  it('caches results and avoids re-walking the filesystem', async () => {
    const repoDir = path.join(tempDir, 'repo')
    await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true })

    const statSpy = vi.spyOn(fsp, 'stat')
    const lstatSpy = vi.spyOn(fsp, 'lstat')

    // First call — should hit the filesystem
    expect(await resolveGitRepoRoot(repoDir)).toBe(repoDir)
    const firstCallCount = statSpy.mock.calls.length + lstatSpy.mock.calls.length

    // Second call — should use cache, no additional filesystem calls
    expect(await resolveGitRepoRoot(repoDir)).toBe(repoDir)
    const secondCallCount = statSpy.mock.calls.length + lstatSpy.mock.calls.length

    expect(secondCallCount).toBe(firstCallCount)

    statSpy.mockRestore()
    lstatSpy.mockRestore()
  })

  it('resolves worktree with relative commondir path', async () => {
    // Set up parent repo
    const repoDir = path.join(tempDir, 'project')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    // Worktree gitdir with relative commondir
    const worktreeGitDir = path.join(gitDir, 'worktrees', 'feature-branch')
    await fsp.mkdir(worktreeGitDir, { recursive: true })
    await fsp.writeFile(path.join(worktreeGitDir, 'commondir'), '../..')

    // Worktree directory
    const worktreeDir = path.join(tempDir, 'worktrees', 'feature-branch')
    await fsp.mkdir(worktreeDir, { recursive: true })
    await fsp.writeFile(
      path.join(worktreeDir, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
    )

    expect(await resolveGitRepoRoot(worktreeDir)).toBe(repoDir)
  })

  it('falls back to cwd when commondir is missing but gitdir looks like a worktree', async () => {
    // Set up parent repo
    const repoDir = path.join(tempDir, 'project')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    // Worktree gitdir WITHOUT commondir file
    const worktreeGitDir = path.join(gitDir, 'worktrees', 'feature-branch')
    await fsp.mkdir(worktreeGitDir, { recursive: true })
    // No commondir file!

    // Worktree directory
    const worktreeDir = path.join(tempDir, 'worktrees', 'feature-branch')
    await fsp.mkdir(worktreeDir, { recursive: true })
    await fsp.writeFile(
      path.join(worktreeDir, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
    )

    // Should fall back: walk up from gitdir past .git/worktrees/<name> → repo root
    expect(await resolveGitRepoRoot(worktreeDir)).toBe(repoDir)
  })

  it('returns original cwd for empty string input', async () => {
    expect(await resolveGitRepoRoot('')).toBe('')
  })

  it('returns relative paths as-is without resolving against server cwd', async () => {
    expect(await resolveGitRepoRoot('.')).toBe('.')
    expect(await resolveGitRepoRoot('..')).toBe('..')
    expect(await resolveGitRepoRoot('relative/path')).toBe('relative/path')
  })

  it('does not misclassify a worktree in a repo whose path contains "modules"', async () => {
    // Repo lives under a directory named "modules" — the worktree gitdir
    // will contain /modules/ in the full path, but NOT as /.git/modules/
    const repoDir = path.join(tempDir, 'modules', 'my-repo')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    const worktreeGitDir = path.join(gitDir, 'worktrees', 'my-wt')
    await fsp.mkdir(worktreeGitDir, { recursive: true })
    await fsp.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n')

    const worktreeDir = path.join(tempDir, 'modules', 'my-repo-wt')
    await fsp.mkdir(worktreeDir, { recursive: true })
    await fsp.writeFile(
      path.join(worktreeDir, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
    )

    // Should correctly resolve to the parent repo, not treat as submodule
    expect(await resolveGitRepoRoot(worktreeDir)).toBe(repoDir)
  })
})

describe('resolveGitCheckoutRoot()', () => {
  it('returns the directory containing .git for a regular repo', async () => {
    const repoDir = path.join(tempDir, 'repo')
    await fsp.mkdir(path.join(repoDir, '.git'), { recursive: true })

    expect(await resolveGitCheckoutRoot(repoDir)).toBe(repoDir)
  })

  it('returns worktree checkout root while resolveGitRepoRoot returns canonical parent repo', async () => {
    const repoDir = path.join(tempDir, 'repo')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    const worktreeGitDir = path.join(gitDir, 'worktrees', 'feature')
    await fsp.mkdir(worktreeGitDir, { recursive: true })
    await fsp.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n')

    const worktreeDir = path.join(tempDir, 'repo-feature')
    const nestedDir = path.join(worktreeDir, 'src', 'deep')
    await fsp.mkdir(nestedDir, { recursive: true })
    await fsp.writeFile(
      path.join(worktreeDir, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
    )

    expect(await resolveGitCheckoutRoot(nestedDir)).toBe(worktreeDir)
    expect(await resolveGitRepoRoot(nestedDir)).toBe(repoDir)
  })

  it('keeps submodule checkout root as submodule directory', async () => {
    const superDir = path.join(tempDir, 'super')
    const superGitDir = path.join(superDir, '.git')
    await fsp.mkdir(superGitDir, { recursive: true })

    const submoduleGitDir = path.join(superGitDir, 'modules', 'sub')
    await fsp.mkdir(submoduleGitDir, { recursive: true })

    const subDir = path.join(superDir, 'sub')
    const nestedDir = path.join(subDir, 'src')
    await fsp.mkdir(nestedDir, { recursive: true })
    await fsp.writeFile(
      path.join(subDir, '.git'),
      `gitdir: ${submoduleGitDir}\n`,
    )

    expect(await resolveGitCheckoutRoot(nestedDir)).toBe(subDir)
  })
})

describe('resolveGitCommonDir()', () => {
  it('returns the .git directory for a regular repo', async () => {
    const repoDir = path.join(tempDir, 'repo')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    expect(await resolveGitCommonDir(repoDir)).toBe(gitDir)
  })

  it('returns the shared common-dir for a linked worktree', async () => {
    const repoDir = path.join(tempDir, 'repo')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    const worktreeGitDir = path.join(gitDir, 'worktrees', 'feature')
    await fsp.mkdir(worktreeGitDir, { recursive: true })
    await fsp.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n')

    const worktreeDir = path.join(tempDir, 'repo-feature')
    await fsp.mkdir(worktreeDir, { recursive: true })
    await fsp.writeFile(
      path.join(worktreeDir, '.git'),
      `gitdir: ${worktreeGitDir}\n`,
    )

    expect(await resolveGitCommonDir(worktreeDir)).toBe(gitDir)
  })

  it('returns undefined when no git directory exists', async () => {
    const plainDir = path.join(tempDir, 'plain')
    await fsp.mkdir(plainDir, { recursive: true })

    expect(await resolveGitCommonDir(plainDir)).toBeUndefined()
  })
})

describe('resolveInvocationCwd()', () => {
  it('prefers INIT_CWD when present', () => {
    expect(resolveInvocationCwd({
      INIT_CWD: '/tmp/init-cwd',
      PWD: '/tmp/pwd',
    })).toBe('/tmp/init-cwd')
  })

  it('falls back to PWD when INIT_CWD is absent', () => {
    expect(resolveInvocationCwd({
      PWD: '/tmp/pwd',
    })).toBe('/tmp/pwd')
  })
})
