import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
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
    expect(provider.parseEvent('{"role":"_system_prompt","content":"hidden"}')).toEqual([])
    expect(provider.parseEvent('{"role":"_checkpoint","id":3}')).toEqual([])
    expect(provider.parseEvent('{"role":"_usage","token_count":42}')).toEqual([])
    expect(provider.supportsLiveStreaming()).toBe(false)
    expect(provider.supportsSessionResume()).toBe(true)
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
})
