import { randomUUID } from 'node:crypto'
import { FIELD_FAMILIES, type Family, type TranscriptMessage } from '../harness/normalize.js'

/**
 * Deterministic MUTATORS for the equivalence oracle's mutation-validation suite.
 *
 * The oracle's whole job is to DETECT divergence between the node original and
 * the Rust port. An oracle that cannot catch a planted bug is worthless, so this
 * module provides the controlled corruptions the mutation suite injects into
 * known-good data (captured handshake transcript, committed PTY goldens, the T2
 * baseline) to PROVE each oracle component actually flags the right class of
 * divergence.
 *
 * Everything here is a PURE transform: given input, return a mutated copy. No
 * server, no I/O, no shared state (each call is independent and reproducible).
 * The suite pairs each mutator with the oracle component that must catch it.
 *
 * Do NOT import server internals here.
 */

// ── deep clone (JSON canonicalization) ──────────────────────────────────────
// JSON round-trip is the right clone for wire messages: it drops `undefined`,
// matching how these values serialize on the wire (and how the contract +
// normalizer see them).
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ── object field operations (immutable) ─────────────────────────────────────

type Obj = Record<string, unknown>

function asObj(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`mutator expected a plain object, got ${Array.isArray(value) ? 'array' : typeof value}`)
  }
  return value as Obj
}

/** Read a nested value by key path (e.g. ['settings','network','host']). */
export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Obj)[key]
  }
  return cur
}

/** Return a clone with the value at `path` removed (delete the leaf key). */
export function dropPath<T>(obj: T, path: readonly string[]): T {
  if (path.length === 0) throw new Error('dropPath needs a non-empty path')
  const copy = clone(obj)
  let cur = asObj(copy)
  for (let i = 0; i < path.length - 1; i++) {
    cur = asObj(cur[path[i]])
  }
  delete cur[path[path.length - 1]]
  return copy
}

/** Return a clone with the value at `path` set to `value` (creates intermediate keys). */
export function setPath<T>(obj: T, path: readonly string[], value: unknown): T {
  if (path.length === 0) throw new Error('setPath needs a non-empty path')
  const copy = clone(obj)
  let cur = asObj(copy)
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur[path[i]] || typeof cur[path[i]] !== 'object') cur[path[i]] = {}
    cur = asObj(cur[path[i]])
  }
  cur[path[path.length - 1]] = value
  return copy
}

// ── transcript operations ───────────────────────────────────────────────────

/** Return a copy of the transcript with message `i` removed. */
export function dropMessageAt<T>(transcript: readonly T[], i: number): T[] {
  if (i < 0 || i >= transcript.length) throw new Error(`dropMessageAt: index ${i} out of range`)
  const copy = transcript.map(clone)
  copy.splice(i, 1)
  return copy
}

/** Return a copy of the transcript with messages `i` and `j` swapped. */
export function swapMessagesAt<T>(transcript: readonly T[], i: number, j: number): T[] {
  const copy = transcript.map(clone)
  if (i < 0 || j < 0 || i >= copy.length || j >= copy.length) {
    throw new Error(`swapMessagesAt: index out of range (${i}, ${j})`)
  }
  ;[copy[i], copy[j]] = [copy[j], copy[i]]
  return copy
}

/**
 * Return a copy of the transcript with the `parsed` payload of message `i`
 * transformed by `fn` (given a deep clone to mutate/return).
 */
export function editParsedAt(
  transcript: readonly TranscriptMessage[],
  i: number,
  fn: (parsed: unknown) => unknown,
): TranscriptMessage[] {
  const copy = transcript.map((m) => clone(m))
  if (i < 0 || i >= copy.length) throw new Error(`editParsedAt: index ${i} out of range`)
  copy[i] = { ...copy[i], parsed: fn(clone(copy[i].parsed)) }
  return copy
}

// ── nondeterministic re-randomization (simulate a fresh boot) ────────────────

/** A fresh value generator per coarse family, memoized so equal originals stay linked. */
class ReRandomizer {
  /** family+"\0"+original -> replacement (preserves cross-references, per family). */
  private readonly memo = new Map<string, string | number>()

  private fresh(family: Family, original: unknown, enclosing: Obj | undefined): string | number {
    const key = `${family}\u0000${String(original)}`
    const existing = this.memo.get(key)
    if (existing !== undefined) return existing
    const next = this.generate(family, original, enclosing)
    this.memo.set(key, next)
    return next
  }

  private generate(family: Family, original: unknown, enclosing: Obj | undefined): string | number {
    switch (family) {
      case 'timestamp':
        // A different, still-valid ISO-8601 instant.
        return new Date(Date.UTC(2030, 0, 1) + Math.floor(Math.random() * 1e9)).toISOString()
      case 'port':
        return 1024 + Math.floor(Math.random() * 60000)
      case 'seq':
        return Math.floor(Math.random() * 1_000_000)
      case 'path':
        return `/tmp/rerand-${randomUUID()}`
      case 'opaque':
        // Value is masked to a constant tag anyway; a fresh blob still normalizes equal.
        return `rerand-opaque-${randomUUID()}`
      case 'id':
      default:
        return this.freshId(original, enclosing)
    }
  }

  /** Provider-aware id regeneration so shape validators stay satisfied. */
  private freshId(original: unknown, enclosing: Obj | undefined): string {
    const provider = readProvider(enclosing)
    // opencode durable ids are `ses_<base62>`; keep that shape if present.
    if (typeof original === 'string' && original.startsWith('ses_')) {
      return `ses_${randomUUID().replace(/-/g, '')}`
    }
    if (provider === 'opencode') return `ses_${randomUUID().replace(/-/g, '')}`
    // Preserve a leading textual prefix (`srv-`, `boot-`, `freshopencode-`, …) so
    // the replacement stays recognizable AND matches any prefix-based id-shape.
    if (typeof original === 'string') {
      const m = original.match(/^([A-Za-z]+-)/)
      if (m) return `${m[1]}${randomUUID()}`
    }
    // Default: a url-safe token (uuid alphabet is nanoid-compatible: [A-Za-z0-9-]).
    return randomUUID()
  }

  rewrite(transcript: readonly TranscriptMessage[]): TranscriptMessage[] {
    return transcript.map((m) => ({ ...m, parsed: this.walk(m.parsed, undefined) }))
  }

  private walk(value: unknown, enclosing: Obj | undefined): unknown {
    if (Array.isArray(value)) return value.map((el) => this.walk(el, enclosing))
    if (value && typeof value === 'object') {
      const obj = value as Obj
      const out: Obj = {}
      for (const key of Object.keys(obj)) {
        out[key] = this.rewriteField(key, obj[key], obj)
      }
      return out
    }
    return value
  }

  private rewriteField(key: string, value: unknown, enclosing: Obj): unknown {
    const spec = FIELD_FAMILIES[key]
    if (!spec) return this.walk(value, enclosing)
    const rewriteLeaf = (v: unknown): unknown => {
      if (v === null || typeof v === 'boolean') return v
      if (typeof v === 'string' || typeof v === 'number') return this.fresh(spec.family, v, enclosing)
      return this.walk(v, enclosing)
    }
    if (Array.isArray(value)) return value.map(rewriteLeaf)
    if (value && typeof value === 'object') return this.walk(value, enclosing)
    return rewriteLeaf(value)
  }
}

function readProvider(enclosing: Obj | undefined): string | undefined {
  if (!enclosing) return undefined
  if (typeof enclosing.provider === 'string') return enclosing.provider
  const ref = enclosing.sessionRef
  if (ref && typeof ref === 'object' && typeof (ref as Obj).provider === 'string') {
    return (ref as Obj).provider as string
  }
  return undefined
}

/**
 * Return a copy of the transcript in which EVERY registered nondeterministic
 * field (ids, timestamps, seqs, ports, paths, opaque blobs) is replaced with a
 * fresh, valid-shaped value — exactly as a genuine second boot would differ.
 * Equal originals map to equal replacements (cross-references preserved), so a
 * correct normalizer must collapse this back to the SAME canonical form as the
 * input. Any residual diff is a normalizer FALSE POSITIVE.
 */
export function rerandomizeNondeterministic(transcript: readonly TranscriptMessage[]): TranscriptMessage[] {
  return new ReRandomizer().rewrite(transcript)
}

// ── byte-stream operations (PTY / T1) ────────────────────────────────────────

/** Return a copy of `buf` with the byte at `i` flipped (XOR 0xff — always changes it). */
export function flipByteAt(buf: Buffer, i: number): Buffer {
  if (i < 0 || i >= buf.length) throw new Error(`flipByteAt: index ${i} out of range (len ${buf.length})`)
  const out = Buffer.from(buf)
  out[i] = out[i] ^ 0xff
  return out
}

/** Return `buf` truncated by `n` bytes from the end (default 1). */
export function truncateBy(buf: Buffer, n = 1): Buffer {
  if (n <= 0) throw new Error('truncateBy needs n >= 1')
  return Buffer.from(buf.subarray(0, Math.max(0, buf.length - n)))
}

/** Return a copy of `buf` with `byte` inserted at position `i` (grows length by 1). */
export function insertByteAt(buf: Buffer, i: number, byte = 0x58 /* 'X' */): Buffer {
  if (i < 0 || i > buf.length) throw new Error(`insertByteAt: index ${i} out of range (len ${buf.length})`)
  return Buffer.concat([buf.subarray(0, i), Buffer.from([byte & 0xff]), buf.subarray(i)])
}

// ── contract-version operations (T0 protocol version) ────────────────────────

interface VersionedContract {
  wsProtocolVersion: number
  [k: string]: unknown
}

/** Return a clone of a loaded contract JSON with its `wsProtocolVersion` set to `version`. */
export function withContractVersion<T extends VersionedContract>(contract: T, version: number): T {
  const copy = clone(contract)
  copy.wsProtocolVersion = version
  return copy
}
