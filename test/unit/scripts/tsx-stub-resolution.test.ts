// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveOwningTsx } from '@test/helpers/tsx-stub-resolution'

const SPAWN_TIMEOUT_MS = 10_000

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFakeTsx(root: string): string {
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx')
  fs.mkdirSync(path.dirname(tsx), { recursive: true })
  fs.writeFileSync(tsx, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(tsx, 0o755)
  return tsx
}

function runGit(dir: string, args: string[]): void {
  const env = { ...process.env }
  // A caller such as a Git hook may export repository locations. Fixture
  // commands must only operate on the repository selected by their cwd.
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[name]
  }
  const res = spawnSync('git', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (res.error) throw new Error(`git ${args.join(' ')} failed in fixture: ${res.error.message}`, { cause: res.error })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in fixture (status=${res.status}, signal=${res.signal}): ${res.stderr}`)
}

function gitInit(dir: string): void {
  runGit(dir, ['init', '-q', '-b', 'main'])
}

function makeLinkedWorktree(parent: string): { owningRoot: string; worktreeRoot: string } {
  const owningRoot = path.join(parent, 'owner')
  const worktreeRoot = path.join(parent, 'linked')
  const hooksDir = path.join(parent, 'empty-hooks')
  fs.mkdirSync(owningRoot)
  fs.mkdirSync(hooksDir)
  gitInit(owningRoot)
  // A linked worktree needs one commit. Keep its identity and execution
  // settings on these fixture commands; no developer Git config is changed.
  runGit(owningRoot, [
    '-c', 'user.name=tsx resolution fixture',
    '-c', 'user.email=tsx-resolution-fixture@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${hooksDir}`,
    'commit', '--allow-empty', '-q', '-m', 'fixture root',
  ])
  runGit(owningRoot, ['-c', `core.hooksPath=${hooksDir}`, 'worktree', 'add', '--detach', '--quiet', worktreeRoot])
  fs.writeFileSync(path.join(worktreeRoot, 'package.json'), '{ "private": true }\n')
  return { owningRoot, worktreeRoot }
}

describe('resolveOwningTsx', () => {
  it('walks up from a nested dir to the nearest package.json root when git metadata is absent', () => {
    const root = makeTempDir('tsx-resolve-gitless-')
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
      const fakeTsx = writeFakeTsx(root)
      const nested = path.join(root, 'test', 'unit', 'scripts')
      fs.mkdirSync(nested, { recursive: true })
      const resolved = resolveOwningTsx(nested)
      expect(path.isAbsolute(resolved)).toBe(true)
      expect(resolved).toBe(fakeTsx)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers the git common-dir owning root over a nearer package.json root (git checkout behavior)', () => {
    const root = makeTempDir('tsx-resolve-git-')
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
      const owningTsx = writeFakeTsx(root)
      gitInit(root)
      const decoyRoot = path.join(root, 'packages', 'nested')
      fs.mkdirSync(decoyRoot, { recursive: true })
      fs.writeFileSync(path.join(decoyRoot, 'package.json'), '{ "private": true }\n')
      const decoyTsx = writeFakeTsx(decoyRoot)
      const start = path.join(decoyRoot, 'test', 'unit', 'scripts')
      fs.mkdirSync(start, { recursive: true })
      const resolved = resolveOwningTsx(start)
      expect(resolved).toBe(owningTsx)
      expect(resolved).not.toBe(decoyTsx)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers the common-dir owning checkout runtime over a linked worktree runtime when both exist', () => {
    const parent = makeTempDir('tsx-resolve-worktree-owner-')
    try {
      const { owningRoot, worktreeRoot } = makeLinkedWorktree(parent)
      const owningTsx = writeFakeTsx(owningRoot)
      const worktreeTsx = writeFakeTsx(worktreeRoot)
      const start = path.join(worktreeRoot, 'test', 'unit', 'scripts')
      fs.mkdirSync(start, { recursive: true })

      const resolved = resolveOwningTsx(start)
      expect(resolved).toBe(owningTsx)
      expect(resolved).not.toBe(worktreeTsx)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('falls back to the linked worktree package runtime when the owning checkout runtime is missing', () => {
    const parent = makeTempDir('tsx-resolve-worktree-fallback-')
    try {
      const { owningRoot, worktreeRoot } = makeLinkedWorktree(parent)
      const worktreeTsx = writeFakeTsx(worktreeRoot)
      const start = path.join(worktreeRoot, 'test', 'unit', 'scripts')
      fs.mkdirSync(start, { recursive: true })
      expect(fs.existsSync(path.join(owningRoot, 'node_modules', '.bin', 'tsx'))).toBe(false)

      expect(resolveOwningTsx(start)).toBe(worktreeTsx)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('throws a clear error naming both strategies when no ancestor has package.json', () => {
    const root = makeTempDir('tsx-resolve-bare-')
    try {
      const nested = path.join(root, 'a', 'b')
      fs.mkdirSync(nested, { recursive: true })
      expect(() => resolveOwningTsx(nested)).toThrowError(/git/)
      expect(() => resolveOwningTsx(nested)).toThrowError(/package\.json/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws with the found project root when the nearest package.json lacks node_modules/.bin/tsx', () => {
    const root = makeTempDir('tsx-resolve-no-bin-')
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
      const nested = path.join(root, 'a', 'b')
      fs.mkdirSync(nested, { recursive: true })
      expect(() => resolveOwningTsx(nested)).toThrowError(/project root/)
      expect(() => resolveOwningTsx(nested)).toThrowError(/node_modules\/\.bin\/tsx/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves an absolute, existing tsx for the running test tree', () => {
    const resolved = resolveOwningTsx(import.meta.dirname)
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved.endsWith(path.join('node_modules', '.bin', 'tsx'))).toBe(true)
    expect(fs.existsSync(resolved)).toBe(true)
    // Exact strategy precedence is covered by the owned fixtures above.
    // This checkout may intentionally install dependencies only in a worktree.
  })
})
