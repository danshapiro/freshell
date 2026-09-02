import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetServerBuildIdCacheForTests,
  computeBuildId,
  readBakedBuildId,
  resolveServerBuildId,
  serverBuildId,
} from '../../server/build-id.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

// The module under test imports execFileSync by name; re-import it mocked.
import { execFileSync as mockedExecFileSync } from 'node:child_process'

function tempBakeFile(buildId: string | null): { dir: string; bakePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-bake-'))
  const bakePath = path.join(dir, 'build-id.json')
  if (buildId !== null) {
    fs.writeFileSync(bakePath, JSON.stringify({ buildId }))
  }
  return { dir, bakePath }
}

describe('server build id', () => {
  afterEach(() => {
    _resetServerBuildIdCacheForTests()
    vi.mocked(mockedExecFileSync).mockClear()
  })

  it('computeBuildId returns the current git HEAD sha for the repository', () => {
    // Build a fixture repo instead of probing this checkout: CI cloud images
    // ship the source tree without .git/ (see .gcloudignore/.dockerignore),
    // so asserting against REPO_ROOT's HEAD is impossible there. Only a git
    // binary is required anywhere this suite runs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-fixture-repo-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
      execFileSync(
        'git',
        ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'init'],
        { cwd: dir },
      )
      const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })
        .toString()
        .trim()
      expect(computeBuildId(dir)).toBe(expected)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('computeBuildId falls back to "unknown" outside a git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-no-git-'))
    try {
      expect(computeBuildId(dir)).toBe('unknown')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readBakedBuildId returns the baked value for a well-formed file', () => {
    const { dir, bakePath } = tempBakeFile('b'.repeat(40))
    try {
      expect(readBakedBuildId(bakePath)).toBe('b'.repeat(40))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readBakedBuildId returns undefined for malformed JSON, wrong shapes, or a missing file', () => {
    const { dir, bakePath } = tempBakeFile(null)
    try {
      fs.writeFileSync(bakePath, 'not json {')
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: 42 }))
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: '' }))
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      // Same validation as the writer: only a 40-hex sha or "unknown" is a
      // legitimate stamp; a garbage string must never become authoritative.
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: 'garbage-stamp' }))
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      expect(readBakedBuildId(path.join(dir, 'absent.json'))).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveServerBuildId prefers the bake file over a runtime git probe', () => {
    const { dir, bakePath } = tempBakeFile('c'.repeat(40))
    try {
      // Compiled-artifact semantics are explicit here: vitest executes this
      // module from source (SOURCE_MODE true), and a source run must probe
      // runtime HEAD — the bake-wins rule only governs compiled artifacts
      // (same pattern as the fail-inert test below).
      expect(resolveServerBuildId(bakePath, { sourceMode: false })).toBe('c'.repeat(40))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveServerBuildId falls back to the runtime git probe when no bake file exists in SOURCE mode', () => {
    const { dir } = tempBakeFile(null)
    try {
      expect(resolveServerBuildId(path.join(dir, 'build-id.json'))).toBe(computeBuildId(REPO_ROOT))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveServerBuildId fails inert to "unknown" for a compiled artifact without a valid stamp', () => {
    const { dir, bakePath } = tempBakeFile(null)
    try {
      // A compiled artifact (sourceMode: false) must NEVER probe the
      // checkout: a stale dist without its stamp advertises "unknown", not
      // the current HEAD (which would falsely match a current client).
      expect(resolveServerBuildId(path.join(dir, 'build-id.json'), { sourceMode: false })).toBe('unknown')
      fs.writeFileSync(bakePath, 'corrupt {')
      expect(resolveServerBuildId(bakePath, { sourceMode: false })).toBe('unknown')
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: 'garbage-stamp' }))
      expect(resolveServerBuildId(bakePath, { sourceMode: false })).toBe('unknown')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serverBuildId memoizes: the git probe runs once per process', () => {
    _resetServerBuildIdCacheForTests()
    // Source runs (tsx/vitest) have no bake file next to server/build-id.ts,
    // so the first resolution exercises the git probe.
    const first = serverBuildId()
    const callsAfterFirst = vi.mocked(mockedExecFileSync).mock.calls.length
    expect(serverBuildId()).toBe(first)
    expect(vi.mocked(mockedExecFileSync).mock.calls.length).toBe(callsAfterFirst)
    expect(callsAfterFirst).toBeGreaterThan(0)
  })
})
