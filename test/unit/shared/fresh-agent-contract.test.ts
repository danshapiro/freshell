import { describe, expect, it } from 'vitest'

import {
  FreshAgentActionResultSchema,
  FreshAgentContractErrorSchema,
  FreshAgentRequestIdSchema,
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
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
    expect(FreshAgentSnapshotSchema.parse(claudeContractSnapshot).sessionType).toBe('freshclaude')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).sessionType).toBe('freshcodex')
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
