import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import type { CodingCliProvider } from '../../../../server/coding-cli/provider'
import { CodingCliSessionIndexer } from '../../../../server/coding-cli/session-indexer'
import { configStore } from '../../../../server/config-store'

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
    parseSessionFile: (content: string) => {
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

describe('CodingCliSessionIndexer', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coding-cli-'))
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
})
