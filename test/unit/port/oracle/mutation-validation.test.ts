import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContractValidator } from '../../../../port/oracle/harness/contract-validator.js'
import {
  diffNormalized,
  normalizeTranscript,
  type NormalizedMessage,
  type TranscriptMessage,
} from '../../../../port/oracle/harness/normalize.js'
import { assertT2Invariants, type T2Observation } from '../../../../port/oracle/harness/invariants.js'
import { WS_PROTOCOL_VERSION } from '../../../../shared/ws-version.js'
import {
  clone,
  dropMessageAt,
  dropPath,
  editParsedAt,
  flipByteAt,
  insertByteAt,
  rerandomizeNondeterministic,
  setPath,
  swapMessagesAt,
  truncateBy,
  withContractVersion,
} from '../../../../port/oracle/mutation/mutators.js'

/**
 * MUTATION-VALIDATION SUITE (data-level) — the oracle's capstone self-check.
 *
 * An equivalence oracle that cannot catch a planted bug is worthless. This suite
 * PROVES each oracle component actually DETECTS the class of divergence it is
 * responsible for, by taking known-good data (a real captured handshake
 * transcript, the committed T1 PTY goldens, a known-good T2 observation) and
 * injecting controlled mutations — then asserting the RIGHT component flags each.
 *
 * It ALSO proves the inverse (no false positives): changing only a
 * nondeterministic value (id/timestamp/port/token) must NOT produce a diff, and
 * byte-identical / structurally-identical inputs must pass.
 *
 * Deterministic and SERVER-FREE: every input is a committed fixture/golden/
 * baseline, so this runs as a fast unit test (no boot, no network, no live call).
 *
 * GOVERNANCE: every mutation in the taxonomy MUST be caught. A mutation that
 * slips through is an ORACLE GAP — this suite FAILS and names it. We never weaken
 * an assertion to make it pass. Known, documented schema-looseness is surfaced
 * separately as an explicit characterization (see the "documented limitations"
 * block) so the gap is visible rather than hidden.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const CONTRACT_DIR = path.join(REPO_ROOT, 'port', 'contract')
const FIXTURE_PATH = path.join(REPO_ROOT, 'port', 'oracle', 'fixtures', 'handshake-transcript.json')
const PTY_BASELINE_DIR = path.join(REPO_ROOT, 'port', 'oracle', 'baselines', 'pty')

// ── known-good inputs ────────────────────────────────────────────────────────

interface FixtureFile {
  transcript: Array<{ dir: 'in' | 'out'; type?: string; raw: string; parsed: unknown }>
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile
/** Full ordered handshake transcript (both directions) as normalize/diff consumes it. */
const baseTranscript: TranscriptMessage[] = fixture.transcript.map((m) => ({
  dir: m.dir,
  type: m.type,
  parsed: m.parsed,
}))
/** Just the server→client messages' parsed payloads (what the contract-validator grades). */
const serverParsed: unknown[] = fixture.transcript.filter((m) => m.dir === 'in').map((m) => m.parsed)

function idxOfType(type: string): number {
  const i = baseTranscript.findIndex((m) => m.dir === 'in' && m.type === type)
  if (i < 0) throw new Error(`fixture is missing a server→client "${type}" message`)
  return i
}
const READY_I = idxOfType('ready')
const SETTINGS_I = idxOfType('settings.updated')
const PERF_I = idxOfType('perf.logging')
const INVENTORY_I = idxOfType('terminal.inventory')

/** A committed T1 golden + its meta sidecar (the byte-stream baseline). */
const GOLDEN_NAME = 'echo-hello'
const goldenBytes: Buffer = readFileSync(path.join(PTY_BASELINE_DIR, `${GOLDEN_NAME}.golden`))
const goldenMeta = JSON.parse(
  readFileSync(path.join(PTY_BASELINE_DIR, `${GOLDEN_NAME}.meta.json`), 'utf8'),
) as { sha256: string; byteLength: number }

/** A known-good T2 observation (a green opencode/Kimi run), mirroring the T2 baseline. */
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
    serverReportedIdle: true,
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

// ── valid exemplars for enum-bearing server→client types NOT in the handshake ─
// Guarded (asserted valid before mutating) in the "sanity" test, so an authoring
// mistake surfaces as a loud failure rather than a false green.
function validErrorMessage(): Record<string, unknown> {
  return { type: 'error', code: 'INTERNAL_ERROR', message: 'boom', timestamp: '2026-07-05T04:20:52.546Z' }
}
function validTerminalOutput(): Record<string, unknown> {
  return {
    type: 'terminal.output',
    data: 'hello\r\n',
    seqStart: 1,
    seqEnd: 7,
    streamId: 'stream-1',
    terminalId: 'term-1',
    source: 'live',
  }
}
function validTurnComplete(): Record<string, unknown> {
  return { type: 'terminal.turn.complete', at: 1, completionSeq: 3, provider: 'opencode', terminalId: 'term-1' }
}

// ── oracle detection helpers (the components under test) ─────────────────────

const validator = new ContractValidator(CONTRACT_DIR)

/** T0: did the contract-validator reject this server→client message? */
function contractFlagged(msg: unknown): { flagged: boolean; detail: string } {
  const r = validator.validateServerMessage(msg)
  const flagged = !(r.known && r.valid)
  const reason = !r.known ? `unknown-type(${r.type ?? 'none'})` : r.valid ? 'valid' : 'schema-violation'
  return { flagged, detail: `known=${r.known} valid=${r.valid} → ${reason}; errors=${JSON.stringify(r.errors)}` }
}

const baseNorm: NormalizedMessage[] = normalizeTranscript(baseTranscript).normalized

/** Normalization/diff: did diffNormalized report a divergence vs the base transcript? */
function normDiffFlagged(mutated: TranscriptMessage[]): { flagged: boolean; detail: string } {
  const diff = diffNormalized(baseNorm, normalizeTranscript(mutated).normalized)
  return {
    flagged: !diff.equal,
    detail: diff.equal ? 'no diff' : `${diff.differences.length} diff(s): ${JSON.stringify(diff.differences.slice(0, 4))}`,
  }
}

/** T1: did the byte-stream golden compare reject these bytes? */
function bytesFlagged(candidate: Buffer): { flagged: boolean; detail: string } {
  const flagged = !goldenBytes.equals(candidate)
  return { flagged, detail: `committed=${goldenBytes.length}B candidate=${candidate.length}B equal=${!flagged}` }
}

/** T2: did assertT2Invariants fail (fatal), and did the NAMED invariant flip? */
function t2Flagged(obs: T2Observation, invariant: string): { flagged: boolean; detail: string } {
  const report = assertT2Invariants(obs)
  const inv = report.results.find((r) => r.name === invariant)
  const named = !!inv && inv.fatal && !inv.ok
  const flagged = !report.ok && named
  return {
    flagged,
    detail: `report.ok=${report.ok}; ${invariant}: ${inv ? `ok=${inv.ok} fatal=${inv.fatal}` : 'MISSING'}; ` +
      `summary="${report.summary}"`,
  }
}

// ── the mutation taxonomy ────────────────────────────────────────────────────

type Expect = 'flag' | 'pass'
interface Case {
  klass: string
  id: string
  description: string
  detectedBy: string
  expect: Expect
  run: () => { flagged: boolean; detail: string }
}

// version-mutation temp dirs (written in beforeAll, read by the case closures)
let versionMismatchDir = ''
let versionDriftDir = ''

// Fresh clones of specific captured server→client messages (mutators are immutable,
// but returning a clone keeps every case fully independent).
const READY_SERVER_INDEX = serverParsed.findIndex(
  (m) => !!m && typeof m === 'object' && (m as { type?: unknown }).type === 'ready',
)
const PERF_SERVER_INDEX = serverParsed.findIndex(
  (m) => !!m && typeof m === 'object' && (m as { type?: unknown }).type === 'perf.logging',
)
function readyServer(): Record<string, unknown> {
  return clone(serverParsed[READY_SERVER_INDEX]) as Record<string, unknown>
}
function perfServer(): Record<string, unknown> {
  return clone(serverParsed[PERF_SERVER_INDEX]) as Record<string, unknown>
}

const CASES: Case[] = [
  // ── T0 / contract ──────────────────────────────────────────────────────────
  {
    klass: 'T0/contract',
    id: 'drop-required-field',
    description: 'drop required `timestamp` from `ready`',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(dropPath(readyServer(), ['timestamp'])),
  },
  {
    klass: 'T0/contract',
    id: 'unknown-type-discriminant',
    description: 'change `ready` → unknown `type` (no frozen schema)',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(readyServer(), ['type'], 'ready.NOT_A_REAL_TYPE')),
  },
  {
    klass: 'T0/contract',
    id: 'wrong-scalar-type',
    description: '`ready.timestamp` string → number (wrong scalar type)',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(readyServer(), ['timestamp'], 1234567890)),
  },
  {
    klass: 'T0/contract',
    id: 'additional-property',
    description: 'add an un-modeled property (`additionalProperties:false`)',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(readyServer(), ['smuggled'], 'nope')),
  },
  {
    klass: 'T0/contract',
    id: 'wrong-boolean-scalar',
    description: '`perf.logging.enabled` boolean → string',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(perfServer(), ['enabled'], 'false')),
  },
  {
    klass: 'T0/contract',
    id: 'flip-enum-error-code',
    description: 'flip `error.code` enum to an invalid value',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(validErrorMessage(), ['code'], 'NOT_A_REAL_CODE')),
  },
  {
    klass: 'T0/contract',
    id: 'flip-enum-output-source',
    description: 'flip `terminal.output.source` enum (live|replay) to invalid',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(validTerminalOutput(), ['source'], 'teleport')),
  },
  {
    klass: 'T0/contract',
    id: 'flip-enum-turn-provider',
    description: 'flip `terminal.turn.complete.provider` enum to invalid',
    detectedBy: 'contract-validator',
    expect: 'flag',
    run: () => contractFlagged(setPath(validTurnComplete(), ['provider'], 'gemini')),
  },
  {
    klass: 'T0/contract',
    id: 'wsProtocolVersion-mismatch',
    description: 'contract files disagree on wsProtocolVersion → validator refuses to load',
    detectedBy: 'contract-validator(ctor)',
    expect: 'flag',
    run: () => {
      try {
        // eslint-disable-next-line no-new
        new ContractValidator(versionMismatchDir)
        return { flagged: false, detail: 'constructor did NOT throw on a version-mismatched contract' }
      } catch (err) {
        return { flagged: true, detail: `constructor threw: ${(err as Error).message}` }
      }
    },
  },
  {
    klass: 'T0/contract',
    id: 'wsProtocolVersion-drift',
    description: 'contract bumped to v+1 → drift detectable vs frozen WS_PROTOCOL_VERSION',
    detectedBy: 'contract-validator(version)',
    expect: 'flag',
    run: () => {
      const v = new ContractValidator(versionDriftDir)
      const flagged = v.wsProtocolVersion !== WS_PROTOCOL_VERSION
      return { flagged, detail: `loaded wsProtocolVersion=${v.wsProtocolVersion} vs frozen ${WS_PROTOCOL_VERSION}` }
    },
  },

  // ── Normalization / diff ─────────────────────────────────────────────────────
  {
    klass: 'norm/diff',
    id: 'drop-message',
    description: 'drop a whole message (`perf.logging`) from the transcript',
    detectedBy: 'diffNormalized',
    expect: 'flag',
    run: () => normDiffFlagged(dropMessageAt(baseTranscript, PERF_I)),
  },
  {
    klass: 'norm/diff',
    id: 'reorder-messages',
    description: 'reorder two messages (`ready` ↔ `settings.updated`)',
    detectedBy: 'diffNormalized',
    expect: 'flag',
    run: () => normDiffFlagged(swapMessagesAt(baseTranscript, READY_I, SETTINGS_I)),
  },
  {
    klass: 'norm/diff',
    id: 'change-deterministic-boolean',
    description: 'flip a deterministic boolean (`perf.logging.enabled` false→true)',
    detectedBy: 'diffNormalized',
    expect: 'flag',
    run: () => normDiffFlagged(editParsedAt(baseTranscript, PERF_I, (p) => setPath(p, ['enabled'], true))),
  },
  {
    klass: 'norm/diff',
    id: 'change-deterministic-enum',
    description: 'change a deterministic literal (`settings.network.host` 127.0.0.1→0.0.0.0)',
    detectedBy: 'diffNormalized',
    expect: 'flag',
    run: () =>
      normDiffFlagged(
        editParsedAt(baseTranscript, SETTINGS_I, (p) => setPath(p, ['settings', 'network', 'host'], '0.0.0.0')),
      ),
  },
  {
    klass: 'norm/diff',
    id: 'change-non-normalized-value',
    description: 'change a NON-normalized value (`settings.network.configured` true→false)',
    detectedBy: 'diffNormalized',
    expect: 'flag',
    run: () =>
      normDiffFlagged(
        editParsedAt(baseTranscript, SETTINGS_I, (p) => setPath(p, ['settings', 'network', 'configured'], false)),
      ),
  },
  {
    klass: 'norm/diff',
    id: 'break-cross-reference',
    description: 'break an id cross-reference (change only `ready.bootId`, not inventory.bootId)',
    detectedBy: 'diffNormalized',
    expect: 'flag',
    run: () => normDiffFlagged(editParsedAt(baseTranscript, READY_I, (p) => setPath(p, ['bootId'], 'boot-desync-xyz'))),
  },
  // …inverse: nondeterministic-only changes must NOT diff (no false positives)
  {
    klass: 'norm/diff',
    id: 'nondet-timestamp-only',
    description: 'change ONLY a nondeterministic timestamp → must NOT diff',
    detectedBy: 'diffNormalized',
    expect: 'pass',
    run: () =>
      normDiffFlagged(
        editParsedAt(baseTranscript, READY_I, (p) => setPath(p, ['timestamp'], '2027-01-02T03:04:05.678Z')),
      ),
  },
  {
    klass: 'norm/diff',
    id: 'nondet-token-only',
    description: 'change ONLY the opaque auth token → must NOT diff',
    detectedBy: 'diffNormalized',
    expect: 'pass',
    run: () => {
      const helloI = baseTranscript.findIndex((m) => m.dir === 'out' && m.type === 'hello')
      return normDiffFlagged(editParsedAt(baseTranscript, helloI, (p) => setPath(p, ['token'], 'a-brand-new-token')))
    },
  },
  {
    klass: 'norm/diff',
    id: 'nondet-linked-ids-consistent',
    description: 'change a linked id CONSISTENTLY on both ends → must NOT diff (cross-ref preserved)',
    detectedBy: 'diffNormalized',
    expect: 'pass',
    run: () => {
      let t = editParsedAt(baseTranscript, READY_I, (p) => setPath(p, ['bootId'], 'boot-rekeyed-same'))
      t = editParsedAt(t, INVENTORY_I, (p) => setPath(p, ['bootId'], 'boot-rekeyed-same'))
      return normDiffFlagged(t)
    },
  },
  {
    klass: 'norm/diff',
    id: 'nondet-rerandomize-all',
    description: 'rerandomize EVERY nondeterministic field (simulate a fresh boot) → must NOT diff',
    detectedBy: 'diffNormalized',
    expect: 'pass',
    run: () => normDiffFlagged(rerandomizeNondeterministic(baseTranscript)),
  },

  // ── T1 / PTY byte-stream golden ──────────────────────────────────────────────
  {
    klass: 'T1/pty',
    id: 'flip-one-byte',
    description: 'flip a single byte in the golden → byte compare fails',
    detectedBy: 'golden byte-compare',
    expect: 'flag',
    run: () => bytesFlagged(flipByteAt(goldenBytes, 0)),
  },
  {
    klass: 'T1/pty',
    id: 'truncate',
    description: 'drop the last byte of the golden → byte compare fails',
    detectedBy: 'golden byte-compare',
    expect: 'flag',
    run: () => bytesFlagged(truncateBy(goldenBytes, 1)),
  },
  {
    klass: 'T1/pty',
    id: 'insert-byte',
    description: 'insert one byte into the golden → byte compare fails',
    detectedBy: 'golden byte-compare',
    expect: 'flag',
    run: () => bytesFlagged(insertByteAt(goldenBytes, 1, 0x58)),
  },
  {
    klass: 'T1/pty',
    id: 'identical-bytes',
    description: 'byte-identical copy of the golden → must PASS (no false positive)',
    detectedBy: 'golden byte-compare',
    expect: 'pass',
    run: () => bytesFlagged(Buffer.from(goldenBytes)),
  },

  // ── T2 / behavioral invariants (each fatal invariant) ────────────────────────
  {
    klass: 'T2/invariant',
    id: 'session.created',
    description: 'session not created → session.created fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ sessionCreated: false }), 'session.created'),
  },
  {
    klass: 'T2/invariant',
    id: 'session.durable-id-shape',
    description: 'malformed durable id → session.durable-id-shape fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ durableSessionId: 'not-a-ses-id' }), 'session.durable-id-shape'),
  },
  {
    klass: 'T2/invariant',
    id: 'turn.accepted',
    description: 'turn not accepted → turn.accepted fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ turnAccepted: false }), 'turn.accepted'),
  },
  {
    klass: 'T2/invariant',
    id: 'turn.completed',
    description: 'reply not persisted → turn.completed fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ turnCompleted: false }), 'turn.completed'),
  },
  {
    klass: 'T2/invariant',
    id: 'assistant.replied-sentinel',
    description: 'sentinel missing from reply → assistant.replied-sentinel fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ captureContainsSentinel: false }), 'assistant.replied-sentinel'),
  },
  {
    klass: 'T2/invariant',
    id: 'transcript.persisted',
    description: 'no messages persisted → transcript.persisted fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ dbMessageCount: 0 }), 'transcript.persisted'),
  },
  {
    klass: 'T2/invariant',
    id: 'transcript.parseable',
    description: 'transcript not parseable → transcript.parseable fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ transcriptParseable: false }), 'transcript.parseable'),
  },
  {
    klass: 'T2/invariant',
    id: 'provider.emits-idle-signal',
    description: 'provider never emits idle edge → provider.emits-idle-signal fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () => t2Flagged(goodObservation({ serverReportedIdle: false }), 'provider.emits-idle-signal'),
  },
  {
    klass: 'T2/invariant',
    id: 'ownership.cleanup',
    description: 'stray owned pid left behind → ownership.cleanup fails',
    detectedBy: 'assertT2Invariants',
    expect: 'flag',
    run: () =>
      t2Flagged(goodObservation({ ownedCleanupOk: false, strayOwnedPidsAfter: [4242] }), 'ownership.cleanup'),
  },
]

/** Write a two-file contract dir (the pair ContractValidator loads) to `dir`. */
function writeContractDir(dir: string, serverMessages: unknown, wsProtocol: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'ws-server-messages.schema.json'), JSON.stringify(serverMessages), 'utf8')
  writeFileSync(path.join(dir, 'ws-protocol.schema.json'), JSON.stringify(wsProtocol), 'utf8')
}

// ── the suite ────────────────────────────────────────────────────────────────

describe('oracle mutation-validation (data-level)', () => {
  let tmpRoot = ''

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'oracle-mutation-'))
    const serverMsgs = JSON.parse(
      readFileSync(path.join(CONTRACT_DIR, 'ws-server-messages.schema.json'), 'utf8'),
    ) as { wsProtocolVersion: number }
    const wsProto = JSON.parse(
      readFileSync(path.join(CONTRACT_DIR, 'ws-protocol.schema.json'), 'utf8'),
    ) as { wsProtocolVersion: number }

    // mismatch: bump ONLY the server-messages file → the two disagree.
    versionMismatchDir = path.join(tmpRoot, 'mismatch')
    writeContractDir(versionMismatchDir, withContractVersion(serverMsgs, serverMsgs.wsProtocolVersion + 1), wsProto)

    // drift: bump BOTH consistently → loads, but drifts from the frozen constant.
    versionDriftDir = path.join(tmpRoot, 'drift')
    writeContractDir(
      versionDriftDir,
      withContractVersion(serverMsgs, WS_PROTOCOL_VERSION + 1),
      withContractVersion(wsProto, WS_PROTOCOL_VERSION + 1),
    )
  })

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('sanity: all known-good inputs are ACCEPTED by their oracle component', () => {
    // T0: every captured handshake message + every enum exemplar validates.
    for (const msg of serverParsed) {
      const r = validator.validateServerMessage(msg)
      expect(r.known && r.valid, `handshake message failed T0: ${JSON.stringify(msg)} → ${JSON.stringify(r.errors)}`).toBe(true)
    }
    for (const [label, exemplar] of [
      ['error', validErrorMessage()],
      ['terminal.output', validTerminalOutput()],
      ['terminal.turn.complete', validTurnComplete()],
    ] as const) {
      const r = validator.validateServerMessage(exemplar)
      expect(r.known && r.valid, `exemplar "${label}" must be schema-valid before mutation → ${JSON.stringify(r.errors)}`).toBe(true)
    }
    // norm/diff: the base transcript equals itself.
    expect(diffNormalized(baseNorm, baseNorm).equal).toBe(true)
    // T1: the golden equals itself and matches its meta sha256/length.
    expect(goldenBytes.equals(Buffer.from(goldenBytes))).toBe(true)
    expect(goldenBytes.length).toBe(goldenMeta.byteLength)
    // T2: the known-good observation passes.
    expect(assertT2Invariants(goodObservation()).ok).toBe(true)
  })

  for (const c of CASES) {
    const verb = c.expect === 'flag' ? 'CATCHES' : 'IGNORES (no false positive)'
    it(`[${c.klass}] ${verb}: ${c.id} — ${c.description}`, () => {
      const { flagged, detail } = c.run()
      if (c.expect === 'flag') {
        expect(
          flagged,
          `ORACLE GAP: mutation "${c.id}" (${c.klass}) was NOT detected by ${c.detectedBy}.\n  ${detail}`,
        ).toBe(true)
      } else {
        expect(
          flagged,
          `FALSE POSITIVE: "${c.id}" (${c.klass}) was wrongly flagged by ${c.detectedBy}.\n  ${detail}`,
        ).toBe(false)
      }
    })
  }

  it('MUTATION COVERAGE TABLE — every mutation behaves correctly (no oracle gaps)', () => {
    const rows: Array<{ klass: string; id: string; detectedBy: string; expect: Expect; ok: boolean; detail: string }> = []
    for (const c of CASES) {
      const { flagged, detail } = c.run()
      const ok = c.expect === 'flag' ? flagged : !flagged
      rows.push({ klass: c.klass, id: c.id, detectedBy: c.detectedBy, expect: c.expect, ok, detail })
    }
    const w = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n)
    const header = `${w('MUTATION CLASS', 16)} ${w('MUTATION', 30)} ${w('DETECTED-BY', 30)} ${w('EXPECT', 6)} RESULT`
    const lines = rows.map(
      (r) => `${w(r.klass, 16)} ${w(r.id, 30)} ${w(r.detectedBy, 30)} ${w(r.expect, 6)} ${r.ok ? 'PASS' : 'FAIL ← GAP'}`,
    )
    const flags = rows.filter((r) => r.expect === 'flag')
    const passes = rows.filter((r) => r.expect === 'pass')
    const gaps = rows.filter((r) => !r.ok)
    // eslint-disable-next-line no-console
    console.log(
      `\n========= ORACLE MUTATION COVERAGE =========\n${header}\n${lines.join('\n')}\n` +
        `--------------------------------------------\n` +
        `caught ${flags.filter((r) => r.ok).length}/${flags.length} planted divergences · ` +
        `${passes.filter((r) => r.ok).length}/${passes.length} no-false-positive checks · ` +
        `GAPS: ${gaps.length}\n============================================\n` +
        (gaps.length ? 'GAP DETAIL:\n' + gaps.map((g) => `  ${g.klass}/${g.id}: ${g.detail}`).join('\n') + '\n' : ''),
    )
    expect(gaps, `ORACLE GAP(S): ${gaps.map((g) => `${g.klass}/${g.id}`).join(', ')}`).toEqual([])
    // Guard against a vacuous table (all-pass because nothing ran).
    expect(flags.length).toBeGreaterThanOrEqual(18)
    expect(passes.length).toBeGreaterThanOrEqual(5)
  })
})

// ── documented limitations (characterization — surface known gaps LOUDLY) ─────

describe('oracle mutation-validation — KNOWN LIMITATIONS (documented, not weakened)', () => {
  it('KNOWN GAP: contract marks `ready.serverInstanceId`/`bootId` OPTIONAL, so dropping them is NOT flagged', () => {
    // The server ALWAYS sends serverInstanceId + bootId, but the frozen schema
    // (synthesized permissively from the TS types) marks them optional. Dropping
    // them therefore slips past the contract-validator. This is a real, recorded
    // schema-tightening candidate (see STATE.yaml / the T0 findings), documented
    // here so the gap is VISIBLE rather than hidden. Tightening the schema to
    // require them would let this become a caught `drop-required-field` mutation.
    const ready = clone(serverParsed[READY_SERVER_INDEX]) as Record<string, unknown>
    expect(ready.serverInstanceId, 'the original always sends serverInstanceId').toBeTruthy()

    const withoutSrv = dropPath(ready, ['serverInstanceId'])
    const rSrv = validator.validateServerMessage(withoutSrv)
    expect(rSrv.known, 'still a known type').toBe(true)
    expect(
      rSrv.valid,
      'DOCUMENTED: dropping serverInstanceId is NOT flagged because the schema marks it optional',
    ).toBe(true)

    const withoutBoot = dropPath(ready, ['bootId'])
    expect(validator.validateServerMessage(withoutBoot).valid).toBe(true)
    // eslint-disable-next-line no-console
    console.warn(
      '[oracle-gap] ready.serverInstanceId & ready.bootId are schema-optional though always sent — ' +
        'schema-tightening candidate; dropping them is currently NOT caught by T0.',
    )
  })
})
