import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { createHash } from 'crypto'

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

import { parseCodexSessionContent } from '../../../../server/coding-cli/providers/codex'
import { parseSessionContent } from '../../../../server/coding-cli/providers/claude'
import { KimiProvider } from '../../../../server/coding-cli/providers/kimi'

const kimiFixtureShareDir = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'coding-cli',
  'kimi',
  'share-dir',
)

describe('session visibility flags', () => {
  describe('Codex isNonInteractive detection', () => {
    it('sets isNonInteractive when source is "exec"', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc-123', cwd: '/home/user/project', source: 'exec' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'Review this code' }] },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.isNonInteractive).toBe(true)
    })

    it('does not set isNonInteractive when source is absent', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc-123', cwd: '/home/user/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'Help me' }] },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })

    it('does not set isNonInteractive when source is "interactive"', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc-123', cwd: '/home/user/project', source: 'interactive' },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })
  })

  describe('Claude isNonInteractive detection', () => {
    it('sets isNonInteractive when entrypoint is sdk-cli', () => {
      const content = [
        JSON.stringify({ entrypoint: 'sdk-cli', cwd: '/home/user/project', type: 'user', message: { role: 'user', content: 'Automated task' } }),
      ].join('\n')

      const meta = parseSessionContent(content)
      expect(meta.isNonInteractive).toBe(true)
    })

    it('does not set isNonInteractive for queue-operation records (interactive signal)', () => {
      const content = [
        JSON.stringify({ cwd: '/home/user/project', type: 'user', message: { role: 'user', content: 'Help me' } }),
        JSON.stringify({ type: 'queue-operation', subtype: 'enqueue', content: 'queued message' }),
      ].join('\n')

      const meta = parseSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })

    it('does not set isNonInteractive for normal Claude sessions', () => {
      const content = [
        JSON.stringify({ cwd: '/home/user/project', type: 'user', message: { role: 'user', content: 'Help me' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure!' }] } }),
      ].join('\n')

      const meta = parseSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })
  })

  describe('Kimi isNonInteractive detection', () => {
    it('sets isNonInteractive when wire.jsonl TurnBegin user_input is a string', async () => {
      const provider = new KimiProvider(kimiFixtureShareDir)
      const sessions = await provider.listSessionsDirect()
      const printSession = sessions.find((s) => s.sessionId === 'print-mode-session')

      expect(printSession).toBeDefined()
      expect(printSession!.isNonInteractive).toBe(true)
    })

    it('does not set isNonInteractive when wire.jsonl TurnBegin user_input is an array', async () => {
      const provider = new KimiProvider(kimiFixtureShareDir)
      const sessions = await provider.listSessionsDirect()
      const interactiveSession = sessions.find((s) => s.sessionId === 'wire-title-session')

      expect(interactiveSession).toBeDefined()
      expect(interactiveSession!.isNonInteractive).toBeFalsy()
    })

    it('does not set isNonInteractive when wire.jsonl is absent', async () => {
      const provider = new KimiProvider(kimiFixtureShareDir)
      const sessions = await provider.listSessionsDirect()
      const noWireSession = sessions.find((s) => s.sessionId === 'context-title-session')

      expect(noWireSession).toBeDefined()
      expect(noWireSession!.isNonInteractive).toBeFalsy()
    })

    it('does not set isNonInteractive when wire.jsonl has no TurnBegin records', async () => {
      const tempShareDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kimi-noninteractive-no-turnbegin-'))
      const workDirHash = createHash('md5').update('/test/no-turnbegin').digest('hex')
      const sessionDir = path.join(tempShareDir, 'sessions', workDirHash, 'no-turnbegin-session')
      await fsp.mkdir(sessionDir, { recursive: true })
      await fsp.writeFile(
        path.join(tempShareDir, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: '/test/no-turnbegin' }] }),
      )
      await fsp.writeFile(
        path.join(sessionDir, 'context.jsonl'),
        JSON.stringify({ role: 'user', content: 'test' }) + '\n',
      )
      await fsp.writeFile(
        path.join(sessionDir, 'wire.jsonl'),
        '{"type":"metadata","protocol_version":"1.2"}\n',
      )

      try {
        const provider = new KimiProvider(tempShareDir)
        const sessions = await provider.listSessionsDirect()
        const session = sessions.find((s) => s.sessionId === 'no-turnbegin-session')

        expect(session).toBeDefined()
        expect(session!.isNonInteractive).toBeFalsy()
      } finally {
        await fsp.rm(tempShareDir, { recursive: true, force: true })
      }
    })
  })
})
