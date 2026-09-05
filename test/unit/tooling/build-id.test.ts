// @vitest-environment node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeClientBuildId } from '../../../config/vite/build-id.js'

const roots: string[] = []

function scratchRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-id-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  return root
}

function commit(root: string, message: string): string {
  execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', message,
  ], { cwd: root })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('client build identity', () => {
  it('bakes the commit of the selected repository', () => {
    const root = scratchRepo()
    const sha = commit(root, 'first')
    expect(computeClientBuildId(root)).toBe(sha)
  })

  it('recomputes the stamp when a rebuild follows a commit', () => {
    const root = scratchRepo()
    const first = commit(root, 'first')
    expect(computeClientBuildId(root)).toBe(first)
    const second = commit(root, 'second')
    expect(second).not.toBe(first)
    expect(computeClientBuildId(root)).toBe(second)
  })

  it('uses the linked worktree commit instead of the main checkout', () => {
    const root = scratchRepo()
    const mainSha = commit(root, 'main')
    const linked = path.join(root, 'linked')
    execFileSync('git', ['worktree', 'add', '-qb', 'feature', linked], { cwd: root })
    const featureSha = commit(linked, 'feature')
    expect(computeClientBuildId(linked)).toBe(featureSha)
    expect(computeClientBuildId(root)).toBe(mainSha)
  })

  it('returns unknown for an uncommitted repository', () => {
    expect(computeClientBuildId(scratchRepo())).toBe('unknown')
  })

  it('returns unknown when git metadata is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-build-id-no-git-'))
    roots.push(root)
    expect(computeClientBuildId(root)).toBe('unknown')
  })
})
