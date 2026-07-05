import type { Direction } from './ws-capture-client.js'

/**
 * Transcript normalization layer for the equivalence oracle.
 *
 * The oracle diffs old-vs-new WebSocket traffic, but every real transcript
 * carries run-specific values (nanoid ids, timestamps, per-boot server ids,
 * ephemeral ports, temp/rollout paths, PTY byte payloads, provider session
 * ids). This module canonicalizes those values into STABLE placeholders so two
 * structurally-identical transcripts become byte-identical, while any genuine
 * structural difference survives untouched.
 *
 * The registry is derived field-by-field from
 * `port/contract/nondeterministic-fields.md` (itself synthesized from the frozen
 * `ws-*.schema.json`). See that file for the authoritative field->family map.
 *
 * Design invariants (all covered by test/unit/port/normalize.test.ts):
 *   - the SAME raw value always maps to the SAME placeholder, across the whole
 *     transcript AND both directions (this is what preserves cross-references
 *     like a terminalId echoed from `terminal.created` into `terminal.output`);
 *   - placeholders are assigned in FIRST-SEEN order, scoped per family;
 *   - opaque blobs are masked to a family tag and NEVER compared by value;
 *   - deterministic contract fields pass through UNCHANGED (any diff there is a
 *     real divergence);
 *   - shape validators run BEFORE masking so a mis-shaped id is surfaced as a
 *     finding rather than silently canonicalized;
 *   - normalization is IDEMPOTENT: re-normalizing already-normalized output is a
 *     no-op (already-placeholder values pass straight through).
 *
 * Do NOT import server internals here: this must run identically against a
 * captured node-original transcript and a captured Rust-port transcript.
 */

// ── families ────────────────────────────────────────────────────────────────

export type Family = 'id' | 'timestamp' | 'seq' | 'port' | 'path' | 'opaque'

/** How a registered field is normalized. */
export interface FieldSpec {
  family: Family
  /**
   * Placeholder prefix (e.g. `TID` -> `<TID:1>`). Ignored for the `opaque`
   * family, which always masks to `<OPAQUE:{fieldName}>`. Multiple field names
   * may share a tag; the numeric counter is scoped per tag, while value-dedup
   * (the cross-reference guarantee) is scoped per family.
   */
  tag: string
  /** Optional shape validator key (see SHAPE_VALIDATORS). Runs before masking. */
  shape?: ShapeKey
  /** For the `seq` family: whether the report should assert per-stream monotonicity. */
  monotonic?: boolean
}

type ShapeKey = 'nanoid' | 'sessionId' | 'timestamp'

const ID = (tag: string, shape: ShapeKey = 'nanoid'): FieldSpec => ({ family: 'id', tag, shape })
const TS: FieldSpec = { family: 'timestamp', tag: 'TS', shape: 'timestamp' }
const SEQ = (monotonic = false): FieldSpec => ({ family: 'seq', tag: 'SEQ', monotonic })
const PORT: FieldSpec = { family: 'port', tag: 'PORT' }
const PATH: FieldSpec = { family: 'path', tag: 'PATH' }
const OPAQUE: FieldSpec = { family: 'opaque', tag: 'OPAQUE' }
const SESSION = (tag: string): FieldSpec => ({ family: 'id', tag, shape: 'sessionId' })

/**
 * Field-name -> normalization spec. Derived directly from
 * `port/contract/nondeterministic-fields.md`. Field-name based (not path based)
 * so a registered name is normalized at any nesting depth, matching how these
 * fields recur across nested arrays/objects in the wire schemas.
 */
export const FIELD_FAMILIES: Record<string, FieldSpec> = {
  // ── Ids (generated / opaque) ──────────────────────────────────────────────
  terminalId: ID('TID'),
  recoverableTerminalIds: ID('TID'),
  streamId: ID('STREAM'),
  requestId: ID('RID'),
  attachRequestId: ID('RID'),
  createRequestId: ID('RID'),
  sessionId: SESSION('SID'),
  resumeSessionId: SESSION('SID'),
  previousSessionId: SESSION('SID'),
  parentSessionId: SESSION('SID'),
  submittedTurnId: ID('TURN'),
  candidateThreadId: ID('THREAD'),
  durableThreadId: ID('THREAD'),
  serverInstanceId: ID('SRV'),
  bootId: ID('BOOT'),
  tabId: ID('TAB'),
  paneId: ID('PANE'),
  deviceId: ID('DEV'),
  clientInstanceId: ID('DEV'),
  // NOTE: `token` (the WS auth credential) is NOT enumerated in
  // nondeterministic-fields.md, but TestServer mints it with `randomUUID()` per
  // boot, so it is run-specific and MUST be masked. Treated as an opaque secret
  // (never compared by value). Surfaced in the port report as a registry
  // addition beyond the doc.
  token: OPAQUE,
  deviceLabel: OPAQUE,

  // ── Timestamps ────────────────────────────────────────────────────────────
  timestamp: TS,
  createdAt: TS,
  updatedAt: TS,
  capturedAt: TS,
  checkedAt: TS,
  turnCompletedAt: TS,
  at: TS,
  lastActivityAt: TS,
  lastSeenAt: TS,

  // ── Sequence numbers / revisions / counters (run-monotonic) ───────────────
  seqStart: SEQ(true),
  seqEnd: SEQ(true),
  headSeq: SEQ(true),
  replayFromSeq: SEQ(),
  replayToSeq: SEQ(),
  requestedSinceSeq: SEQ(),
  effectiveSinceSeq: SEQ(),
  geometryEpoch: SEQ(),
  sinceSeq: SEQ(),
  fromSeq: SEQ(),
  toSeq: SEQ(),
  completionSeq: SEQ(true),
  revision: SEQ(true),
  endOffset: SEQ(),
  rawFrameCount: SEQ(),
  serializedBytes: SEQ(),
  chainDepth: SEQ(),
  orphansFixed: SEQ(),
  orphanCount: SEQ(),
  // token-usage counters (terminal.meta.updated / SDK Usage payloads)
  inputTokens: SEQ(),
  outputTokens: SEQ(),
  cachedTokens: SEQ(),
  totalTokens: SEQ(),
  contextTokens: SEQ(),
  compactPercent: SEQ(),
  compactThresholdTokens: SEQ(),
  modelContextWindow: SEQ(),
  input_tokens: SEQ(),
  output_tokens: SEQ(),
  cache_creation_input_tokens: SEQ(),
  cache_read_input_tokens: SEQ(),

  // ── Ports ─────────────────────────────────────────────────────────────────
  port: PORT,
  serverPort: PORT,

  // ── Paths (host-/temp-/rollout-specific) ──────────────────────────────────
  cwd: PATH,
  rolloutPath: PATH,
  checkoutRoot: PATH,
  repoRoot: PATH,
  displaySubdir: PATH,
  defaultCwd: PATH,
  allowedFilePaths: PATH,

  // ── Opaque / content blobs (assert invariants, never byte-equality) ───────
  data: OPAQUE,
  event: OPAQUE,
  text: OPAQUE,
  imageBase64: OPAQUE,
  title: OPAQUE,
  branch: OPAQUE,
  isDirty: OPAQUE,
  cliVersion: OPAQUE,
  model: OPAQUE,
}

/** Convenience: coarse family for a field name, or undefined if deterministic. */
export function familyOf(fieldName: string): Family | undefined {
  return FIELD_FAMILIES[fieldName]?.family
}

// ── shape validators (run BEFORE masking) ───────────────────────────────────

/** URL-safe token alphabet (covers nanoid AND uuid AND `ses_`/`srv_` ids). */
const NANOID_RE = /^[A-Za-z0-9_-]{6,}$/
/** Claude canonical session id (UUID v1-5), from shared/session-contract.ts. */
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** Lenient ISO-8601-ish leading form (date + `T`). */
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/

interface ShapeContext {
  /** The immediate enclosing object (provides sibling fields like `provider`). */
  enclosing: Record<string, unknown> | undefined
}

/**
 * A validator returns a human-readable "expected shape" description when the
 * value is malformed, or `null` when it is fine. A malformed value is a real
 * finding (the value's *format* is part of the contract), so it is recorded and
 * THEN masked — never silently swallowed.
 */
type ShapeValidator = (value: string | number, ctx: ShapeContext) => string | null

const SHAPE_VALIDATORS: Record<ShapeKey, ShapeValidator> = {
  nanoid(value) {
    if (typeof value !== 'string' || !NANOID_RE.test(value)) {
      return 'url-safe token (nanoid alphabet [A-Za-z0-9_-], length >= 6)'
    }
    return null
  },
  timestamp(value) {
    if (typeof value === 'number') {
      return value > 0 && Number.isFinite(value) ? null : 'positive epoch-millis number'
    }
    if (typeof value === 'string') {
      return ISO_TS_RE.test(value) ? null : 'ISO-8601 timestamp string'
    }
    return 'ISO-8601 string or epoch-millis number'
  },
  sessionId(value, ctx) {
    if (typeof value !== 'string' || value.length === 0) return 'non-empty provider session id'
    const provider = readProvider(ctx.enclosing)
    switch (provider) {
      case 'claude':
        return CLAUDE_SESSION_ID_RE.test(value) ? null : 'claude canonical session UUID'
      case 'opencode':
        return /^ses_/.test(value) ? null : "opencode session id ('ses_' prefix)"
      case 'codex':
        // Codex durable ids are free-form but never the synthetic `freshcodex-` alias.
        return value.startsWith('freshcodex-') ? 'durable codex session id (not a freshcodex- alias)' : null
      default:
        // Provider unknown from context -> can only assert non-emptiness (done above).
        return null
    }
  },
}

/** Provider discriminant from the enclosing object (top-level or nested sessionRef). */
function readProvider(enclosing: Record<string, unknown> | undefined): string | undefined {
  if (!enclosing) return undefined
  if (typeof enclosing.provider === 'string') return enclosing.provider
  const ref = enclosing.sessionRef
  if (ref && typeof ref === 'object' && typeof (ref as Record<string, unknown>).provider === 'string') {
    return (ref as Record<string, unknown>).provider as string
  }
  return undefined
}

// ── public types ────────────────────────────────────────────────────────────

/** Minimal transcript-message shape this layer consumes (CapturedMessage AND NormalizedMessage satisfy it). */
export interface TranscriptMessage {
  dir: Direction
  type?: string | undefined
  parsed: unknown
}

/** A normalized message: `raw`/`tMs` dropped, canonical `serialized` added. */
export interface NormalizedMessage {
  dir: Direction
  type: string | undefined
  /** The normalized `parsed` tree (placeholders substituted). */
  parsed: unknown
  /** Deterministic, key-SORTED JSON of `parsed` — the stable golden-file form. */
  serialized: string
}

export interface ShapeViolation {
  messageIndex: number
  path: string
  field: string
  family: Family
  expected: string
  value: string
}

export interface OpaquePresence {
  messageIndex: number
  path: string
  field: string
  /** Length of the stringified opaque payload (presence/size only — never the value). */
  length: number
}

export interface MonotonicityViolation {
  /** Normalized stream key (streamId/terminalId sibling), or '' when unscoped. */
  stream: string
  field: string
  /** The raw values, in first-seen order, that failed to be non-decreasing. */
  values: number[]
}

export interface NormalizationReport {
  messageCount: number
  /** Distinct placeholders assigned per tag (e.g. `{ TID: 2, TS: 3 }`). */
  placeholderCounts: Record<string, number>
  /** Values whose format violated their contract shape (a real finding). */
  shapeViolations: ShapeViolation[]
  /** Opaque payloads encountered (audited by presence/length, never value). */
  opaque: OpaquePresence[]
  /** Per-stream seq groups that were not monotonic non-decreasing. */
  monotonicityViolations: MonotonicityViolation[]
}

export interface NormalizeOptions {
  /** Extra field->spec entries merged over the built-in registry (rarely needed). */
  extraFields?: Record<string, FieldSpec>
}

// ── placeholder detection (idempotence) ─────────────────────────────────────

const PLACEHOLDER_RE = /^<[A-Z][A-Z0-9]*:.*>$/

function isPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && PLACEHOLDER_RE.test(value)
}

// ── normalizer core ─────────────────────────────────────────────────────────

interface SeqObservation {
  stream: string
  field: string
  value: number
}

class Normalizer {
  private readonly registry: Record<string, FieldSpec>
  /** family+"\0"+rawValue -> placeholder (value-dedup, per family). */
  private readonly assigned = new Map<string, string>()
  /** tag -> next ordinal. */
  private readonly counters = new Map<string, number>()
  private readonly shapeViolations: ShapeViolation[] = []
  private readonly opaque: OpaquePresence[] = []
  private readonly seqObservations: SeqObservation[] = []
  private messageIndex = 0

  constructor(opts: NormalizeOptions | undefined) {
    this.registry = opts?.extraFields ? { ...FIELD_FAMILIES, ...opts.extraFields } : FIELD_FAMILIES
  }

  normalize(transcript: ReadonlyArray<TranscriptMessage>): {
    normalized: NormalizedMessage[]
    report: NormalizationReport
  } {
    const normalized = transcript.map((m, index) => {
      this.messageIndex = index
      const parsed = this.walk(m.parsed, '$', undefined)
      const type = extractType(parsed) ?? m.type
      return { dir: m.dir, type, parsed, serialized: stableStringify(parsed) }
    })

    return {
      normalized,
      report: {
        messageCount: transcript.length,
        placeholderCounts: Object.fromEntries(this.counters),
        shapeViolations: this.shapeViolations,
        opaque: this.opaque,
        monotonicityViolations: this.checkMonotonicity(),
      },
    }
  }

  /** Recursively normalize a value. `enclosing` is the nearest object ancestor. */
  private walk(value: unknown, path: string, enclosing: Record<string, unknown> | undefined): unknown {
    if (Array.isArray(value)) {
      return value.map((el, i) => this.walk(el, `${path}[${i}]`, enclosing))
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(obj)) {
        out[key] = this.normalizeField(key, obj[key], `${path}.${key}`, obj)
      }
      return out
    }
    // primitive with no registered field context -> deterministic passthrough
    return value
  }

  /** Normalize the value of a specific object key, consulting the registry. */
  private normalizeField(
    key: string,
    value: unknown,
    path: string,
    enclosing: Record<string, unknown>,
  ): unknown {
    const spec = this.registry[key]
    if (!spec) {
      // Not a nondeterministic field: recurse structurally (or pass a primitive
      // through unchanged — a deterministic contract value).
      return this.walk(value, path, enclosing)
    }

    if (spec.family === 'opaque') {
      return this.maskOpaque(key, value, path)
    }

    // Leaf families: primitives and arrays-of-primitives are normalized in
    // place; anything structural falls back to a normal recursion (defensive —
    // a registered field carrying an unexpected object is not force-masked).
    if (isLeaf(value)) {
      return this.normalizeLeaf(spec, key, value, path, enclosing)
    }
    if (Array.isArray(value) && value.every(isLeaf)) {
      return value.map((el, i) => this.normalizeLeaf(spec, key, el, `${path}[${i}]`, enclosing))
    }
    return this.walk(value, path, enclosing)
  }

  private maskOpaque(field: string, value: unknown, path: string): unknown {
    if (value === null || value === undefined) return value
    if (isPlaceholder(value)) return value // idempotent
    const length = typeof value === 'string' ? value.length : stableStringify(value).length
    this.opaque.push({ messageIndex: this.messageIndex, path, field, length })
    return `<OPAQUE:${field}>`
  }

  private normalizeLeaf(
    spec: FieldSpec,
    field: string,
    value: string | number | boolean | null,
    path: string,
    enclosing: Record<string, unknown>,
  ): unknown {
    if (value === null) return value
    if (isPlaceholder(value)) return value // idempotent: already normalized
    // Booleans are never id/timestamp/seq/port/path payloads; leave untouched.
    if (typeof value === 'boolean') return value

    // Shape validation happens BEFORE masking so a malformed value is surfaced.
    if (spec.shape) {
      const expected = SHAPE_VALIDATORS[spec.shape](value, { enclosing })
      if (expected !== null) {
        this.shapeViolations.push({
          messageIndex: this.messageIndex,
          path,
          field,
          family: spec.family,
          expected,
          value: String(value),
        })
      }
    }

    if (spec.family === 'seq' && typeof value === 'number' && spec.monotonic) {
      this.seqObservations.push({ stream: streamKeyOf(enclosing), field, value })
    }

    return this.placeholderFor(spec, value)
  }

  /** Value-deduped placeholder: same (family, value) -> same placeholder. */
  private placeholderFor(spec: FieldSpec, value: string | number): string {
    const key = `${spec.family}\u0000${String(value)}`
    const existing = this.assigned.get(key)
    if (existing) return existing
    const next = (this.counters.get(spec.tag) ?? 0) + 1
    this.counters.set(spec.tag, next)
    const placeholder = `<${spec.tag}:${next}>`
    this.assigned.set(key, placeholder)
    return placeholder
  }

  /**
   * Group monotonic seq observations by (stream, field) in first-seen order and
   * assert each group is non-decreasing. The absolute values are erased by the
   * placeholder; the ordering guarantee lives here in the report instead.
   */
  private checkMonotonicity(): MonotonicityViolation[] {
    const groups = new Map<string, number[]>()
    const order: string[] = []
    for (const obs of this.seqObservations) {
      const gkey = `${obs.stream}\u0000${obs.field}`
      if (!groups.has(gkey)) {
        groups.set(gkey, [])
        order.push(gkey)
      }
      groups.get(gkey)!.push(obs.value)
    }
    const violations: MonotonicityViolation[] = []
    for (const gkey of order) {
      const values = groups.get(gkey)!
      let monotonic = true
      for (let i = 1; i < values.length; i++) {
        if (values[i] < values[i - 1]) {
          monotonic = false
          break
        }
      }
      if (!monotonic) {
        const [stream, field] = gkey.split('\u0000')
        violations.push({ stream, field, values })
      }
    }
    return violations
  }
}

/** Stream grouping key for seq monotonicity: raw streamId/terminalId sibling. */
function streamKeyOf(enclosing: Record<string, unknown> | undefined): string {
  if (!enclosing) return ''
  if (typeof enclosing.streamId === 'string') return enclosing.streamId
  if (typeof enclosing.terminalId === 'string') return enclosing.terminalId
  return ''
}

function isLeaf(value: unknown): value is string | number | boolean | null {
  return value === null || (typeof value !== 'object' && typeof value !== 'undefined')
}

function extractType(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
    return (parsed as { type: string }).type
  }
  return undefined
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Normalize a captured transcript into a canonical, diffable form plus a report
 * of the findings (shape violations, opaque presence, monotonicity). The same
 * raw value always maps to the same placeholder across the whole transcript and
 * both directions, so structural cross-references are preserved.
 */
export function normalizeTranscript(
  transcript: ReadonlyArray<TranscriptMessage>,
  opts?: NormalizeOptions,
): { normalized: NormalizedMessage[]; report: NormalizationReport } {
  return new Normalizer(opts).normalize(transcript)
}

/**
 * The full canonical string form of a normalized transcript — direction-tagged,
 * key-sorted, newline-delimited — suitable for persisting as a golden baseline.
 * `serialized` is recomputed here so the canonical form never depends on a
 * possibly-stale stored string.
 */
export function canonicalizeTranscript(normalized: ReadonlyArray<NormalizedMessage>): string {
  return normalized.map((m) => `${m.dir}\t${stableStringify(m.parsed)}`).join('\n')
}

export interface DiffEntry {
  /** Message index in the transcript. */
  index: number
  /** Dotted/bracketed path within the message (`$` = message root). */
  path: string
  kind: 'changed' | 'added' | 'removed' | 'dir' | 'type' | 'length'
  a?: unknown
  b?: unknown
}

export interface NormalizedDiff {
  equal: boolean
  differences: DiffEntry[]
}

/**
 * Structured old-vs-new diff of two normalized transcripts, at message-index +
 * field-path granularity. After normalization the ONLY differences that remain
 * are real divergences (or an unexplained nondeterministic field the registry
 * still needs to cover).
 */
export function diffNormalized(
  a: ReadonlyArray<NormalizedMessage>,
  b: ReadonlyArray<NormalizedMessage>,
): NormalizedDiff {
  const differences: DiffEntry[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    const ma = a[i]
    const mb = b[i]
    if (ma && !mb) {
      differences.push({ index: i, path: '$', kind: 'removed', a: ma.parsed })
      continue
    }
    if (!ma && mb) {
      differences.push({ index: i, path: '$', kind: 'added', b: mb.parsed })
      continue
    }
    if (!ma || !mb) continue
    if (ma.dir !== mb.dir) {
      differences.push({ index: i, path: '$', kind: 'dir', a: ma.dir, b: mb.dir })
    }
    if (ma.type !== mb.type) {
      differences.push({ index: i, path: '$.type', kind: 'type', a: ma.type, b: mb.type })
    }
    diffValue(i, '$', ma.parsed, mb.parsed, differences)
  }
  if (a.length !== b.length) {
    differences.push({ index: Math.min(a.length, b.length), path: '$', kind: 'length', a: a.length, b: b.length })
  }
  return { equal: differences.length === 0, differences }
}

function diffValue(index: number, path: string, a: unknown, b: unknown, out: DiffEntry[]): void {
  if (a === b) return

  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr || bArr) {
    if (!aArr || !bArr) {
      out.push({ index, path, kind: 'changed', a, b })
      return
    }
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i++) {
      if (i >= a.length) out.push({ index, path: `${path}[${i}]`, kind: 'added', b: b[i] })
      else if (i >= b.length) out.push({ index, path: `${path}[${i}]`, kind: 'removed', a: a[i] })
      else diffValue(index, `${path}[${i}]`, a[i], b[i], out)
    }
    return
  }

  const aObj = a && typeof a === 'object'
  const bObj = b && typeof b === 'object'
  if (aObj || bObj) {
    if (!aObj || !bObj) {
      out.push({ index, path, kind: 'changed', a, b })
      return
    }
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
    for (const key of [...keys].sort()) {
      const hasA = Object.prototype.hasOwnProperty.call(ao, key)
      const hasB = Object.prototype.hasOwnProperty.call(bo, key)
      if (hasA && !hasB) out.push({ index, path: `${path}.${key}`, kind: 'removed', a: ao[key] })
      else if (!hasA && hasB) out.push({ index, path: `${path}.${key}`, kind: 'added', b: bo[key] })
      else diffValue(index, `${path}.${key}`, ao[key], bo[key], out)
    }
    return
  }

  // primitives that are not ===
  out.push({ index, path, kind: 'changed', a, b })
}

// ── deterministic serialization ─────────────────────────────────────────────

/** JSON with recursively key-SORTED objects — a stable canonical string form. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key])
    return out
  }
  return value
}
