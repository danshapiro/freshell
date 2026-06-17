import { describe, expect, it } from 'vitest'

import {
  normalizeOpencodeSnapshot,
  normalizeOpencodeTurn,
  normalizeOpencodeTurnPage,
} from '../../../../server/fresh-agent/adapters/opencode/normalize.js'
import {
  FreshAgentSnapshotSchema,
  FreshAgentTurnPageSchema,
} from '../../../../shared/fresh-agent-contract.js'

describe('OpenCode fresh-agent normalization', () => {
  it('maps file, patch, and compaction parts to shared transcript items', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-1', role: 'assistant' },
      parts: [
        {
          id: 'part-file',
          type: 'file',
          filename: 'notes.md',
          mime: 'text/markdown',
          content: '# Notes',
        },
        {
          id: 'part-patch',
          type: 'patch',
          files: [
            'src/a.ts',
            { file: 'src/b.ts', additions: 2, deletions: 1 },
          ],
          diff: '@@ -1 +1 @@',
        },
        {
          id: 'part-compaction',
          type: 'compaction',
          summary: 'Compacted older OpenCode context.',
        },
      ],
    }, 0)!

    expect(turn.items).toEqual([
      {
        id: 'part-file',
        kind: 'text',
        text: 'Attached file: notes.md',
      },
      {
        id: 'part-patch',
        kind: 'file_change',
        status: 'completed',
        changes: [
          { path: 'src/a.ts' },
          { file: 'src/b.ts', path: 'src/b.ts', additions: 2, deletions: 1 },
        ],
        extensions: {
          opencode: expect.objectContaining({
            id: 'part-patch',
            type: 'patch',
            diff: '@@ -1 +1 @@',
          }),
        },
      },
      {
        id: 'part-compaction',
        kind: 'context_compaction',
      },
    ])
  })

  it('guards missing patch files and returns an empty completed file change', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-patch', role: 'assistant' },
      parts: [{ id: 'part-patch-empty', type: 'patch', diff: '@@ empty @@' }],
    }, 0)!

    expect(turn.items).toEqual([
      {
        id: 'part-patch-empty',
        kind: 'file_change',
        status: 'completed',
        changes: [],
        extensions: {
          opencode: expect.objectContaining({
            id: 'part-patch-empty',
            type: 'patch',
            diff: '@@ empty @@',
          }),
        },
      },
    ])
  })

  it('omits structural and unknown parts from visible items while preserving raw payloads in snapshot extensions', () => {
    const snapshot = normalizeOpencodeSnapshot({
      sessionType: 'freshopencode',
      threadId: 'ses-extensions',
      exported: {
        info: { id: 'ses-extensions', title: 'Extension payloads', time: { updated: 7 } },
        messages: [
          {
            info: { id: 'msg-structural', role: 'assistant' },
            parts: [
              { id: 'part-step-start', type: 'step-start', phase: 'tooling', index: 1 },
              { id: 'part-step-finish', type: 'step-finish', phase: 'tooling', duration: 23 },
              { id: 'part-unknown', type: 'custom-opencode-part', value: { nested: true } },
              { id: 'part-file', type: 'file', path: 'src/file.ts', mime: 'text/typescript' },
              { id: 'part-compaction', type: 'compaction', summary: 'Trimmed context.' },
            ],
          },
        ],
      },
    })

    const parsed = FreshAgentSnapshotSchema.parse(snapshot)
    expect(parsed.turns[0]?.items.map((item) => item.id)).toEqual(['part-file', 'part-compaction'])
    expect(parsed.extensions.opencode).toMatchObject({
      structuralPartTypes: [
        { type: 'step-start', id: 'part-step-start', messageId: 'msg-structural' },
        { type: 'step-finish', id: 'part-step-finish', messageId: 'msg-structural' },
      ],
      structuralPartCounts: {
        'step-start': 1,
        'step-finish': 1,
      },
      structuralParts: [
        {
          messageId: 'msg-structural',
          part: { id: 'part-step-start', type: 'step-start', phase: 'tooling', index: 1 },
        },
        {
          messageId: 'msg-structural',
          part: { id: 'part-step-finish', type: 'step-finish', phase: 'tooling', duration: 23 },
        },
      ],
      unsupportedPartTypes: [
        { type: 'custom-opencode-part', id: 'part-unknown', messageId: 'msg-structural' },
      ],
      unsupportedParts: [
        {
          messageId: 'msg-structural',
          part: { id: 'part-unknown', type: 'custom-opencode-part', value: { nested: true } },
        },
      ],
      fileParts: [
        {
          messageId: 'msg-structural',
          part: { id: 'part-file', type: 'file', path: 'src/file.ts', mime: 'text/typescript' },
        },
      ],
      compactionParts: [
        {
          messageId: 'msg-structural',
          part: { id: 'part-compaction', type: 'compaction', summary: 'Trimmed context.' },
        },
      ],
    })
  })

  it('strips surrounding quotes from user text parts added by the OpenCode CLI', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-user-quoted', role: 'user' },
      parts: [{ id: 'part-user-quoted', type: 'text', text: '"Do a directory listing."' }],
    }, 0)!

    expect(turn.role).toBe('user')
    expect(turn.items).toEqual([
      { id: 'part-user-quoted', kind: 'text', text: 'Do a directory listing.' },
    ])
    expect(turn.summary).toBe('Do a directory listing.')
  })

  it('leaves unquoted user text parts unchanged', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-user-plain', role: 'user' },
      parts: [{ id: 'part-user-plain', type: 'text', text: 'Do a directory listing.' }],
    }, 0)!

    expect(turn.items[0]?.text).toBe('Do a directory listing.')
    expect(turn.summary).toBe('Do a directory listing.')
  })

  it('does not strip surrounding quotes from assistant text parts', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-assistant-quoted', role: 'assistant' },
      parts: [{ id: 'part-assistant-quoted', type: 'text', text: '"Hello, world."' }],
    }, 0)!

    expect(turn.role).toBe('assistant')
    expect(turn.items[0]?.text).toBe('"Hello, world."')
  })

  it('strips only one pair of surrounding quotes from user text parts', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-user-nested', role: 'user' },
      parts: [{ id: 'part-user-nested', type: 'text', text: '""nested" quotes"' }],
    }, 0)!

    expect(turn.items[0]?.text).toBe('"nested" quotes')
  })

  it('maps balanced leaked think/thinking tags to thinking items while preserving visible assistant text', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-think-tags', role: 'assistant' },
      parts: [
        {
          id: 'part-think',
          type: 'text',
          text: 'Before <think>Internal plan\n1 tool used</think> and after.',
        },
        {
          id: 'part-thinking',
          type: 'text',
          text: 'Intro <thinking reason="plan">I could change all instances.</thinking> done.',
        },
      ],
    }, 0)!

    expect(turn.items).toEqual([
      { id: 'part-think:text-0', kind: 'text', text: 'Before ' },
      { id: 'part-think:thinking-1', kind: 'thinking', text: 'Internal plan\n1 tool used' },
      { id: 'part-think:text-2', kind: 'text', text: ' and after.' },
      { id: 'part-thinking:text-0', kind: 'text', text: 'Intro ' },
      { id: 'part-thinking:thinking-1', kind: 'thinking', text: 'I could change all instances.' },
      { id: 'part-thinking:text-2', kind: 'text', text: ' done.' },
    ])
    expect(turn.summary).toBe('Before  and after.\n\nIntro  done.')
  })

  it('maps malformed leading think closers in OpenCode tool turns to thinking and drops marker-only parts', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-leaked-tool-thinking', role: 'assistant' },
      parts: [
        { id: 'part-marker-only', type: 'text', text: '</think>' },
        { id: 'part-leading-close', type: 'text', text: '</think></think>Need to edit the CSS.</think>' },
        {
          id: 'part-tool',
          type: 'tool',
          tool: 'edit',
          state: {
            status: 'completed',
            input: { filePath: 'src/index.css' },
            output: 'Edit applied successfully.',
          },
        },
      ],
    }, 0)

    expect(turn.items).toEqual([
      { id: 'part-leading-close', kind: 'thinking', text: 'Need to edit the CSS.' },
      {
        id: 'part-tool',
        kind: 'dynamic_tool',
        namespace: 'opencode',
        tool: 'edit',
        status: 'completed',
        arguments: { filePath: 'src/index.css' },
        contentItems: ['Edit applied successfully.'],
        success: true,
      },
    ])
  })

  it('keeps final visible assistant text when a malformed leading think closer leaks outside a tool turn', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-final-text', role: 'assistant' },
      parts: [{ id: 'part-final', type: 'text', text: '</think>Done. Updated the CSS.' }],
    }, 0)

    expect(turn.items).toEqual([
      { id: 'part-final', kind: 'text', text: 'Done. Updated the CSS.' },
    ])
    expect(turn.summary).toBe('Done. Updated the CSS.')
  })

  it('keeps final visible assistant text when a malformed leading think closer appears after a tool', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-final-text-after-tool', role: 'assistant' },
      parts: [
        {
          id: 'part-tool',
          type: 'tool',
          tool: 'edit',
          state: { status: 'completed', input: {}, output: 'done' },
        },
        { id: 'part-final', type: 'text', text: '</think>Done. Updated the CSS.' },
      ],
    }, 0)

    expect(turn.items.at(-1)).toEqual({ id: 'part-final', kind: 'text', text: 'Done. Updated the CSS.' })
    expect(turn.summary).toBe('Done. Updated the CSS.')
  })

  it('maps unterminated leaked think tags to thinking without empty transcript text', () => {
    const bare = normalizeOpencodeTurn({
      info: { id: 'msg-bare-open', role: 'assistant' },
      parts: [{ id: 'part-bare-open', type: 'text', text: '<think>' }],
    }, 0)
    expect(bare.items).toEqual([])

    const mixed = normalizeOpencodeTurn({
      info: { id: 'msg-open', role: 'assistant' },
      parts: [{ id: 'part-open', type: 'text', text: 'Visible <think>hidden plan' }],
    }, 0)

    expect(mixed.items).toEqual([
      { id: 'part-open:text-0', kind: 'text', text: 'Visible ' },
      { id: 'part-open:thinking-1', kind: 'thinking', text: 'hidden plan' },
    ])
    expect(mixed.summary).toBe('Visible ')
  })

  it('maps dangling leaked think closers to thinking plus visible text', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-dangling-close', role: 'assistant' },
      parts: [{ id: 'part-dangling-close', type: 'text', text: 'hidden plan</think>Visible text' }],
    }, 0)

    expect(turn.items).toEqual([
      { id: 'part-dangling-close:thinking-0', kind: 'thinking', text: 'hidden plan' },
      { id: 'part-dangling-close:text-1', kind: 'text', text: 'Visible text' },
    ])
    expect(turn.summary).toBe('Visible text')
  })

  it('rejects roleless messages even when they contain leaked think tags', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-unknown-role' },
      parts: [{ id: 'part-unknown-role', type: 'text', text: 'hidden planVISIBLE text' }],
    }, 0)

    expect(turn).toBeNull()
  })

  it('preserves think tags in user text parts', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-user-think', role: 'user' },
      parts: [
        { id: 'part-user-think', type: 'text', text: 'Why did the assistant say <think>secret</think>?' },
      ],
    }, 0)!

    expect(turn.items).toEqual([
      { id: 'part-user-think', kind: 'text', text: 'Why did the assistant say <think>secret</think>?' },
    ])
  })

  it('does not trim assistant text that has no leaked think tags', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-preserve-ws', role: 'assistant' },
      parts: [{ id: 'part-ws', type: 'text', text: '  leading\n  and trailing  ' }],
    }, 0)!

    expect(turn.items).toEqual([{ id: 'part-ws', kind: 'text', text: '  leading\n  and trailing  ' }])
  })

  it('leaves reasoning parts untouched', () => {
    const text = 'I am reasoning about <think> tags.'
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-reasoning', role: 'assistant' },
      parts: [{ id: 'part-reasoning', type: 'reasoning', text }],
    }, 0)!

    expect(turn.items).toEqual([
      { id: 'part-reasoning', kind: 'reasoning', summary: [text], content: [text], text },
    ])
  })

  it('keeps user and assistant messages as separate display turns with their native turnIds', () => {
    const snapshot = normalizeOpencodeSnapshot({
      sessionType: 'freshopencode',
      threadId: 'ses-separated-turns',
      exported: {
        messages: [
          {
            info: { id: 'msg-user', role: 'user' },
            parts: [{ id: 'part-user', type: 'text', text: 'Summarize the changes.' }],
          },
          {
            info: { id: 'msg-assistant', role: 'assistant' },
            parts: [{ id: 'part-assistant', type: 'text', text: 'Summarizing now.' }],
          },
        ],
      },
    })

    expect(snapshot.turns).toHaveLength(2)
    expect(snapshot.turns).toMatchObject([
      { turnId: 'msg-user', messageId: 'msg-user', role: 'user', summary: 'Summarize the changes.' },
      { turnId: 'msg-assistant', messageId: 'msg-assistant', role: 'assistant', summary: 'Summarizing now.' },
    ])
  })

  it('rejects visible roleless messages instead of emitting roleless display turns', () => {
    const message = {
      info: { id: 'msg-roleless' },
      parts: [{ id: 'part-roleless', type: 'text', text: 'Hidden until OpenCode provides a display role.' }],
    }

    expect(normalizeOpencodeTurn(message, 0)).toBeNull()

    const snapshot = normalizeOpencodeSnapshot({
      sessionType: 'freshopencode',
      threadId: 'ses-roleless',
      exported: {
        messages: [
          {
            info: { id: 'msg-user', role: 'user' },
            parts: [{ id: 'part-user', type: 'text', text: 'User input' }],
          },
          message,
        ],
      },
    })

    expect(snapshot.turns).toHaveLength(1)
    expect(snapshot.turns[0]).toMatchObject({ turnId: 'msg-user', role: 'user' })
    expect(snapshot.turns.some((turn) => turn.turnId === 'msg-roleless')).toBe(false)
  })

  it('carries turn-page nextCursor explicitly and keeps export fallback compatibility', () => {
    const explicit = normalizeOpencodeTurnPage({
      threadId: 'ses-page',
      exported: { messages: [], nextCursor: 'fallback-cursor' },
      revision: 3,
      nextCursor: 'explicit-cursor',
    })
    expect(FreshAgentTurnPageSchema.parse(explicit).nextCursor).toBe('explicit-cursor')

    const explicitNull = normalizeOpencodeTurnPage({
      threadId: 'ses-page',
      exported: { messages: [], nextCursor: 'fallback-cursor' },
      revision: 3,
      nextCursor: null,
    })
    expect(FreshAgentTurnPageSchema.parse(explicitNull).nextCursor).toBeNull()

    const fallback = normalizeOpencodeTurnPage({
      threadId: 'ses-page',
      exported: { messages: [], nextCursor: 'fallback-cursor' },
      revision: 3,
    })
    expect(FreshAgentTurnPageSchema.parse(fallback).nextCursor).toBe('fallback-cursor')
  })
})
