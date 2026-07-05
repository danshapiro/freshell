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
    turnCompleted: true, // secondary corroboration: reply persisted with the sentinel
    serverReportedIdle: true, // PRIMARY edge: the turn completed on session.idle/status{idle}
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
    { name: 'reply not persisted (secondary corroboration)', invariant: 'turn.completed', patch: { turnCompleted: false } },
    { name: 'provider never emits the idle edge', invariant: 'provider.emits-idle-signal', patch: { serverReportedIdle: false } },
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

  it('FAILS (fatal) when the provider never emits the idle edge — completion must be observed', () => {
    // INVERTED (was: "stays green when provider never emits idle"). The debugger
    // proved opencode DOES emit session.idle/session.status{idle} ~5s post-turn, so
    // the idle edge is now the PRIMARY completion signal: its absence is a hard fail.
    const report = assertT2Invariants(goodObservation({ serverReportedIdle: false }))
    expect(report.ok).toBe(false)
    const idle = report.results.find((r) => r.name === 'provider.emits-idle-signal')
    expect(idle!.ok).toBe(false)
    expect(idle!.fatal).toBe(true)
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

/**
 * A known-good CLAUDE/Haiku observation. Claude is SDK-driven (not PTY / not the
 * opencode idle poll), so its PRIMARY completion edge is the discrete
 * `freshAgent.turn.complete` wire event (emitted only on the Claude SDK result
 * subtype==='success'), captured here as `turnCompleteEventObserved`. Its
 * placeholder id is the SDK bridge's BARE nanoid (not `freshopencode-<id>`), its
 * durable id is the canonical Claude session UUID, and its transcript persists as
 * a `.jsonl` under the isolated CLAUDE_HOME (projected into the same db* fields).
 */
function goodClaudeObservation(overrides: Partial<T2Observation> = {}): T2Observation {
  return {
    provider: 'claude',
    model: 'haiku',
    prompt: 'Reply with exactly this token and nothing else: freshell-t2-ok',
    sentinelToken: 'freshell-t2-ok',

    sessionCreated: true,
    initialSessionId: 'V1StGXR8Z5jdHi6B_myT0', // bare nanoid (21 url-safe chars)
    durableSessionId: '11111111-1111-4111-8111-111111111111', // canonical Claude UUID
    sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },

    turnAccepted: true,
    turnCompleted: true, // secondary: assistant reply (sentinel) persisted to .jsonl
    serverReportedIdle: false, // N/A for claude — it uses the turn.complete edge, not the idle poll
    turnCompleteEventObserved: true, // PRIMARY edge: freshAgent.turn.complete (subtype=success)
    assistantReplyLatencyMs: 4200,
    sendStatus: null,
    submittedTurnId: 'turn_1',

    captureText: 'freshell-t2-ok\n',
    captureLength: 15,
    captureNonEmpty: true,
    captureContainsSentinel: true,

    dbPath: '/tmp/freshell-e2e-x/.claude/projects/-tmp-work/11111111-1111-4111-8111-111111111111.jsonl',
    dbSessionRowPresent: true,
    dbSessionRow: { id: '11111111-1111-4111-8111-111111111111', title: null, directory: '/tmp/work' },
    dbMessageCount: 3, // system(init) + user + assistant transcript lines
    dbPartCount: 1, // one assistant text block
    dbHasAssistantMessage: true,
    transcriptParseable: true,

    // Claude does NOT emit freshAgent.session.materialized on send (adapter.send is
    // void; the durable UUID surfaces via session.init cliSessionId + the .jsonl name),
    // so the materialized event is legitimately absent (non-fatal invariant).
    wsServerMessageTypes: ['ready', 'settings.updated', 'terminal.inventory', 'freshAgent.created', 'freshAgent.event'],
    sessionMaterializedEvent: null,

    ownedCleanupOk: true,
    strayOwnedPidsAfter: [],
    liveModelCalls: 1,

    timings: { createMs: 60, turnMs: 4200, totalMs: 6000 },
    ...overrides,
  }
}

describe('assertT2Invariants — claude/Haiku (SDK completion edge)', () => {
  it('passes a known-good claude/Haiku observation (turn.complete edge)', () => {
    const report = assertT2Invariants(goodClaudeObservation())
    expect(report.ok, report.summary + '\n' + JSON.stringify(report.results, null, 2)).toBe(true)
    expect(report.failed).toBe(0)
    expect(report.provider).toBe('claude')
  })

  it('grades claude on provider.emits-completion-signal, NOT the opencode idle edge', () => {
    const report = assertT2Invariants(goodClaudeObservation())
    const completion = report.results.find((r) => r.name === 'provider.emits-completion-signal')
    expect(completion, 'claude must be graded on the discrete turn.complete edge').toBeTruthy()
    expect(completion!.fatal).toBe(true)
    expect(completion!.ok).toBe(true)
    // The opencode-only idle invariant must NOT appear for claude.
    expect(report.results.find((r) => r.name === 'provider.emits-idle-signal')).toBeUndefined()
  })

  it('FAILS (fatal) when the discrete turn.complete edge is never observed', () => {
    const report = assertT2Invariants(goodClaudeObservation({ turnCompleteEventObserved: false }))
    expect(report.ok).toBe(false)
    const completion = report.results.find((r) => r.name === 'provider.emits-completion-signal')
    expect(completion!.ok).toBe(false)
    expect(completion!.fatal).toBe(true)
    expect(completion!.detail).toMatch(/turnCompleteEventObserved=false/)
  })

  it('FAILS (fatal) when turnCompleteEventObserved is missing (undefined ≠ observed)', () => {
    const obs = goodClaudeObservation()
    delete (obs as { turnCompleteEventObserved?: boolean }).turnCompleteEventObserved
    const report = assertT2Invariants(obs)
    expect(report.ok).toBe(false)
    expect(report.results.find((r) => r.name === 'provider.emits-completion-signal')!.ok).toBe(false)
  })

  // The claude placeholder is the SDK bridge's bare nanoid — NOT `freshclaude-...`.
  const claudeShapeMutations: Array<{ name: string; invariant: string; patch: Partial<T2Observation> }> = [
    { name: 'placeholder too short (not a nanoid)', invariant: 'session.created', patch: { initialSessionId: 'x' } },
    { name: 'placeholder is a UUID (36 chars, must be the durable field)', invariant: 'session.created', patch: { initialSessionId: '11111111-1111-4111-8111-111111111111' } },
    { name: 'durable id not a UUID', invariant: 'session.durable-id-shape', patch: { durableSessionId: 'not-a-uuid' } },
    { name: 'turn not accepted', invariant: 'turn.accepted', patch: { turnAccepted: false } },
    { name: 'reply not persisted', invariant: 'turn.completed', patch: { turnCompleted: false } },
    { name: 'sentinel missing from reply', invariant: 'assistant.replied-sentinel', patch: { captureContainsSentinel: false } },
    { name: 'transcript .jsonl absent', invariant: 'transcript.persisted', patch: { dbSessionRowPresent: false } },
    { name: 'transcript not parseable', invariant: 'transcript.parseable', patch: { transcriptParseable: false } },
    { name: 'stray owned pid left behind', invariant: 'ownership.cleanup', patch: { ownedCleanupOk: false, strayOwnedPidsAfter: [4242] } },
  ]

  for (const m of claudeShapeMutations) {
    it(`flips "${m.invariant}" when: ${m.name}`, () => {
      const report = assertT2Invariants(goodClaudeObservation(m.patch))
      const inv = report.results.find((r) => r.name === m.invariant)
      expect(inv, `invariant ${m.invariant} should exist`).toBeTruthy()
      expect(inv!.ok, `invariant ${m.invariant} should be false for "${m.name}"`).toBe(false)
      expect(report.ok, `expected overall FAIL for mutation "${m.name}"`).toBe(false)
    })
  }

  it('accepts the real bare-nanoid placeholder shape and rejects the old aspirational prefix-only id', () => {
    // A bare nanoid passes; a value that is ONLY the retired `freshclaude-` prefix
    // with an out-of-range body would not — we assert the real shape is honored.
    expect(PROVIDER_ID_SHAPES.claude.placeholder.test('V1StGXR8Z5jdHi6B_myT0')).toBe(true)
    expect(PROVIDER_ID_SHAPES.claude.placeholder.test('11111111-1111-4111-8111-111111111111')).toBe(false)
    expect(PROVIDER_ID_SHAPES.claude.durable.test('11111111-1111-4111-8111-111111111111')).toBe(true)
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
