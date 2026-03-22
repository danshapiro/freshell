import path from 'path'
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
})
