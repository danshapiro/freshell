import { describe, expect, it } from 'vitest'
import {
  assertT2Invariants,
  containsSentinel,
  PROVIDER_ID_SHAPES,
  type T2Observation,
} from '../../../../port/oracle/harness/invariants.js'

/**
 * Fast, LIVE-FREE unit coverage for the provider-agnostic T2 invariant logic.
 *
 * We build a known-good synthetic observation (what a green opencode/Kimi run
 * looks like), prove it passes, then MUTATE one fact at a time and prove the
 * matching invariant flips to fail. This validates the oracle's grader itself
 * without spending a single live model call.
 */

function goodObservation(overrides: Partial<T2Observation> = {}): T2Observation {
  return {
    provider: 'opencode',
    model: 'umans-ai-coding-plan/umans-kimi-k2.7',
    prompt: 'Reply with exactly: freshell-t2-ok',
    sentinelToken: 'freshell-t2-ok',

    sessionCreated: true,
    initialSessionId: 'freshopencode-abc123',
    durableSessionId: 'ses_0dedf8321ffeHD7n8QMereeYXd',
    sessionRef: { provider: 'opencode', sessionId: 'ses_0dedf8321ffeHD7n8QMereeYXd' },

    turnAccepted: true,
    turnCompleted: true,
    serverReportedIdle: false, // the real-world finding: reply persists, idle not signalled
    assistantReplyLatencyMs: 10500,
    sendStatus: null,
    submittedTurnId: 'turn_1',

    captureText: 'user: Reply with exactly: freshell-t2-ok\nassistant: freshell-t2-ok\n',
    captureLength: 66,
    captureNonEmpty: true,
    captureContainsSentinel: true,

    dbPath: '/tmp/freshell-e2e-x/.local/share/opencode/opencode.db',
    dbSessionRowPresent: true,
    dbSessionRow: { id: 'ses_0dedf8321ffeHD7n8QMereeYXd', title: 'T2', directory: '/tmp/work' },
    dbMessageCount: 2,
    dbPartCount: 3,
    dbHasAssistantMessage: true,
    transcriptParseable: true,

    wsServerMessageTypes: ['ready', 'settings.updated', 'terminal.inventory', 'freshAgent.session.materialized'],
    sessionMaterializedEvent: {
      previousSessionId: 'freshopencode-abc123',
      sessionId: 'ses_0dedf8321ffeHD7n8QMereeYXd',
      sessionType: 'freshopencode',
      provider: 'opencode',
    },

    ownedCleanupOk: true,
    strayOwnedPidsAfter: [],
    liveModelCalls: 1,

    timings: { createMs: 40, turnMs: 8000, totalMs: 9000 },
    ...overrides,
  }
}

describe('assertT2Invariants (provider-agnostic grader)', () => {
  it('passes a known-good opencode/Kimi observation', () => {
    const report = assertT2Invariants(goodObservation())
    expect(report.ok, report.summary + '\n' + JSON.stringify(report.results, null, 2)).toBe(true)
    expect(report.failed).toBe(0)
    expect(report.provider).toBe('opencode')
  })

  it('registers id-shapes for opencode, claude, and codex (extensible)', () => {
    expect(Object.keys(PROVIDER_ID_SHAPES).sort()).toEqual(['claude', 'codex', 'opencode'])
  })

  // ── mutation table: each mutation must flip exactly its own invariant ──────
  // `nonFatal: true` = the invariant is informational, so the run stays green
  // overall even though that specific row flips to false.
  const mutations: Array<{ name: string; invariant: string; nonFatal?: boolean; patch: Partial<T2Observation> }> = [
    { name: 'no session created', invariant: 'session.created', patch: { sessionCreated: false } },
    { name: 'wrong placeholder shape', invariant: 'session.created', patch: { initialSessionId: 'bogus-id' } },
    { name: 'wrong durable shape', invariant: 'session.durable-id-shape', patch: { durableSessionId: 'not-a-ses-id' } },
    { name: 'null durable id', invariant: 'session.durable-id-shape', patch: { durableSessionId: null } },
    { name: 'turn not accepted', invariant: 'turn.accepted', patch: { turnAccepted: false } },
    { name: 'reply not observed', invariant: 'turn.completed', patch: { turnCompleted: false } },
    { name: 'sentinel missing from reply', invariant: 'assistant.replied-sentinel', patch: { captureContainsSentinel: false } },
    { name: 'no session row persisted', invariant: 'transcript.persisted', patch: { dbSessionRowPresent: false } },
    { name: 'zero messages persisted', invariant: 'transcript.persisted', patch: { dbMessageCount: 0 } },
    { name: 'transcript not parseable', invariant: 'transcript.parseable', patch: { transcriptParseable: false } },
    { name: 'no materialized wire event', invariant: 'wire.session-materialized', nonFatal: true, patch: { sessionMaterializedEvent: null } },
    { name: 'materialized event mislinked', invariant: 'wire.session-materialized', nonFatal: true, patch: { sessionMaterializedEvent: { previousSessionId: 'freshopencode-abc123', sessionId: 'ses_WRONG', sessionType: 'freshopencode', provider: 'opencode' } } },
    { name: 'stray owned pid left behind', invariant: 'ownership.cleanup', patch: { ownedCleanupOk: false, strayOwnedPidsAfter: [4242] } },
  ]

  for (const m of mutations) {
    it(`flips "${m.invariant}" when: ${m.name}`, () => {
      const report = assertT2Invariants(goodObservation(m.patch))
      const inv = report.results.find((r) => r.name === m.invariant)
      expect(inv, `invariant ${m.invariant} should exist`).toBeTruthy()
      expect(inv!.ok, `invariant ${m.invariant} should be false for "${m.name}"`).toBe(false)
      if (m.nonFatal) {
        expect(inv!.fatal, `${m.invariant} should be non-fatal`).toBe(false)
        expect(report.ok, `non-fatal mutation "${m.name}" must NOT fail the run`).toBe(true)
      } else {
        expect(report.ok, `expected overall FAIL for mutation "${m.name}"`).toBe(false)
      }
    })
  }

  it('stays green when the provider never emits idle, but records the finding (non-fatal)', () => {
    const report = assertT2Invariants(goodObservation({ serverReportedIdle: false }))
    expect(report.ok).toBe(true)
    const idle = report.results.find((r) => r.name === 'provider.emits-idle-signal')
    expect(idle!.ok).toBe(false)
    expect(idle!.fatal).toBe(false)
    expect(idle!.detail).toMatch(/serverReportedIdle=false/)
  })

  it('treats an unregistered provider as a shape failure (must register before use)', () => {
    const report = assertT2Invariants(goodObservation({ provider: 'gemini' }))
    expect(report.ok).toBe(false)
    const created = report.results.find((r) => r.name === 'session.created')
    expect(created!.ok).toBe(false)
    expect(created!.detail).toMatch(/no id-shape registered/)
  })

  it('flags an out-of-budget live-call count without failing the run (informational)', () => {
    const report = assertT2Invariants(goodObservation({ liveModelCalls: 9 }))
    // Still passes overall (cost check is non-fatal) but the informational row is false.
    expect(report.ok).toBe(true)
    const cost = report.results.find((r) => r.name === 'cost.live-calls-bounded')
    expect(cost!.ok).toBe(false)
    expect(cost!.fatal).toBe(false)
  })
})

describe('containsSentinel (LLM text tolerance)', () => {
  it('matches the token amid provider preamble, case-insensitively', () => {
    expect(containsSentinel('Sure! Here you go: FRESHELL-T2-OK', 'freshell-t2-ok')).toBe(true)
    expect(containsSentinel('freshell-t2-ok', 'freshell-t2-ok')).toBe(true)
  })
  it('does not match when the token is absent', () => {
    expect(containsSentinel('some other answer', 'freshell-t2-ok')).toBe(false)
    expect(containsSentinel('', 'freshell-t2-ok')).toBe(false)
  })
})
