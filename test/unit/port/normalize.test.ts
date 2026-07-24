import { describe, it, expect } from 'vitest'
import {
  normalizeTranscript,
  canonicalizeTranscript,
  diffNormalized,
  FIELD_FAMILIES,
  type TranscriptMessage,
} from '../../../port/oracle/harness/normalize.js'

/**
 * Unit spec for the equivalence oracle's transcript normalization layer.
 *
 * Pure + fast (no server): runs under config/vitest/vitest.port.config.ts, which
 * globs test/unit/port/** but EXCLUDES test/unit/port/oracle/** (the live,
 * server-booting rung). These fixtures are hand-built so every assertion is a
 * property of the normalizer, not of any particular server boot.
 *
 * The properties proven here are the oracle's load-bearing guarantees:
 *   (a) run-specific noise (ids/timestamps/ports/seqs/paths) canonicalizes away
 *       so two structurally-identical transcripts become DEEP-EQUAL;
 *   (b) a REAL structural difference SURVIVES normalization (no over-masking);
 *   (c) normalization is idempotent;
 *   (d) cross-references are preserved (same value -> same placeholder);
 *   (e) deterministic contract fields pass through UNCHANGED;
 *   (f) a mis-shaped id is surfaced as a shape violation, not silently masked;
 *   (g) opaque blobs are masked, never compared by value.
 */

// ── fixture helpers ─────────────────────────────────────────────────────────

function inbound(parsed: Record<string, unknown>): TranscriptMessage {
  return { dir: 'in', type: typeof parsed.type === 'string' ? parsed.type : undefined, parsed }
}
function outbound(parsed: Record<string, unknown>): TranscriptMessage {
  return { dir: 'out', type: typeof parsed.type === 'string' ? parsed.type : undefined, parsed }
}

/**
 * Two structurally-identical handshake-ish transcripts that differ ONLY in the
 * run-specific values every family covers: an opaque auth token, an ISO
 * timestamp, per-boot server ids, nanoid terminal/stream ids, an epoch
 * timestamp, PTY seq numbers, opaque byte payload, and a host path.
 */
function handshakeLike(v: {
  token: string
  ts: string
  serverInstanceId: string
  bootId: string
  terminalId: string
  streamId: string
  createdAt: number
  cwd: string
  seqStart: number
  seqEnd: number
  data: string
}): TranscriptMessage[] {
  return [
    outbound({ type: 'hello', token: v.token, protocolVersion: 7 }),
    inbound({ type: 'ready', timestamp: v.ts, serverInstanceId: v.serverInstanceId, bootId: v.bootId }),
    inbound({ type: 'perf.logging', enabled: true }),
    inbound({
      type: 'terminal.created',
      terminalId: v.terminalId,
      streamId: v.streamId,
      createdAt: v.createdAt,
      cwd: v.cwd,
      status: 'running',
    }),
    inbound({
      type: 'terminal.output',
      terminalId: v.terminalId,
      streamId: v.streamId,
      seqStart: v.seqStart,
      seqEnd: v.seqEnd,
      data: v.data,
    }),
    inbound({ type: 'terminal.inventory', bootId: v.bootId, terminals: [], terminalMeta: [] }),
  ]
}

const RUN_A = handshakeLike({
  token: '11111111-1111-1111-1111-111111111111',
  ts: '2026-07-04T01:00:00.000Z',
  serverInstanceId: 'srv_AAAAAAAA',
  bootId: 'boot_AAAAAAAA',
  terminalId: 'term_AAAAAAAAAAAAAAAAAAAA',
  streamId: 'strm_AAAAAAAAAAAAAAAAAAAA',
  createdAt: 1_700_000_000_000,
  cwd: '/tmp/freshell-e2e-AAAAAA/work',
  seqStart: 100,
  seqEnd: 128,
  data: 'AAAA bytes from run A',
})

const RUN_B = handshakeLike({
  token: '22222222-2222-2222-2222-222222222222',
  ts: '2026-07-04T09:33:17.482Z',
  serverInstanceId: 'srv_BBBBBBBB',
  bootId: 'boot_BBBBBBBB',
  terminalId: 'term_BBBBBBBBBBBBBBBBBBBB',
  streamId: 'strm_BBBBBBBBBBBBBBBBBBBB',
  createdAt: 1_811_111_111_111,
  cwd: '/tmp/freshell-e2e-ZZZZZZ/work',
  seqStart: 5,
  seqEnd: 33,
  data: 'totally different bytes from run B',
})

// ── (a) equivalence after normalization ─────────────────────────────────────

describe('normalize (a) — run-specific noise canonicalizes to deep-equal', () => {
  it('two transcripts differing only in ids/timestamps/ports/seqs/paths become deep-equal', () => {
    const a = normalizeTranscript(RUN_A)
    const b = normalizeTranscript(RUN_B)
    expect(a.normalized).toEqual(b.normalized)
    expect(canonicalizeTranscript(a.normalized)).toBe(canonicalizeTranscript(b.normalized))
    expect(diffNormalized(a.normalized, b.normalized).equal).toBe(true)
  })

  it('ports normalize away too (different serverPort -> equal)', () => {
    const a = normalizeTranscript([inbound({ type: 'extension.server.ready', port: 51000 })])
    const b = normalizeTranscript([inbound({ type: 'extension.server.ready', port: 62999 })])
    expect(a.normalized).toEqual(b.normalized)
    expect((a.normalized[0].parsed as Record<string, unknown>).port).toBe('<PORT:1>')
  })

  it('placeholders are assigned in stable first-seen order, scoped per family', () => {
    const { normalized } = normalizeTranscript(RUN_A)
    const ready = normalized[1].parsed as Record<string, unknown>
    expect(ready.timestamp).toBe('<TS:1>')
    expect(ready.serverInstanceId).toBe('<SRV:1>')
    expect(ready.bootId).toBe('<BOOT:1>')
    const created = normalized[3].parsed as Record<string, unknown>
    expect(created.terminalId).toBe('<TID:1>')
    expect(created.streamId).toBe('<STREAM:1>')
    expect(created.createdAt).toBe('<TS:2>') // second distinct timestamp value
    expect(created.cwd).toBe('<PATH:1>')
    const output = normalized[4].parsed as Record<string, unknown>
    expect(output.seqStart).toBe('<SEQ:1>')
    expect(output.seqEnd).toBe('<SEQ:2>')
  })
})

// ── (b) real structural differences survive normalization ───────────────────

describe('normalize (b) — genuine divergence is NOT masked away', () => {
  it('a changed boolean survives', () => {
    const a = normalizeTranscript([inbound({ type: 'perf.logging', enabled: true })])
    const b = normalizeTranscript([inbound({ type: 'perf.logging', enabled: false })])
    const diff = diffNormalized(a.normalized, b.normalized)
    expect(diff.equal).toBe(false)
    expect(diff.differences.some((d) => d.path.includes('enabled'))).toBe(true)
  })

  it('a changed enum value survives', () => {
    const a = normalizeTranscript([inbound({ type: 'terminal.created', terminalId: 't_aaaaaaaaaa', status: 'running' })])
    const b = normalizeTranscript([inbound({ type: 'terminal.created', terminalId: 't_bbbbbbbbbb', status: 'exited' })])
    const diff = diffNormalized(a.normalized, b.normalized)
    expect(diff.equal).toBe(false)
    expect(diff.differences.some((d) => d.path.includes('status'))).toBe(true)
  })

  it('a changed `type` discriminant survives', () => {
    const a = normalizeTranscript([inbound({ type: 'ready', timestamp: '2026-07-04T01:00:00.000Z' })])
    const b = normalizeTranscript([inbound({ type: 'readyish', timestamp: '2026-07-04T09:00:00.000Z' })])
    const diff = diffNormalized(a.normalized, b.normalized)
    expect(diff.equal).toBe(false)
    expect(diff.differences.some((d) => d.kind === 'type' || d.path.includes('type'))).toBe(true)
  })

  it('an extra message survives (length divergence)', () => {
    const base = normalizeTranscript(RUN_A)
    const extra = normalizeTranscript([...RUN_A, inbound({ type: 'pong', timestamp: '2026-07-04T02:00:00.000Z' })])
    const diff = diffNormalized(base.normalized, extra.normalized)
    expect(diff.equal).toBe(false)
    expect(diff.differences.some((d) => d.kind === 'added' || d.kind === 'length')).toBe(true)
  })

  it('a dropped required field survives', () => {
    const a = normalizeTranscript([inbound({ type: 'config.fallback', backupExists: true, reason: 'ENOENT' })])
    const b = normalizeTranscript([inbound({ type: 'config.fallback', backupExists: true })])
    const diff = diffNormalized(a.normalized, b.normalized)
    expect(diff.equal).toBe(false)
    expect(diff.differences.some((d) => d.path.includes('reason'))).toBe(true)
  })
})

// ── (c) idempotence ─────────────────────────────────────────────────────────

describe('normalize (c) — idempotent', () => {
  it('normalizing an already-normalized transcript yields identical output', () => {
    const first = normalizeTranscript(RUN_A)
    const second = normalizeTranscript(first.normalized)
    expect(second.normalized).toEqual(first.normalized)
    expect(canonicalizeTranscript(second.normalized)).toBe(canonicalizeTranscript(first.normalized))
  })

  it('a third pass is still identical (fixed point)', () => {
    const first = normalizeTranscript(RUN_A)
    const second = normalizeTranscript(first.normalized)
    const third = normalizeTranscript(second.normalized)
    expect(canonicalizeTranscript(third.normalized)).toBe(canonicalizeTranscript(first.normalized))
  })
})

// ── (d) cross-reference preservation ────────────────────────────────────────

describe('normalize (d) — cross-references preserved', () => {
  it('one value in two different fields collapses to ONE placeholder (structural link kept)', () => {
    const { normalized } = normalizeTranscript([
      inbound({ type: 'terminal.created', terminalId: 'term_shared_00000001' }),
      inbound({ type: 'terminals.changed', recoverableTerminalIds: ['term_shared_00000001'], revision: 3 }),
      inbound({ type: 'terminal.output', terminalId: 'term_shared_00000001', streamId: 'strm_00000001', seqStart: 1, seqEnd: 2, data: 'x' }),
    ])
    const created = normalized[0].parsed as Record<string, unknown>
    const changed = normalized[1].parsed as Record<string, unknown>
    const output = normalized[2].parsed as Record<string, unknown>
    expect(created.terminalId).toBe('<TID:1>')
    expect((changed.recoverableTerminalIds as string[])[0]).toBe('<TID:1>')
    expect(output.terminalId).toBe('<TID:1>')
  })

  it('two different values get two distinct placeholders', () => {
    const { normalized } = normalizeTranscript([
      inbound({ type: 'terminal.created', terminalId: 'term_first_000000001' }),
      inbound({ type: 'terminal.created', terminalId: 'term_second_00000001' }),
    ])
    expect((normalized[0].parsed as Record<string, unknown>).terminalId).toBe('<TID:1>')
    expect((normalized[1].parsed as Record<string, unknown>).terminalId).toBe('<TID:2>')
  })

  it('cross-reference survives across BOTH directions (client echo of a server id)', () => {
    const { normalized } = normalizeTranscript([
      inbound({ type: 'terminal.attach.ready', terminalId: 'term_xref_000000001', streamId: 'strm_xref_00000001', attachRequestId: 'req_xref_0000001' }),
      outbound({ type: 'terminal.input', terminalId: 'term_xref_000000001', data: 'ls\n' }),
    ])
    const server = normalized[0].parsed as Record<string, unknown>
    const client = normalized[1].parsed as Record<string, unknown>
    expect(server.terminalId).toBe('<TID:1>')
    expect(client.terminalId).toBe('<TID:1>')
  })
})

// ── (e) deterministic fields pass through unchanged ─────────────────────────

describe('normalize (e) — deterministic contract fields are untouched', () => {
  it('type / protocolVersion / enum / boolean / fixed literal survive verbatim', () => {
    const original = {
      type: 'test.deterministic',
      protocolVersion: 7,
      code: 'RESTORE_UNAVAILABLE',
      reason: 'invalid_legacy_restore_target',
      status: 'running',
      ok: true,
      accepted: false,
      mimeType: 'image/png',
      enabled: true,
    }
    const { normalized } = normalizeTranscript([inbound({ ...original })])
    expect(normalized[0].parsed).toEqual(original)
  })

  it('an ErrorCode enum and code literal are not treated as ids', () => {
    const { normalized } = normalizeTranscript([
      inbound({ type: 'error', requestId: 'req_aaaaaaaaaa', timestamp: '2026-07-04T01:00:00.000Z', code: 'BAD_REQUEST', message: 'nope' }),
    ])
    const err = normalized[0].parsed as Record<string, unknown>
    expect(err.code).toBe('BAD_REQUEST') // untouched
    expect(err.requestId).toBe('<RID:1>') // normalized
    expect(err.timestamp).toBe('<TS:1>') // normalized
  })
})

// ── (f) mis-shaped ids surface as shape violations ──────────────────────────

describe('normalize (f) — shape violations are surfaced, not silently masked', () => {
  it('a Claude sessionId that is not a UUID is flagged', () => {
    const { report } = normalizeTranscript([
      inbound({
        type: 'terminal.inventory',
        bootId: 'boot_aaaaaaaa',
        terminals: [{ terminalId: 't_aaaaaaaaaa', sessionRef: { provider: 'claude', sessionId: 'not-a-real-uuid' } }],
        terminalMeta: [],
      }),
    ])
    const hit = report.shapeViolations.find((v) => v.field === 'sessionId')
    expect(hit, 'a claude sessionId violation must be reported').toBeTruthy()
    expect(hit!.value).toBe('not-a-real-uuid')
  })

  it('a well-formed Claude sessionId produces NO violation', () => {
    const { report } = normalizeTranscript([
      inbound({
        type: 'terminal.inventory',
        bootId: 'boot_aaaaaaaa',
        terminals: [{ terminalId: 't_aaaaaaaaaa', sessionRef: { provider: 'claude', sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } }],
        terminalMeta: [],
      }),
    ])
    expect(report.shapeViolations.filter((v) => v.field === 'sessionId')).toEqual([])
  })

  it('a garbage nanoid terminal id (with spaces) is flagged', () => {
    const { report } = normalizeTranscript([inbound({ type: 'terminal.created', terminalId: 'has spaces!!' })])
    expect(report.shapeViolations.some((v) => v.field === 'terminalId')).toBe(true)
  })

  it('an opencode sessionId that lacks the ses_ prefix is flagged', () => {
    const { report } = normalizeTranscript([
      inbound({ type: 'terminal.inventory', bootId: 'b_aaaaaaaa', terminals: [{ terminalId: 't_aaaaaaaaaa', sessionRef: { provider: 'opencode', sessionId: 'nope-no-prefix' } }], terminalMeta: [] }),
    ])
    expect(report.shapeViolations.some((v) => v.field === 'sessionId')).toBe(true)
  })
})

// ── (g) opaque blobs masked, never value-compared ───────────────────────────

describe('normalize (g) — opaque blobs masked to a family tag', () => {
  it('data / event / imageBase64 are masked to their family tags', () => {
    const { normalized, report } = normalizeTranscript([
      inbound({ type: 'terminal.output', terminalId: 't_aaaaaaaaaa', streamId: 's_aaaaaaaaaa', seqStart: 1, seqEnd: 2, data: 'raw pty bytes' }),
      inbound({ type: 'codingcli.event', sessionId: 'ses_aaaaaaaa', event: { kind: 'delta', text: 'hello', nested: { a: 1 } } }),
      inbound({ type: 'ui.screenshot.result', requestId: 'req_aaaaaaaa', imageBase64: 'iVBORw0KGgoAAAANS', mimeType: 'image/png' }),
    ])
    expect((normalized[0].parsed as Record<string, unknown>).data).toBe('<OPAQUE:data>')
    expect((normalized[1].parsed as Record<string, unknown>).event).toBe('<OPAQUE:event>')
    expect((normalized[2].parsed as Record<string, unknown>).imageBase64).toBe('<OPAQUE:imageBase64>')
    // mimeType is a fixed literal, NOT opaque
    expect((normalized[2].parsed as Record<string, unknown>).mimeType).toBe('image/png')
    // presence recorded (so it is auditable), value never surfaced for equality
    expect(report.opaque.some((o) => o.field === 'data')).toBe(true)
    expect(report.opaque.some((o) => o.field === 'event')).toBe(true)
  })

  it('two transcripts with DIFFERENT opaque payloads normalize equal (never compared by value)', () => {
    // Everything relational is held identical (same id/seq structure); ONLY the
    // opaque `data` differs — proving opaque bytes are never compared by value.
    const a = normalizeTranscript([inbound({ type: 'terminal.output', terminalId: 't_aaaaaaaaaa', streamId: 's_aaaaaaaaa', seqStart: 1, seqEnd: 2, data: 'AAAAAAAA' })])
    const b = normalizeTranscript([inbound({ type: 'terminal.output', terminalId: 't_bbbbbbbbbb', streamId: 's_bbbbbbbbb', seqStart: 100, seqEnd: 200, data: 'ZZZZ totally different ZZZZ' })])
    expect(diffNormalized(a.normalized, b.normalized).equal).toBe(true)
  })
})

// ── seq monotonicity report (absolute values erased, ordering asserted) ─────

describe('normalize — per-stream seq monotonicity is reported (not compared by value)', () => {
  it('a monotonic seq stream normalizes to ordinals with NO monotonicity violation', () => {
    const { normalized, report } = normalizeTranscript([
      inbound({ type: 'terminal.output', terminalId: 't_stream_a0000001', streamId: 's_stream_a0000001', seqStart: 400, seqEnd: 431, data: 'x' }),
      inbound({ type: 'terminal.output', terminalId: 't_stream_a0000001', streamId: 's_stream_a0000001', seqStart: 432, seqEnd: 470, data: 'y' }),
    ])
    // Absolute seq values are gone; only stable ordinals remain.
    expect((normalized[0].parsed as Record<string, unknown>).seqStart).toBe('<SEQ:1>')
    expect(report.monotonicityViolations).toEqual([])
  })

  it('a seq that goes BACKWARDS within a stream is flagged as a monotonicity violation', () => {
    const { report } = normalizeTranscript([
      inbound({ type: 'terminal.output', terminalId: 't_stream_b0000001', streamId: 's_stream_b0000001', seqStart: 900, seqEnd: 901, data: 'x' }),
      inbound({ type: 'terminal.output', terminalId: 't_stream_b0000001', streamId: 's_stream_b0000001', seqStart: 100, seqEnd: 101, data: 'y' }), // regressed!
    ])
    const hit = report.monotonicityViolations.find((v) => v.field === 'seqStart')
    expect(hit, 'a backwards seqStart within a stream must be reported').toBeTruthy()
    expect(hit!.values).toEqual([900, 100])
  })
})

// ── registry sanity ─────────────────────────────────────────────────────────

describe('FIELD_FAMILIES registry', () => {
  it('classifies representative fields into the six families', () => {
    expect(FIELD_FAMILIES.terminalId?.family).toBe('id')
    expect(FIELD_FAMILIES.timestamp?.family).toBe('timestamp')
    expect(FIELD_FAMILIES.seqStart?.family).toBe('seq')
    expect(FIELD_FAMILIES.port?.family).toBe('port')
    expect(FIELD_FAMILIES.cwd?.family).toBe('path')
    expect(FIELD_FAMILIES.data?.family).toBe('opaque')
  })

  it('does NOT classify deterministic discriminants', () => {
    expect(FIELD_FAMILIES.type).toBeUndefined()
    expect(FIELD_FAMILIES.protocolVersion).toBeUndefined()
    expect(FIELD_FAMILIES.code).toBeUndefined()
    expect(FIELD_FAMILIES.mimeType).toBeUndefined()
    expect(FIELD_FAMILIES.ok).toBeUndefined()
  })
})
