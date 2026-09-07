import { describe, expect, it } from 'vitest'

import {
  FRESH_AGENT_CONTRACT_SCHEMA_NAMES,
  FreshAgentActionResultSchema,
  FreshAgentContractErrorSchema,
  FreshAgentRequestIdSchema,
  FreshAgentSessionCommandSchema,
  FreshAgentSnapshotClientSchema,
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
} from '../../../shared/fresh-agent-contract.js'
import {
  claudeContractSnapshot,
  claudeContractSnapshotWithStatusSeq,
  claudeContractTurnBody,
  claudeContractTurnPage,
} from '../../fixtures/fresh-agent/claude/contract-fixtures.js'
import {
  codexContractSnapshot,
  codexContractSnapshotWithStatusSeq,
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

  it('parses an optional statusSeq and round-trips it under BOTH the strict and client variants', () => {
    for (const fixture of [claudeContractSnapshotWithStatusSeq, codexContractSnapshotWithStatusSeq]) {
      expect(FreshAgentSnapshotSchema.parse(fixture).statusSeq).toBe(1234)
      expect(FreshAgentSnapshotClientSchema.parse(fixture).statusSeq).toBe(1234)
    }
  })

  it('still parses snapshots without statusSeq under both variants (optional — no regression)', () => {
    expect('statusSeq' in FreshAgentSnapshotSchema.parse(claudeContractSnapshot)).toBe(false)
    expect('statusSeq' in FreshAgentSnapshotSchema.parse(codexContractSnapshot)).toBe(false)
    expect('statusSeq' in FreshAgentSnapshotClientSchema.parse(claudeContractSnapshot)).toBe(false)
    expect('statusSeq' in FreshAgentSnapshotClientSchema.parse(codexContractSnapshot)).toBe(false)
  })

  it('client strip variant: silently strips an unknown future key instead of failing the poll (forward-compat)', () => {
    // LB-01: a long-lived old-bundle tab must not hit a parse error on every
    // snapshot poll when a newer server starts emitting additive keys.
    const parsed = FreshAgentSnapshotClientSchema.parse({
      ...claudeContractSnapshotWithStatusSeq,
      futureField: true,
    })
    expect(parsed.statusSeq).toBe(1234)
    expect((parsed as Record<string, unknown>).futureField).toBeUndefined()
  })

  it('strict server variant still rejects that same unknown key (the split did not relax the server choke)', () => {
    const result = FreshAgentSnapshotSchema.safeParse({
      ...codexContractSnapshotWithStatusSeq,
      futureField: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toContain('futureField')
    }
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
