// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TerminalMeta } from '../../../server/terminal-metadata-service'

// Mock config-store before importing the module under test
vi.mock('../../../server/config-store', () => ({
  configStore: {
    patchSessionOverride: vi.fn().mockResolvedValue({}),
    patchTerminalOverride: vi.fn().mockResolvedValue({}),
  },
}))

import { configStore } from '../../../server/config-store'
import {
  cascadeSessionRenameToTerminal,
  findTerminalForSession,
} from '../../../server/rename-cascade'

function makeMeta(overrides: Partial<TerminalMeta> = {}): TerminalMeta {
  return {
    terminalId: overrides.terminalId ?? 'term-1',
    updatedAt: overrides.updatedAt ?? Date.now(),
    cwd: overrides.cwd,
    provider: overrides.provider,
    sessionId: overrides.sessionId,
  }
}

describe('rename-cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('cascadeSessionRenameToTerminal', () => {
    it('calls patchTerminalOverride when a matching terminal exists', async () => {
      const allMeta: TerminalMeta[] = [
        makeMeta({ terminalId: 'term-shell', provider: undefined }),
        makeMeta({ terminalId: 'term-claude', provider: 'claude', sessionId: 'sess-1' }),
        makeMeta({ terminalId: 'term-codex', provider: 'codex', sessionId: 'sess-2' }),
      ]

      const result = await cascadeSessionRenameToTerminal(
        allMeta,
        'claude',
        'sess-1',
        'Session Title',
      )

      expect(configStore.patchTerminalOverride).toHaveBeenCalledOnce()
      expect(configStore.patchTerminalOverride).toHaveBeenCalledWith(
        'term-claude',
        { titleOverride: 'Session Title' },
      )
      expect(result).toBe('term-claude')
    })

    it('returns undefined when no terminal matches', async () => {
      const allMeta: TerminalMeta[] = [
        makeMeta({ terminalId: 'term-shell', provider: undefined }),
        makeMeta({ terminalId: 'term-codex', provider: 'codex', sessionId: 'sess-2' }),
      ]

      const result = await cascadeSessionRenameToTerminal(
        allMeta,
        'claude',
        'nonexistent-session',
        'Title',
      )

      expect(configStore.patchTerminalOverride).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })
  })

  describe('findTerminalForSession', () => {
    it('returns correct terminal meta matching provider and sessionId', () => {
      const target = makeMeta({
        terminalId: 'term-claude',
        provider: 'claude',
        sessionId: 'sess-1',
      })
      const allMeta: TerminalMeta[] = [
        makeMeta({ terminalId: 'term-shell', provider: undefined }),
        target,
        makeMeta({ terminalId: 'term-codex', provider: 'codex', sessionId: 'sess-2' }),
      ]

      const result = findTerminalForSession(allMeta, 'claude', 'sess-1')

      expect(result).toBe(target)
    })

    it('returns undefined when no terminal matches', () => {
      const allMeta: TerminalMeta[] = [
        makeMeta({ terminalId: 'term-shell', provider: undefined }),
      ]

      const result = findTerminalForSession(allMeta, 'claude', 'sess-1')

      expect(result).toBeUndefined()
    })

    it('matches by both provider and sessionId (not just sessionId)', () => {
      const allMeta: TerminalMeta[] = [
        makeMeta({ terminalId: 'term-codex', provider: 'codex', sessionId: 'sess-1' }),
      ]

      // Same sessionId but different provider should not match
      const result = findTerminalForSession(allMeta, 'claude', 'sess-1')

      expect(result).toBeUndefined()
    })
  })
})
