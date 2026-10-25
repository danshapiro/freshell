import { describe, expect, it } from 'vitest'
import {
  isUnifiedAgentMode,
  NameRevisionSchema,
  RenameSessionNameRequestSchema,
  sessionNameRefKey,
  SessionNameRecordSchema,
  SessionNameRefSchema,
  SessionNameUpdateSchema,
  TabNameSourceSchema,
} from '../../../shared/session-names.js'

describe('SessionNameRefSchema', () => {
  it('round-trips pending and session refs including colon-containing ids', () => {
    const pending = SessionNameRefSchema.parse({ kind: 'pending', id: 'nanoid:12:ab' })
    expect(pending).toEqual({ kind: 'pending', id: 'nanoid:12:ab' })
    const session = SessionNameRefSchema.parse({
      kind: 'session',
      provider: 'codex',
      sessionId: 'ses_1:2:3',
    })
    expect(session).toEqual({ kind: 'session', provider: 'codex', sessionId: 'ses_1:2:3' })
  })

  it('rejects unknown kinds and empty ids', () => {
    expect(SessionNameRefSchema.safeParse({ kind: 'terminal', id: 'x' }).success).toBe(false)
    expect(SessionNameRefSchema.safeParse({ kind: 'pending', id: '' }).success).toBe(false)
    expect(
      SessionNameRefSchema.safeParse({ kind: 'session', provider: 'kilroy', sessionId: 's' })
        .success,
    ).toBe(false)
  })
})

describe('sessionNameRefKey', () => {
  it('encodes a discriminated tuple, never a colon join', () => {
    expect(sessionNameRefKey({ kind: 'pending', id: 'h1' })).toBe('["pending","h1"]')
    expect(sessionNameRefKey({ kind: 'session', provider: 'claude', sessionId: 'a:b:c' })).toBe(
      '["session","claude","a:b:c"]',
    )
  })

  it('keeps colon-containing ids distinct across providers and kinds', () => {
    const claudeAbc = sessionNameRefKey({
      kind: 'session',
      provider: 'claude',
      sessionId: 'a:b:c',
    })
    const codexAbc = sessionNameRefKey({
      kind: 'session',
      provider: 'codex',
      sessionId: 'a:b:c',
    })
    const pendingAbc = sessionNameRefKey({ kind: 'pending', id: 'a:b:c' })
    expect(new Set([claudeAbc, codexAbc, pendingAbc]).size).toBe(3)
  })

  it('is stable across property insertion order', () => {
    const a = sessionNameRefKey({ kind: 'session', provider: 'opencode', sessionId: 's1' })
    const b = sessionNameRefKey({ sessionId: 's1', provider: 'opencode', kind: 'session' })
    expect(a).toBe(b)
  })
})

describe('isUnifiedAgentMode', () => {
  it('scopes exactly the three terminal CLI modes', () => {
    expect(isUnifiedAgentMode('claude')).toBe(true)
    expect(isUnifiedAgentMode('codex')).toBe(true)
    expect(isUnifiedAgentMode('opencode')).toBe(true)
    expect(isUnifiedAgentMode('shell')).toBe(false)
    expect(isUnifiedAgentMode('gemini')).toBe(false)
    expect(isUnifiedAgentMode('kimi')).toBe(false)
    expect(isUnifiedAgentMode('amplifier')).toBe(false)
    expect(isUnifiedAgentMode(undefined)).toBe(false)
  })

  it('scopes the three fresh session types, as sessionType or as mode', () => {
    expect(isUnifiedAgentMode(undefined, 'freshclaude')).toBe(true)
    expect(isUnifiedAgentMode(undefined, 'freshcodex')).toBe(true)
    expect(isUnifiedAgentMode(undefined, 'freshopencode')).toBe(true)
    expect(isUnifiedAgentMode('freshclaude')).toBe(true)
    expect(isUnifiedAgentMode('freshcodex')).toBe(true)
    expect(isUnifiedAgentMode('freshopencode')).toBe(true)
  })

  it('excludes kilroy even though it shares the Claude runtime', () => {
    expect(isUnifiedAgentMode(undefined, 'kilroy')).toBe(false)
    expect(isUnifiedAgentMode('claude', 'kilroy')).toBe(false)
    expect(isUnifiedAgentMode('kilroy')).toBe(false)
  })
})

describe('NameRevisionSchema', () => {
  it('accepts JS-safe integers and rejects out-of-range or fractional values', () => {
    expect(NameRevisionSchema.safeParse(0).success).toBe(true)
    expect(NameRevisionSchema.safeParse(1).success).toBe(true)
    expect(NameRevisionSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true)
    expect(NameRevisionSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false)
    expect(NameRevisionSchema.safeParse(-1).success).toBe(false)
    expect(NameRevisionSchema.safeParse(1.5).success).toBe(false)
  })
})

describe('SessionNameRecordSchema', () => {
  const baseRecord = {
    ref: { kind: 'session', provider: 'claude', sessionId: 'uuid-1' },
    name: 'Fix the login flow',
    source: 'manual',
    revision: 4,
  }

  it('round-trips a manual record with optional rename metadata', () => {
    const parsed = SessionNameRecordSchema.parse({
      ...baseRecord,
      manualRevision: 4,
      renamedAt: 1739491200000,
    })
    expect(parsed.source).toBe('manual')
    expect(parsed.manualRevision).toBe(4)
  })

  it('requires legacyOrigin for legacy_protected records', () => {
    expect(
      SessionNameRecordSchema.safeParse({ ...baseRecord, source: 'legacy_protected' }).success,
    ).toBe(false)
    expect(
      SessionNameRecordSchema.safeParse({
        ...baseRecord,
        source: 'legacy_protected',
        legacyOrigin: 'unknown',
      }).success,
    ).toBe(true)
  })

  it('rejects legacyOrigin on non-legacy sources and empty names', () => {
    expect(
      SessionNameRecordSchema.safeParse({ ...baseRecord, legacyOrigin: 'unknown' }).success,
    ).toBe(false)
    expect(SessionNameRecordSchema.safeParse({ ...baseRecord, name: '' }).success).toBe(false)
  })

  it('rejects revisions beyond the JS-safe integer ceiling', () => {
    expect(
      SessionNameRecordSchema.safeParse({ ...baseRecord, revision: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false)
  })

  it('rejects names the Rust store rejects: control characters, blank, oversize', () => {
    // Control characters anywhere mirror the store's `any(char::is_control)`.
    expect(
      SessionNameRecordSchema.safeParse({ ...baseRecord, name: 'bad\u0007name' }).success,
    ).toBe(false)
    expect(SessionNameRecordSchema.safeParse({ ...baseRecord, name: 'tab\tname' }).success).toBe(
      false,
    )
    expect(SessionNameRecordSchema.safeParse({ ...baseRecord, name: 'escape\u001b' }).success).toBe(
      false,
    )
    // Whitespace-only and >200 Unicode scalar values are rejected too.
    expect(SessionNameRecordSchema.safeParse({ ...baseRecord, name: '   ' }).success).toBe(false)
    expect(
      SessionNameRecordSchema.safeParse({ ...baseRecord, name: 'y'.repeat(201) }).success,
    ).toBe(false)
    // Exactly 200 scalars and non-control Unicode stay legal.
    expect(SessionNameRecordSchema.safeParse({ ...baseRecord, name: 'y'.repeat(200) }).success).toBe(
      true,
    )
    expect(
      SessionNameRecordSchema.safeParse({ ...baseRecord, name: 'Fix café shipping — now' })
        .success,
    ).toBe(true)
  })
})

describe('SessionNameUpdateSchema', () => {
  it('round-trips a full update payload with redirects', () => {
    const parsed = SessionNameUpdateSchema.parse({
      record: {
        ref: { kind: 'session', provider: 'opencode', sessionId: 'ses_9' },
        name: 'Ship the reorder panel',
        source: 'freshell_ai',
        revision: 7,
      },
      documentGeneration: 12,
      redirects: [
        {
          from: { kind: 'pending', id: 'freshopencode-req-1' },
          to: { kind: 'session', provider: 'opencode', sessionId: 'ses_9' },
          revision: 6,
        },
      ],
      changed: true,
    })
    expect(parsed.redirects[0].from.kind).toBe('pending')
    expect(parsed.record.source).toBe('freshell_ai')
  })

  it('keeps a rename outcome, and tolerates its absence or an unknown shape (name-reliability Task 4)', () => {
    const base = {
      record: { ref: { kind: 'session', provider: 'claude', sessionId: 's1' }, name: 'LotL', source: 'manual', revision: 3 },
      documentGeneration: 4,
      redirects: [],
      changed: false,
    }
    expect(SessionNameUpdateSchema.parse({ ...base, outcome: { applied: false, reason: 'protected_name' } }).outcome)
      .toEqual({ applied: false, reason: 'protected_name' })
    expect(SessionNameUpdateSchema.parse({ ...base, outcome: { applied: true, reason: 'unchanged' } }).outcome)
      .toEqual({ applied: true, reason: 'unchanged' })
    expect(SessionNameUpdateSchema.parse({ ...base, outcome: { applied: true } }).outcome).toEqual({ applied: true })
    expect(SessionNameUpdateSchema.parse(base).outcome).toBeUndefined()
    // A newer server's reason (or a malformed outcome) never rejects the update.
    const future = SessionNameUpdateSchema.safeParse({ ...base, outcome: { applied: false, reason: 'later_reason' } })
    expect(future.success).toBe(true)
    expect(future.success && future.data.outcome).toBeUndefined()
    expect(SessionNameUpdateSchema.safeParse({ ...base, outcome: 'nonsense' }).success).toBe(true)
  })

  it('requires the changed flag and a record', () => {
    const record = {
      ref: { kind: 'pending', id: 'h' },
      name: 'Draft plan',
      source: 'directory',
      revision: 1,
    }
    expect(SessionNameUpdateSchema.safeParse({ record, documentGeneration: 1 }).success).toBe(
      false,
    )
    expect(
      SessionNameUpdateSchema.safeParse({ record, documentGeneration: 1, redirects: [] }).success,
    ).toBe(false)
  })
})

describe('RenameSessionNameRequestSchema', () => {
  it('accepts a minimal request and an explicit-intent CAS request', () => {
    const minimal = RenameSessionNameRequestSchema.parse({
      target: { kind: 'session', provider: 'codex', sessionId: 'ses_2' },
      name: '  Trim me  ',
    })
    expect(minimal.nameIntent).toBeUndefined()
    expect(minimal.ifRevision).toBeUndefined()
    const cas = RenameSessionNameRequestSchema.parse({
      target: { kind: 'pending', id: 'h2' },
      name: 'New name',
      nameIntent: 'user',
      ifRevision: 3,
    })
    expect(cas.nameIntent).toBe('user')
  })

  it('rejects unknown intents and negative CAS revisions', () => {
    expect(
      RenameSessionNameRequestSchema.safeParse({
        target: { kind: 'pending', id: 'h' },
        name: 'x',
        nameIntent: 'agent',
      }).success,
    ).toBe(false)
    expect(
      RenameSessionNameRequestSchema.safeParse({
        target: { kind: 'pending', id: 'h' },
        name: 'x',
        ifRevision: -2,
      }).success,
    ).toBe(false)
  })

  it('rejects names the Rust store rejects, so a client-valid rename never 400s', () => {
    expect(
      RenameSessionNameRequestSchema.safeParse({
        target: { kind: 'pending', id: 'h' },
        name: 'bell\u0007name',
      }).success,
    ).toBe(false)
    expect(
      RenameSessionNameRequestSchema.safeParse({
        target: { kind: 'pending', id: 'h' },
        name: 'y'.repeat(201),
      }).success,
    ).toBe(false)
    expect(
      RenameSessionNameRequestSchema.safeParse({
        target: { kind: 'pending', id: 'h' },
        name: '   ',
      }).success,
    ).toBe(false)
    // Untrimmed input is legal: the server trims before storing.
    expect(
      RenameSessionNameRequestSchema.safeParse({
        target: { kind: 'pending', id: 'h' },
        name: '  Padded name  ',
      }).success,
    ).toBe(true)
  })
})

describe('TabNameSourceSchema', () => {
  it('round-trips session-owned and legacy sources and rejects others', () => {
    expect(TabNameSourceSchema.parse({ kind: 'session', paneId: 'pane-7' })).toEqual({
      kind: 'session',
      paneId: 'pane-7',
    })
    expect(TabNameSourceSchema.parse({ kind: 'legacy' })).toEqual({ kind: 'legacy' })
    expect(TabNameSourceSchema.safeParse({ kind: 'group' }).success).toBe(false)
    expect(TabNameSourceSchema.safeParse({ kind: 'session' }).success).toBe(false)
  })
})
