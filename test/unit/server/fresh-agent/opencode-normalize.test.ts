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
    }, 0)

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
      info: { id: 'msg-patch' },
      parts: [{ id: 'part-patch-empty', type: 'patch', diff: '@@ empty @@' }],
    }, 0)

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
    }, 0)

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
    }, 0)

    expect(turn.items[0]?.text).toBe('Do a directory listing.')
    expect(turn.summary).toBe('Do a directory listing.')
  })

  it('does not strip surrounding quotes from assistant text parts', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-assistant-quoted', role: 'assistant' },
      parts: [{ id: 'part-assistant-quoted', type: 'text', text: '"Hello, world."' }],
    }, 0)

    expect(turn.role).toBe('assistant')
    expect(turn.items[0]?.text).toBe('"Hello, world."')
  })

  it('strips only one pair of surrounding quotes from user text parts', () => {
    const turn = normalizeOpencodeTurn({
      info: { id: 'msg-user-nested', role: 'user' },
      parts: [{ id: 'part-user-nested', type: 'text', text: '""nested" quotes"' }],
    }, 0)

    expect(turn.items[0]?.text).toBe('"nested" quotes')
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
