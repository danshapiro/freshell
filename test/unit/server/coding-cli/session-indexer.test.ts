import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import type { CodingCliProvider } from '../../../../server/coding-cli/provider'
import { CodingCliSessionIndexer } from '../../../../server/coding-cli/session-indexer'
import { configStore } from '../../../../server/config-store'
import { makeSessionKey } from '../../../../server/coding-cli/types'
import { clearRepoRootCache } from '../../../../server/coding-cli/utils'

vi.mock('../../../../server/config-store', () => ({
  configStore: {
    getProjectColors: vi.fn().mockResolvedValue({
      '/project/a': '#111111',
      '/project/b': '#222222',
    }),
    snapshot: vi.fn(),
  },
}))

function makeProvider(files: string[]): CodingCliProvider {
  return {
    name: 'claude',
    displayName: 'Claude',
    homeDir: '/tmp',
    getSessionGlob: () => path.join('/tmp', '*.jsonl'),
    listSessionFiles: async () => files,
    parseSessionFile: async (content: string) => {
      const lines = content.split(/\r?\n/).filter(Boolean)
      let cwd: string | undefined
      let title: string | undefined
      for (const line of lines) {
        const obj = JSON.parse(line)
        if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
        if (!title && typeof obj.title === 'string') title = obj.title
      }
      return { cwd, title, messageCount: lines.length }
    },
    resolveProjectPath: async (_filePath, meta) => meta.cwd || 'unknown',
    extractSessionId: (filePath) => path.basename(filePath, '.jsonl'),
    getCommand: () => 'claude',
    getStreamArgs: () => [],
    getResumeArgs: () => [],
    parseEvent: () => [],
    supportsLiveStreaming: () => false,
    supportsSessionResume: () => false,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coding-cli-'))
  clearRepoRootCache()
  vi.mocked(configStore.snapshot).mockResolvedValue({
    sessionOverrides: {},
    settings: {
      codingCli: {
        enabledProviders: ['claude'],
        providers: {},
      },
    },
  })
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('isSubagentSession() scoping', () => {
  it('flags Claude subagent paths with isSubagent: true', async () => {
    const claudeSubagentPath = path.join(tempDir, '.claude', 'projects', 'proj', 'subagents', 'session.jsonl')
    await fsp.mkdir(path.dirname(claudeSubagentPath), { recursive: true })
    await fsp.writeFile(claudeSubagentPath, JSON.stringify({ cwd: '/project/a', title: 'Subagent' }) + '\n')

    const provider: CodingCliProvider = {
      ...makeProvider([claudeSubagentPath]),
      homeDir: tempDir,
    }

    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const projects = indexer.getProjects()
    // Should be included with isSubagent flag set
    expect(projects).toHaveLength(1)
    expect(projects[0].sessions[0].title).toBe('Subagent')
    expect(projects[0].sessions[0].isSubagent).toBe(true)
  })

  it('does NOT flag non-Claude paths containing "subagents"', async () => {
    // A Codex session in a directory named "subagents" should NOT be flagged
    const codexSubagentPath = path.join(tempDir, 'codex', 'sessions', 'subagents', 'session.jsonl')
    await fsp.mkdir(path.dirname(codexSubagentPath), { recursive: true })
    await fsp.writeFile(codexSubagentPath, JSON.stringify({ cwd: '/project/a', title: 'Codex Session' }) + '\n')

    const provider: CodingCliProvider = {
      ...makeProvider([codexSubagentPath]),
      homeDir: path.join(tempDir, 'codex'),
    }

    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const projects = indexer.getProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].sessions[0].title).toBe('Codex Session')
    expect(projects[0].sessions[0].isSubagent).toBeUndefined()
  })
})

describe('CodingCliSessionIndexer', () => {

  it('groups sessions by project path with provider metadata', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    const fileB = path.join(tempDir, 'session-b.jsonl')

    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')
    await fsp.writeFile(fileB, JSON.stringify({ cwd: '/project/b', title: 'Title B' }) + '\n')

    const provider = makeProvider([fileA, fileB])
    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()

    const projects = indexer.getProjects()
    expect(projects).toHaveLength(2)

    const projectA = projects.find((p) => p.projectPath === '/project/a')
    const projectB = projects.find((p) => p.projectPath === '/project/b')

    expect(projectA?.color).toBe('#111111')
    expect(projectA?.sessions[0].provider).toBe('claude')
    expect(projectA?.sessions[0].title).toBe('Title A')

    expect(projectB?.color).toBe('#222222')
    expect(projectB?.sessions[0].provider).toBe('claude')
    expect(projectB?.sessions[0].title).toBe('Title B')
  })

  it('sorts projects deterministically by newest session updatedAt then projectPath', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    const fileB = path.join(tempDir, 'session-b.jsonl')

    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/b', title: 'B' }) + '\n')
    await fsp.writeFile(fileB, JSON.stringify({ cwd: '/project/a', title: 'A' }) + '\n')

    const sameTime = new Date('2020-01-01T00:00:00.000Z')
    await fsp.utimes(fileA, sameTime, sameTime)
    await fsp.utimes(fileB, sameTime, sameTime)

    const provider = makeProvider([fileA, fileB])
    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()

    expect(indexer.getProjects().map((p) => p.projectPath)).toEqual(['/project/a', '/project/b'])
  })

  it('skips providers that are disabled in settings', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    vi.mocked(configStore.snapshot).mockResolvedValueOnce({
      sessionOverrides: {},
      settings: {
        codingCli: {
          enabledProviders: [],
          providers: {},
        },
      },
    })

    const provider = makeProvider([fileA])
    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()

    expect(indexer.getProjects()).toHaveLength(0)
  })

  it('skips sessions without cwd metadata', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ title: 'No cwd' }) + '\n')

    const provider = makeProvider([fileA])
    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()

    expect(indexer.getProjects()).toHaveLength(0)
  })

  it('reuses cached session metadata when file unchanged', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    const parseSessionFile = vi.fn().mockResolvedValue({
      cwd: '/project/a',
      title: 'Title A',
      messageCount: 1,
    })

    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      parseSessionFile,
    }

    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()
    await indexer.refresh()

    expect(parseSessionFile).toHaveBeenCalledTimes(1)
  })

  it('prefers ParsedSessionMeta.sessionId over filename', async () => {
    const fileA = path.join(tempDir, 'legacy-id.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      parseSessionFile: async () => ({
        cwd: '/project/a',
        title: 'Title A',
        sessionId: 'canonical-id',
        messageCount: 1,
      }),
    }

    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()

    const sessionId = indexer.getProjects()[0]?.sessions[0]?.sessionId
    expect(sessionId).toBe('canonical-id')
  })

  it('propagates token and git metadata from ParsedSessionMeta into indexed sessions', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      parseSessionFile: async () => ({
        cwd: '/project/a',
        title: 'Title A',
        messageCount: 1,
        gitBranch: 'main',
        isDirty: true,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 10,
          totalTokens: 160,
          contextTokens: 160,
          compactThresholdTokens: 640,
          compactPercent: 25,
        },
      }),
    }

    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const session = indexer.getProjects()[0]?.sessions[0]
    expect(session?.gitBranch).toBe('main')
    expect(session?.isDirty).toBe(true)
    expect(session?.tokenUsage?.compactPercent).toBe(25)
  })

  it('reads both head and tail snippets for large session files', async () => {
    const fileA = path.join(tempDir, 'session-large.jsonl')
    const fillerLines = Array.from({ length: 600 }, (_, i) =>
      JSON.stringify({ filler: `${i}-${'x'.repeat(600)}` }),
    )
    const content = [
      JSON.stringify({ cwd: '/project/a', title: 'Head Title' }),
      ...fillerLines,
      JSON.stringify({ tailSentinel: 'tail-sentinel' }),
    ].join('\n') + '\n'
    await fsp.writeFile(fileA, content)

    const parseSessionFile = vi.fn(async (snippet: string) => ({
      cwd: snippet.includes('"cwd":"/project/a"') ? '/project/a' : undefined,
      title: snippet.includes('tail-sentinel') ? 'Tail Title' : 'Head Title',
      messageCount: snippet.split(/\r?\n/).filter(Boolean).length,
    }))

    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      parseSessionFile,
    }

    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const session = indexer.getProjects()[0]?.sessions[0]
    expect(session?.title).toBe('Tail Title')
    expect(parseSessionFile).toHaveBeenCalledTimes(1)
  })

  it('applies legacy overrides when sessionId differs from filename', async () => {
    const legacyId = 'legacy-id'
    const canonicalId = 'canonical-id'
    const fileA = path.join(tempDir, `${legacyId}.jsonl`)
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    vi.mocked(configStore.snapshot).mockResolvedValueOnce({
      sessionOverrides: {
        [makeSessionKey('claude', legacyId)]: {
          titleOverride: 'Overridden',
        },
      },
      settings: {
        codingCli: {
          enabledProviders: ['claude'],
          providers: {},
        },
      },
    })

    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      parseSessionFile: async () => ({
        cwd: '/project/a',
        title: 'Title A',
        sessionId: canonicalId,
        messageCount: 1,
      }),
    }

    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()

    const session = indexer.getProjects()[0]?.sessions[0]
    expect(session?.sessionId).toBe(canonicalId)
    expect(session?.title).toBe('Overridden')
  })

  it('avoids relisting session files when nothing changed', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    const listSessionFiles = vi.fn().mockResolvedValue([fileA])
    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      listSessionFiles,
    }

    const indexer = new CodingCliSessionIndexer([provider])

    await indexer.refresh()
    await indexer.refresh()

    expect(listSessionFiles).toHaveBeenCalledTimes(1)
  })

  it('coalesces refreshes while a refresh is in flight', async () => {
    const fileA = path.join(tempDir, 'session-a.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Title A' }) + '\n')

    const firstList = createDeferred<string[]>()

    const listSessionFiles = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)

    const provider: CodingCliProvider = {
      ...makeProvider([fileA]),
      listSessionFiles,
      parseSessionFile: vi.fn().mockResolvedValue({
        cwd: '/project/a',
        title: 'Title A',
        messageCount: 1,
      }),
    }

    const indexer = new CodingCliSessionIndexer([provider])

    const refreshPromise = indexer.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    indexer.refresh()

    expect(listSessionFiles).toHaveBeenCalledTimes(1)

    firstList.resolve([fileA])
    await refreshPromise

    expect(listSessionFiles).toHaveBeenCalledTimes(1)
    expect(vi.mocked(configStore.snapshot)).toHaveBeenCalledTimes(2)
  })

  it('groups worktree sessions under the parent repo', async () => {
    // Set up a real git repo structure in tempDir
    const repoDir = path.join(tempDir, 'repo')
    const gitDir = path.join(repoDir, '.git')
    await fsp.mkdir(gitDir, { recursive: true })

    // Set up two worktrees pointing back to the same repo
    for (const wtName of ['worktree-a', 'worktree-b']) {
      const worktreeGitDir = path.join(gitDir, 'worktrees', wtName)
      await fsp.mkdir(worktreeGitDir, { recursive: true })
      await fsp.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n')

      const worktreeDir = path.join(tempDir, '.worktrees', wtName)
      await fsp.mkdir(worktreeDir, { recursive: true })
      await fsp.writeFile(
        path.join(worktreeDir, '.git'),
        `gitdir: ${worktreeGitDir}\n`,
      )
    }

    const worktreeCwdA = path.join(tempDir, '.worktrees', 'worktree-a')
    const worktreeCwdB = path.join(tempDir, '.worktrees', 'worktree-b')

    const fileA = path.join(tempDir, 'session-a.jsonl')
    const fileB = path.join(tempDir, 'session-b.jsonl')
    await fsp.writeFile(fileA, JSON.stringify({ cwd: worktreeCwdA, title: 'Session A' }) + '\n')
    await fsp.writeFile(fileB, JSON.stringify({ cwd: worktreeCwdB, title: 'Session B' }) + '\n')

    // Use a provider that calls resolveGitRepoRoot via the real import
    const { resolveGitRepoRoot } = await import('../../../../server/coding-cli/utils')
    const provider: CodingCliProvider = {
      ...makeProvider([fileA, fileB]),
      resolveProjectPath: async (_filePath, meta) => {
        if (!meta.cwd) return 'unknown'
        return resolveGitRepoRoot(meta.cwd)
      },
    }

    const indexer = new CodingCliSessionIndexer([provider])
    await indexer.refresh()

    const projects = indexer.getProjects()
    // Both worktree sessions should be grouped under the same parent repo
    expect(projects).toHaveLength(1)
    expect(projects[0].projectPath).toBe(repoDir)
    expect(projects[0].sessions).toHaveLength(2)
    const titles = projects[0].sessions.map((s) => s.title).sort()
    expect(titles).toEqual(['Session A', 'Session B'])
  })
})
