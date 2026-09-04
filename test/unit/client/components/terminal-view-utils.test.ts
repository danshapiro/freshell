import { describe, it, expect } from 'vitest'
import type { TerminalPaneContent } from '@/store/paneTypes'
import {
  buildCodexIdentityMismatchRepairContent,
  buildTerminalAttachMessage,
  buildTerminalInputMessage,
  buildTerminalResizeMessage,
  getCreateSessionStateFromRef,
  getExpectedSessionRefForTerminalOperation,
  getResumeSessionIdFromRef,
} from '@/components/terminal-view-utils'

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

  it('suppresses unproven live terminal handles when a canonical sessionRef exists', () => {
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

  it('returns expected operation identity only from canonical sessionRef', () => {
    const content: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-4',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      codexDurability: {
        schemaVersion: 1,
        state: 'captured_pre_turn',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'candidate-only',
          rolloutPath: '/tmp/rollout.jsonl',
          source: 'thread_started_notification',
          capturedAt: 1,
        },
      },
    }

    expect(getExpectedSessionRefForTerminalOperation(content)).toBeUndefined()

    content.sessionRef = { provider: 'codex', sessionId: 'thread-1' }
    expect(getExpectedSessionRefForTerminalOperation(content)).toEqual({
      provider: 'codex',
      sessionId: 'thread-1',
    })
  })

  it('builds attach, input, and resize messages with expectedSessionRef when canonical identity exists', () => {
    const content: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-5',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      sessionRef: { provider: 'codex', sessionId: 'thread-2' },
    }

    expect(buildTerminalInputMessage(content, 'term-1', 'hello')).toEqual({
      type: 'terminal.input',
      terminalId: 'term-1',
      data: 'hello',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-2' },
    })
    expect(buildTerminalResizeMessage(content, 'term-1', 100, 30)).toEqual({
      type: 'terminal.resize',
      terminalId: 'term-1',
      cols: 100,
      rows: 30,
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-2' },
    })
    expect(buildTerminalAttachMessage({
      content,
      terminalId: 'term-1',
      intent: 'viewport_hydrate',
      cols: 100,
      rows: 30,
      sinceSeq: 0,
      attachRequestId: 'attach-1',
      priority: 'foreground',
    })).toEqual({
      type: 'terminal.attach',
      terminalId: 'term-1',
      intent: 'viewport_hydrate',
      cols: 100,
      rows: 30,
      sinceSeq: 0,
      attachRequestId: 'attach-1',
      priority: 'foreground',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-2' },
      createRequestId: 'req-5',
    })
  })

  it('the attach carries the attaching pane\'s createRequestId and tabId (delta-r7-r2 F3 — the server re-stamps the row\'s pane identity on attach)', () => {
    const content: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-reattach',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      sessionRef: { provider: 'claude', sessionId: 'sess-reattach' },
    }
    expect(buildTerminalAttachMessage({
      content,
      terminalId: 'term-live',
      tabId: 'tab-9',
      intent: 'viewport_hydrate',
      cols: 100,
      rows: 30,
      sinceSeq: 0,
      attachRequestId: 'attach-9',
      priority: 'foreground',
    })).toEqual({
      type: 'terminal.attach',
      terminalId: 'term-live',
      intent: 'viewport_hydrate',
      cols: 100,
      rows: 30,
      sinceSeq: 0,
      attachRequestId: 'attach-9',
      priority: 'foreground',
      expectedSessionRef: { provider: 'claude', sessionId: 'sess-reattach' },
      createRequestId: 'req-reattach',
      tabId: 'tab-9',
    })
    // A content-less attach (no pane identity in scope — never produced by the
    // pane lifecycle) carries neither key.
    expect(buildTerminalAttachMessage({
      content: undefined,
      terminalId: 'term-live',
      intent: 'keepalive_delta',
      cols: 80,
      rows: 24,
      sinceSeq: 12,
      attachRequestId: 'attach-10',
      priority: 'background',
    })).toEqual({
      type: 'terminal.attach',
      terminalId: 'term-live',
      intent: 'keepalive_delta',
      cols: 80,
      rows: 24,
      sinceSeq: 12,
      attachRequestId: 'attach-10',
      priority: 'background',
    })
  })

  it('builds mismatch repair content that preserves only matching durable Codex identity', () => {
    const repair = buildCodexIdentityMismatchRepairContent({
      kind: 'terminal',
      createRequestId: 'req-old',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-old',
      serverInstanceId: 'srv-1',
      streamId: 'stream-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-3' },
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-3',
      },
    }, { provider: 'codex', sessionId: 'thread-3' }, 'req-new')

    expect(repair).toEqual({
      terminalId: undefined,
      serverInstanceId: undefined,
      streamId: undefined,
      createRequestId: 'req-new',
      status: 'creating',
      sessionRef: { provider: 'codex', sessionId: 'thread-3' },
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-3',
      },
    })

    const candidateOnlyRepair = buildCodexIdentityMismatchRepairContent({
      kind: 'terminal',
      createRequestId: 'req-old',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-old',
      sessionRef: { provider: 'codex', sessionId: 'thread-3' },
      codexDurability: {
        schemaVersion: 1,
        state: 'captured_pre_turn',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-3',
          rolloutPath: '/tmp/rollout.jsonl',
          source: 'thread_started_notification',
          capturedAt: 1,
        },
      },
    }, { provider: 'codex', sessionId: 'thread-3' }, 'req-new')

    expect(candidateOnlyRepair?.codexDurability).toBeUndefined()
  })
})
