import { describe, expect, it } from 'vitest'

import {
  FRESH_AGENT_CONTRACT_SCHEMA_NAMES,
  FreshAgentActionResultSchema,
  FreshAgentCapabilitiesSchema,
  FreshAgentContractErrorSchema,
  FreshAgentRequestIdSchema,
  FreshAgentSessionCommandSchema,
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
  FreshAgentTurnSchema,
} from '../../../shared/fresh-agent-contract.js'
import {
  claudeContractSnapshot,
  claudeContractTurnBody,
  claudeContractTurnPage,
} from '../../fixtures/fresh-agent/claude/contract-fixtures.js'
import {
  codexContractSnapshot,
  codexContractTurnBody,
  codexContractTurnPage,
} from '../../fixtures/fresh-agent/codex/contract-fixtures.js'

describe('fresh-agent shared contract schemas', () => {
  it('parses Claude and Codex snapshots through one shared durable contract', () => {
    const claudeSnapshot = FreshAgentSnapshotSchema.parse(claudeContractSnapshot)
    expect(claudeSnapshot.sessionType).toBe('freshclaude')
    expect(claudeSnapshot.extensions.claude).toMatchObject({
      historySessionId: '00000000-0000-4000-8000-000000000111',
      liveSessionId: 'sdk-claude-1',
    })
    expect(claudeSnapshot.extensions.claude).not.toHaveProperty('timelineSessionId')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).sessionType).toBe('freshcodex')
    expect(claudeSnapshot.turns[0].summaryKind).toBe('echo')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).turns[0].summaryKind).toBe('echo')
  })

  it('parses turn pages and turn bodies with the full session locator', () => {
    expect(FreshAgentTurnPageSchema.parse(claudeContractTurnPage).provider).toBe('claude')
    expect(FreshAgentTurnPageSchema.parse(codexContractTurnPage).provider).toBe('codex')
    expect(FreshAgentTurnBodySchema.parse(claudeContractTurnBody).threadId).toBe('sdk-claude-1')
    expect(FreshAgentTurnBodySchema.parse(codexContractTurnBody).threadId).toBe('thread-codex-1')
  })

  it('keeps Codex server request ids as string or integer values', () => {
    expect(FreshAgentRequestIdSchema.parse('request-1')).toBe('request-1')
    expect(FreshAgentRequestIdSchema.parse(42)).toBe(42)
    expect(() => FreshAgentRequestIdSchema.parse(1.25)).toThrow()
  })

  it('rejects provider blobs that bypass the typed extension boundary', () => {
    expect(() => FreshAgentSnapshotSchema.parse({
      ...codexContractSnapshot,
      extensions: { codex: { review: { id: 'review-1' } }, extraProvider: {} },
    })).toThrow()
  })

  it('parses a snapshot carrying provider-advertised session commands and round-trips the rows', () => {
    const commands = [
      { name: 'compact', description: 'Compact the conversation', argumentHint: '[focus]', aliases: ['squeeze'] },
      { name: 'review', description: '' },
    ]
    const parsed = FreshAgentSnapshotSchema.parse({ ...claudeContractSnapshot, commands })
    expect(parsed.commands).toEqual(commands)
    expect(FreshAgentSessionCommandSchema.parse(commands[0])).toEqual(commands[0])
    expect(FreshAgentSessionCommandSchema.parse(commands[1])).toEqual(commands[1])
  })

  it('rejects garbage session-command rows on the row schema and inside the snapshot', () => {
    const garbageRows = [
      { description: 'missing name' },
      { name: '', description: 'empty name' },
      { name: 'compact', description: 'strict extra key', bogus: true },
    ]
    for (const row of garbageRows) {
      expect(() => FreshAgentSessionCommandSchema.parse(row)).toThrow()
      expect(() => FreshAgentSnapshotSchema.parse({ ...claudeContractSnapshot, commands: [row] })).toThrow()
    }
  })

  it('parses snapshots without commands exactly as before (graceful absence for Rust/codex/offline)', () => {
    const claudeParsed = FreshAgentSnapshotSchema.parse(claudeContractSnapshot)
    const codexParsed = FreshAgentSnapshotSchema.parse(codexContractSnapshot)
    expect('commands' in claudeParsed).toBe(false)
    expect('commands' in codexParsed).toBe(false)
    expect(claudeParsed.sessionType).toBe('freshclaude')
    expect(codexParsed.sessionType).toBe('freshcodex')
  })

  it('registers the session-command schema for contract traceability', () => {
    expect(FRESH_AGENT_CONTRACT_SCHEMA_NAMES).toContain('FreshAgentSessionCommandSchema')
  })

  it('parses action results and contract errors with locator context', () => {
    expect(FreshAgentActionResultSchema.parse({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-codex-1',
      action: 'fork',
      result: { threadId: 'thread-child-1' },
    }).action).toBe('fork')

    expect(FreshAgentContractErrorSchema.parse({
      code: 'FRESH_AGENT_CONTRACT_PARSE_FAILED',
      message: 'Invalid snapshot',
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: 'thread-codex-1',
    }).code).toBe('FRESH_AGENT_CONTRACT_PARSE_FAILED')
  })
})

describe('rollback surface (kata 1wxv)', () => {
  it('capabilities accept optional undo/redo keys and stay strict', () => {
    const parsed = FreshAgentCapabilitiesSchema.safeParse({
      send: true, interrupt: true, approvals: false, questions: false, fork: false, undo: true, redo: false,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.undo).toBe(true)
    expect(parsed.data?.redo).toBe(false)
  })
  it('capabilities without the new keys still parse (legacy TS server never emits them)', () => {
    expect(FreshAgentCapabilitiesSchema.safeParse({
      send: true, interrupt: true, approvals: false, questions: false, fork: false,
    }).success).toBe(true)
  })
  it('a turn may carry rolledBack', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true,
    })
    expect(parsed.success).toBe(true)
  })
  it('snapshot accepts rolledBackTurns + the inline rollback block', () => {
    const turn = { id: 't2', turnId: 't2', summary: 'gone', items: [], rolledBack: true }
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [], rolledBackTurns: [turn], rollback: { canRedo: true, undoneDepth: 1 },
      extensions: {},
    })
    expect(parsed.success).toBe(true)
  })
  it('delta-r1 F6: the rollback block accepts the optional redoableTurnIds gate set, and the block stays strict', () => {
    const base = {
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle' as const,
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [] as unknown[], extensions: {},
    }
    // The pre-F6 surface (no key) still parses — legacy harmlessness.
    expect(FreshAgentSnapshotSchema.safeParse({
      ...base, rollback: { canRedo: true, undoneDepth: 1 },
    }).success).toBe(true)
    // The F6 server shape parses; the set is exactly a string array.
    const withGate = FreshAgentSnapshotSchema.safeParse({
      ...base, rollback: { canRedo: true, undoneDepth: 1, redoableTurnIds: ['t2'] },
    })
    expect(withGate.success).toBe(true)
    expect(withGate.data?.rollback?.redoableTurnIds).toEqual(['t2'])
    // Strictness holds inside the block: undeclared keys reject.
    expect(FreshAgentSnapshotSchema.safeParse({
      ...base, rollback: { canRedo: true, undoneDepth: 1, redoableTurnIdsTypo: ['t2'] },
    }).success).toBe(false)
  })
  it('snapshot remains strict against undeclared keys', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [], extensions: {}, rollbackTypo: {},
    })
    expect(parsed.success).toBe(false)
  })
})
