import { describe, it, expect } from 'vitest'
import type { TerminalPaneContent } from '@/store/paneTypes'
import { getCreateSessionStateFromRef, getResumeSessionIdFromRef } from '@/components/terminal-view-utils'

describe('terminal-view-utils', () => {
  it('reads the latest resumeSessionId from the ref', () => {
    const ref: { current: TerminalPaneContent | null } = {
      current: {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        resumeSessionId: 'old-session',
        initialCwd: '/home/user/project',
      },
    }

    expect(getResumeSessionIdFromRef(ref)).toBe('old-session')

    ref.current = {
      ...ref.current,
      resumeSessionId: 'new-session',
    }

    expect(getResumeSessionIdFromRef(ref)).toBe('new-session')
  })

  it('returns explicit live terminal handles separately from the durable sessionRef', () => {
    const ref: { current: TerminalPaneContent | null } = {
      current: {
        kind: 'terminal',
        createRequestId: 'req-2',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        terminalId: 'term-live-1',
        serverInstanceId: 'srv-local',
        sessionRef: {
          provider: 'codex',
          sessionId: 'codex-session-1',
        },
      },
    }

    expect(getCreateSessionStateFromRef(ref)).toEqual({
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-session-1',
      },
      liveTerminal: {
        terminalId: 'term-live-1',
        serverInstanceId: 'srv-local',
      },
    })
  })

  it('uses Codex durability state for create only when no durable sessionRef exists', () => {
    const codexDurability = {
      schemaVersion: 1 as const,
      state: 'captured_pre_turn' as const,
      candidate: {
        provider: 'codex' as const,
        candidateThreadId: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
        rolloutPath: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
        source: 'thread_started_notification' as const,
        capturedAt: 1778743920000,
      },
    }
    const ref: { current: TerminalPaneContent | null } = {
      current: {
        kind: 'terminal',
        createRequestId: 'req-3',
        status: 'creating',
        mode: 'codex',
        shell: 'system',
        codexDurability,
      },
    }

    expect(getCreateSessionStateFromRef(ref)).toEqual({ codexDurability })

    ref.current = {
      ...ref.current,
      sessionRef: {
        provider: 'codex',
        sessionId: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
      },
    }
    expect(getCreateSessionStateFromRef(ref)).toEqual({
      sessionRef: {
        provider: 'codex',
        sessionId: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
      },
    })
  })
})
