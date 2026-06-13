import { describe, expect, it } from 'vitest'
import {
  getPairedPublicSessionType,
  isKnownSessionMetadataType,
  isDurableProviderSessionId,
  isPublicSessionType,
  resolveSessionTypeRuntimeProvider,
  shouldApplySessionTypeMetadata,
} from '../../../shared/session-flavor.js'

describe('session flavor shared contract', () => {
  it.each([
    ['claude', 'freshclaude'],
    ['codex', 'freshcodex'],
    ['opencode', 'freshopencode'],
    ['freshclaude', 'claude'],
    ['freshcodex', 'codex'],
    ['freshopencode', 'opencode'],
  ] as const)('pairs %s with %s', (source, target) => {
    expect(getPairedPublicSessionType(source)).toBe(target)
  })

  it('excludes hidden and unknown session types from public metadata', () => {
    expect(isPublicSessionType('freshclaude')).toBe(true)
    expect(isPublicSessionType('kilroy')).toBe(false)
    expect(isPublicSessionType('shell')).toBe(false)
    expect(isPublicSessionType('freshmadeup')).toBe(false)
  })

  it('keeps kilroy as known metadata for existing hidden flows', () => {
    expect(isKnownSessionMetadataType('kilroy')).toBe(true)
    expect(isKnownSessionMetadataType('freshmadeup')).toBe(false)
  })

  it.each([
    ['claude', 'claude'],
    ['freshclaude', 'claude'],
    ['codex', 'codex'],
    ['freshcodex', 'codex'],
    ['opencode', 'opencode'],
    ['freshopencode', 'opencode'],
  ] as const)('resolves %s to runtime provider %s', (sessionType, provider) => {
    expect(resolveSessionTypeRuntimeProvider(sessionType)).toBe(provider)
  })

  it('validates durable provider session ids without accepting known placeholders', () => {
    expect(isDurableProviderSessionId('claude', '550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isDurableProviderSessionId('claude', 'runtime-sdk-session-id')).toBe(false)
    expect(isDurableProviderSessionId('codex', 'codex-thread-1')).toBe(true)
    expect(isDurableProviderSessionId('codex', '')).toBe(false)
    expect(isDurableProviderSessionId('codex', 'freshcodex-req-1')).toBe(false)
    expect(isDurableProviderSessionId('opencode', 'ses_real_1')).toBe(true)
    expect(isDurableProviderSessionId('opencode', 'freshopencode-req-1')).toBe(false)
  })

  it('keeps explicit metadata ahead of later materialization metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'claude', sessionTypeSource: 'explicit' },
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
    )).toBe(false)
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
      { sessionType: 'claude', sessionTypeSource: 'explicit' },
    )).toBe(true)
  })

  it('keeps source-less metadata ahead of different materialized metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'claude' },
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
    )).toBe(false)
  })

  it('allows explicit metadata to replace different source-less metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'freshclaude' },
      { sessionType: 'claude', sessionTypeSource: 'explicit' },
    )).toBe(true)
  })

  it('upgrades same-type source-less metadata to explicit metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'freshclaude' },
      { sessionType: 'freshclaude', sessionTypeSource: 'explicit' },
    )).toBe(true)
  })

  it('upgrades same-type materialized metadata to explicit metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
      { sessionType: 'freshclaude', sessionTypeSource: 'explicit' },
    )).toBe(true)
  })
})
