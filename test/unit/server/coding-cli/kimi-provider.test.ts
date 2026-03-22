import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../server/coding-cli/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../server/coding-cli/utils')>()
  return {
    ...actual,
    resolveGitRepoRoot: vi.fn(async (cwd: string) => (
      cwd.startsWith('/repo/root/packages/') ? '/repo/root' : cwd
    )),
    resolveGitBranchAndDirty: vi.fn(async () => ({})),
  }
})

import { KimiProvider } from '../../../../server/coding-cli/providers/kimi'
import { resolveGitBranchAndDirty, resolveGitRepoRoot } from '../../../../server/coding-cli/utils'
import { SessionDirectoryItemSchema } from '../../../../shared/read-models'

const fixtureShareDir = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'coding-cli',
  'kimi',
  'share-dir',
)

describe('KimiProvider', () => {
  const originalShareDir = process.env.KIMI_SHARE_DIR

  afterEach(() => {
    if (originalShareDir === undefined) {
      delete process.env.KIMI_SHARE_DIR
    } else {
      process.env.KIMI_SHARE_DIR = originalShareDir
    }
  })

  it('lists Kimi sessions from kimi.json workdir metadata, preserves named session ids, and prefers metadata.json title/archive state', async () => {
    process.env.KIMI_SHARE_DIR = fixtureShareDir
    const provider = new KimiProvider()

    const sessions = await provider.listSessionsDirect()

    expect(sessions).toContainEqual(expect.objectContaining({
      provider: 'kimi',
      sessionId: 'kimi-session-1',
      cwd: '/repo/root/packages/app',
      projectPath: '/repo/root',
      sourceFile: expect.stringContaining(path.join('kimi-session-1', 'context.jsonl')),
      title: 'Pinned title from metadata',
      archived: true,
    }))

    expect(sessions.find((session) => session.sessionId === 'named-kimi-session')?.sessionId).toBe('named-kimi-session')
  })

  it('falls back from metadata.json to wire.jsonl title, then to first user message', async () => {
    process.env.KIMI_SHARE_DIR = fixtureShareDir
    const provider = new KimiProvider()

    const sessions = await provider.listSessionsDirect()

    expect(sessions.find((session) => session.sessionId === 'wire-title-session')?.title).toBe('Fix the left sidebar refresh bug')
    expect(sessions.find((session) => session.sessionId === 'context-title-session')?.title).toBe('Message-only fallback title')
    expect(sessions.find((session) => session.sessionId === 'legacy-flat-session')?.sourceFile).toMatch(/legacy-flat-session\.jsonl$/)
    expect(sessions.find((session) => session.sessionId === 'context_1')).toBeUndefined()
    expect(sessions.find((session) => session.sessionId === 'context_sub_1')).toBeUndefined()
  })

  it('prefers the modern context.jsonl transcript over a stale legacy flat transcript with the same session id', async () => {
    const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-modern-precedence-'))
    await fsp.cp(fixtureShareDir, tempShareDir, { recursive: true })
    const workDirHash = createHash('md5').update('/repo/root/packages/app').digest('hex')
    const legacyTranscriptPath = path.join(
      tempShareDir,
      'sessions',
      workDirHash,
      'kimi-session-1.jsonl',
    )
    await fsp.writeFile(legacyTranscriptPath, [
      JSON.stringify({ role: 'user', content: 'stale legacy transcript should not win' }),
      JSON.stringify({ role: 'assistant', content: 'stale legacy assistant output' }),
    ].join('\n'))

    try {
      const provider = new KimiProvider(tempShareDir)
      const sessions = await provider.listSessionsDirect()
      const matches = sessions.filter((session) => session.sessionId === 'kimi-session-1')

      expect(matches).toHaveLength(1)
      expect(matches[0]).toEqual(expect.objectContaining({
        sourceFile: expect.stringContaining(path.join('kimi-session-1', 'context.jsonl')),
        firstUserMessage: 'visible-user-token-kimi please investigate the routing bug',
        title: 'Pinned title from metadata',
      }))
    } finally {
      await fsp.rm(tempShareDir, { recursive: true, force: true })
    }
  })

  it('flattens visible transcript content and ignores internal records', () => {
    const provider = new KimiProvider('/tmp/.kimi')

    expect(provider.parseEvent('{"role":"user","content":"List files"}')).toEqual([
      expect.objectContaining({
        type: 'message.user',
        message: expect.objectContaining({ content: 'List files' }),
      }),
    ])
    expect(provider.parseEvent('{"role":"assistant","content":[{"type":"think","think":"hidden"},{"type":"text","text":"Visible answer"}]}')).toEqual([
      expect.objectContaining({
        type: 'message.assistant',
        message: expect.objectContaining({ content: 'Visible answer' }),
      }),
    ])
    expect(provider.parseEvent(JSON.stringify({
      role: 'assistant',
      content: [
        {
          type: 'text',
          content: [
            { type: 'text', text: 'Nested' },
            [
              { type: 'text', text: 'assistant' },
              { type: 'think', think: 'hidden nested thought' },
            ],
            { type: 'rich', content: ['content', { text: 'fragments' }] },
          ],
        },
      ],
    }))).toEqual([
      expect.objectContaining({
        type: 'message.assistant',
        message: expect.objectContaining({ content: 'Nested\nassistant\ncontent\nfragments' }),
      }),
    ])
    expect(provider.parseEvent('{"role":"_system_prompt","content":"hidden"}')).toEqual([])
    expect(provider.parseEvent('{"role":"_checkpoint","id":3}')).toEqual([])
    expect(provider.parseEvent('{"role":"_usage","token_count":42}')).toEqual([])
    expect(provider.supportsLiveStreaming()).toBe(false)
    expect(provider.supportsSessionResume()).toBe(true)
  })

  it('derives titles from nested wire/context content fragments', async () => {
    const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-nested-title-'))
    const sessionDir = path.join(
      tempShareDir,
      'sessions',
      '4a3dcd71f4774356bb688dad99173808',
      'nested-title-session',
    )
    await fsp.mkdir(sessionDir, { recursive: true })
    await fsp.writeFile(path.join(tempShareDir, 'kimi.json'), JSON.stringify({
      work_dirs: [{
        path: '/repo/root/packages/app',
        last_session_id: 'nested-title-session',
      }],
    }))
    await fsp.writeFile(path.join(sessionDir, 'context.jsonl'), [
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', content: [{ type: 'text', text: 'Nested context fallback title' }] }],
      }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible assistant' }],
      }),
    ].join('\n'))
    await fsp.writeFile(path.join(sessionDir, 'wire.jsonl'), [
      JSON.stringify({
        timestamp: 1710000100,
        message: {
          type: 'TurnBegin',
          payload: {
            user_input: [
              { type: 'text', content: [{ type: 'text', text: 'Nested wire title' }] },
            ],
          },
        },
      }),
    ].join('\n'))

    try {
      const provider = new KimiProvider(tempShareDir)
      const sessions = await provider.listSessionsDirect()

      expect(sessions.find((session) => session.sessionId === 'nested-title-session')).toEqual(
        expect.objectContaining({
          title: 'Nested wire title',
          firstUserMessage: 'Nested context fallback title',
        }),
      )
    } finally {
      await fsp.rm(tempShareDir, { recursive: true, force: true })
    }
  })

  it('resolves git metadata once per cwd even when multiple sessions share a workdir', async () => {
    const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-share-dir-'))
    await fsp.cp(fixtureShareDir, tempShareDir, { recursive: true })
    await fsp.mkdir(path.join(
      tempShareDir,
      'sessions',
      '4a3dcd71f4774356bb688dad99173808',
      'kimi-session-2',
    ), { recursive: true })
    await fsp.writeFile(path.join(
      tempShareDir,
      'sessions',
      '4a3dcd71f4774356bb688dad99173808',
      'kimi-session-2',
      'context.jsonl',
    ), '{"role":"user","content":"Another session in the same cwd"}\n')

    vi.mocked(resolveGitRepoRoot).mockClear()
    vi.mocked(resolveGitBranchAndDirty).mockClear()

    try {
      const provider = new KimiProvider(tempShareDir)
      const sessions = await provider.listSessionsDirect()

      expect(sessions.filter((session) => session.cwd === '/repo/root/packages/app')).toHaveLength(2)
      expect(resolveGitRepoRoot).toHaveBeenCalledTimes(5)
      expect(resolveGitBranchAndDirty).toHaveBeenCalledTimes(5)
    } finally {
      await fsp.rm(tempShareDir, { recursive: true, force: true })
    }
  })

  it('returns integer lastActivityAt even when filesystem mtimeMs has sub-millisecond precision', async () => {
    const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-float-mtime-'))
    const workDirHash = createHash('md5').update('/test/project').digest('hex')
    const sessionDir = path.join(tempShareDir, 'sessions', workDirHash, 'float-mtime-session')
    await fsp.mkdir(sessionDir, { recursive: true })
    await fsp.writeFile(
      path.join(tempShareDir, 'kimi.json'),
      JSON.stringify({
        work_dirs: [{ path: '/test/project', last_session_id: 'float-mtime-session' }],
      }),
    )
    const contextPath = path.join(sessionDir, 'context.jsonl')
    await fsp.writeFile(
      contextPath,
      JSON.stringify({ role: 'user', content: 'test message' }) + '\n',
    )
    // Set mtime to a value that will have sub-millisecond precision on most filesystems.
    // Note: utimes accepts seconds, so 1774212239.4580225 -> mtimeMs ~ 1774212239458.0225
    const floatTimeSec = 1774212239.4580225
    await fsp.utimes(contextPath, floatTimeSec, floatTimeSec)

    try {
      const provider = new KimiProvider(tempShareDir)
      const sessions = await provider.listSessionsDirect()
      const session = sessions.find((s) => s.sessionId === 'float-mtime-session')

      expect(session).toBeDefined()
      expect(Number.isInteger(session!.lastActivityAt)).toBe(true)

      // Must pass Zod schema validation
      expect(() =>
        SessionDirectoryItemSchema.parse({
          ...session,
          isRunning: false,
        }),
      ).not.toThrow()
    } finally {
      await fsp.rm(tempShareDir, { recursive: true, force: true })
    }
  })

  it('reuses cached Kimi sessions and rereads only the changed session on incremental refresh', async () => {
    const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-provider-incremental-'))
    await fsp.cp(fixtureShareDir, tempShareDir, { recursive: true })
    const provider = new KimiProvider(tempShareDir)
    const metadataPath = path.join(
      tempShareDir,
      'sessions',
      '60934fecd4200ec4efe2eccf0cabafa4',
      'context-title-session',
      'metadata.json',
    )
    const unrelatedContextPath = path.join(
      tempShareDir,
      'sessions',
      '4a3dcd71f4774356bb688dad99173808',
      'kimi-session-1',
      'context.jsonl',
    )

    try {
      await provider.listSessionsDirect()

      const readFileSpy = vi.spyOn(fsp, 'readFile')
      vi.mocked(resolveGitRepoRoot).mockClear()
      vi.mocked(resolveGitBranchAndDirty).mockClear()

      await fsp.writeFile(metadataPath, JSON.stringify({
        title: 'Incremental metadata title',
        archived: true,
      }))

      const sessions = await provider.listSessionsDirect({
        changedFiles: [metadataPath],
        deletedFiles: [],
      })

      expect(sessions.find((session) => session.sessionId === 'context-title-session')).toEqual(
        expect.objectContaining({
          title: 'Incremental metadata title',
          archived: true,
        }),
      )

      const readPaths = readFileSpy.mock.calls
        .map(([target]) => (typeof target === 'string' ? target : ''))
        .filter((target) => target.startsWith(tempShareDir))

      expect(readPaths).toContain(metadataPath)
      expect(readPaths).not.toContain(unrelatedContextPath)
      expect(resolveGitRepoRoot).not.toHaveBeenCalled()
      expect(resolveGitBranchAndDirty).not.toHaveBeenCalled()

      readFileSpy.mockRestore()
    } finally {
      await fsp.rm(tempShareDir, { recursive: true, force: true })
    }
  })
})
