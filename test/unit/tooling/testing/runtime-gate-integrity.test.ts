import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  auditRuntimeArtifacts,
  candidateIntegrityFailures,
  captureRuntimeCandidate,
} from '../../../../scripts/testing/runtime-gate-integrity.js'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-gate-integrity-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function write(name: string, contents: string) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
  return target
}

function audit(...artifacts: string[]) {
  return auditRuntimeArtifacts(root, artifacts)
}

describe('self-contained runtime evidence', () => {
  it('accepts readable nonempty JSON, JSONL, and browser artifacts', () => {
    write('build.json', '{"candidateSha":"abc"}')
    write('assertions.jsonl', '{"pass":true}\n{"pass":true}\n')
    write('browser/trace.zip', 'synthetic binary artifact')
    expect(audit('build.json', 'assertions.jsonl', 'browser/')).toEqual({ missing: [], invalid: [] })
  })

  it('reserves summary.json for the gate to write after this audit', () => {
    expect(audit('summary.json')).toEqual({ missing: [], invalid: [] })
  })

  it('reports a missing artifact without throwing away the gate summary', () => {
    expect(audit('missing.json').missing).toEqual(['missing.json'])
  })

  it.each(['empty.json', 'assertions.jsonl'])('rejects the empty required file %s', (name) => {
    write(name, '')
    expect(audit(name).invalid).toHaveLength(1)
  })

  it.each(['{', 'null', '"not a record"'])('rejects malformed or non-record JSON %s', (contents) => {
    write('build.json', contents)
    expect(audit('build.json').invalid).toHaveLength(1)
  })

  it.each(['\n \n', '{"pass":true}\nmalformed\n', '{"pass":true}\nnull\n'])('rejects incomplete JSONL evidence %j', (contents) => {
    write('assertions.jsonl', contents)
    expect(audit('assertions.jsonl').invalid).toHaveLength(1)
  })

  it('does not echo sensitive content in a JSON parse error', () => {
    write('build.json', '{"token":"synthetic-secret-do-not-export", BROKEN')
    const result = audit('build.json')
    expect(result.invalid).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-do-not-export')
  })

  it('rejects a directory where a required file should be', () => {
    fs.mkdirSync(path.join(root, 'build.json'))
    expect(audit('build.json').invalid).toHaveLength(1)
  })

  it('rejects a file where a required directory should be', () => {
    write('browser', 'not a directory')
    expect(audit('browser/').invalid).toHaveLength(1)
  })

  it('rejects directories containing only empty subdirectories or files', () => {
    fs.mkdirSync(path.join(root, 'browser/nested'), { recursive: true })
    expect(audit('browser/').invalid).toHaveLength(1)
    write('browser/nested/empty.zip', '')
    expect(audit('browser/').invalid).toHaveLength(1)
  })

  it('rejects a symlink instead of treating an external file as retained evidence', () => {
    const target = write('external.json', '{}')
    fs.symlinkSync(target, path.join(root, 'build.json'))
    expect(audit('build.json').invalid).toHaveLength(1)
  })

  it('rejects symlinked directory ancestors and nested browser artifacts', () => {
    const target = write('external/receipt.json', '{}')
    fs.symlinkSync(path.dirname(target), path.join(root, 'browser'))
    expect(audit('browser/receipt.json').invalid).toHaveLength(1)
    expect(audit('browser/').invalid).toHaveLength(1)
  })

  it('does not follow a link cycle within a required evidence directory', () => {
    fs.mkdirSync(path.join(root, 'browser'))
    write('browser/trace.zip', 'valid')
    fs.symlinkSync(path.join(root, 'browser'), path.join(root, 'browser/cycle'))
    expect(audit('browser/').invalid).toHaveLength(1)
  })

  it.each(['../outside.json', '/tmp/outside.json', 'browser/../build.json', 'browser\\receipt.json'])('rejects unsafe manifest path %s', (artifact) => {
    expect(audit(artifact).invalid).toHaveLength(1)
  })
})

describe('candidate-bound runtime qualification', () => {
  function git(...args: string[]) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Runtime Test', GIT_AUTHOR_EMAIL: 'runtime-test@example.invalid',
      GIT_COMMITTER_NAME: 'Runtime Test', GIT_COMMITTER_EMAIL: 'runtime-test@example.invalid',
    } }).trim()
  }

  function init() {
    git('init', '--quiet')
    write('source.ts', 'export const version = 1\n')
    git('add', 'source.ts')
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture')
    return captureRuntimeCandidate(root)
  }

  it('accepts the same clean candidate at both ends of the gate', () => {
    const before = init()
    expect(before.dirty).toBe(false)
    expect(candidateIntegrityFailures(before.sha, before, captureRuntimeCandidate(root))).toEqual([])
  })

  it('detects unstaged and staged source changes without persisting their content', () => {
    const before = init()
    write('source.ts', 'synthetic-sensitive-source-change\n')
    const dirty = captureRuntimeCandidate(root)
    expect(dirty.dirty).toBe(true)
    expect(dirty.diffHash).not.toBe(before.diffHash)
    expect(JSON.stringify(dirty)).not.toContain('synthetic-sensitive-source-change')
    expect(candidateIntegrityFailures(before.sha, before, dirty).length).toBeGreaterThan(0)
    git('add', 'source.ts')
    expect(candidateIntegrityFailures(before.sha, before, captureRuntimeCandidate(root)).length).toBeGreaterThan(0)
  })

  it('rejects an untracked source file but ignores explicitly ignored evidence', () => {
    const before = init()
    write('new-source.ts', 'uncommitted input')
    expect(candidateIntegrityFailures(before.sha, before, captureRuntimeCandidate(root)).length).toBeGreaterThan(0)
    fs.unlinkSync(path.join(root, 'new-source.ts'))
    write('.git/info/exclude', '.runtime-evidence/\n')
    write('.runtime-evidence/receipt.json', '{}')
    expect(candidateIntegrityFailures(before.sha, before, captureRuntimeCandidate(root))).toEqual([])
  })

  it('rejects a commit changing during qualification even when the worktree is clean', () => {
    const before = init()
    write('source.ts', 'export const version = 2\n')
    git('add', 'source.ts')
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'next candidate')
    const after = captureRuntimeCandidate(root)
    expect(after.dirty).toBe(false)
    expect(candidateIntegrityFailures(before.sha, before, after).length).toBeGreaterThan(0)
  })

  it('cannot launder a dirty-start rehearsal into a clean candidate qualification', () => {
    const clean = init()
    write('source.ts', 'uncommitted input\n')
    const before = captureRuntimeCandidate(root)
    git('restore', 'source.ts')
    expect(candidateIntegrityFailures(clean.sha, before, captureRuntimeCandidate(root)).length).toBeGreaterThan(0)
  })
})
