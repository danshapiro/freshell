/**
 * DETERMINISTIC `terminal.output.batch` golden generator (equivalence oracle, T1
 * batch-framing / deferred 3.3b).
 *
 * WHY DETERMINISTIC (not a live capture): the live-wire batch SEGMENT structure is
 * chunk-nondeterministic — node-pty read-chunk boundaries + flush timing vary the
 * frame set boot-to-boot, so two boots of the ORIGINAL produce DIFFERENT batch
 * groupings (empirically: 13 vs 12 batches for the same scenario). The batch framing
 * itself is a PURE, DETERMINISTIC function of (frames -> batches -> wire payloads); the
 * only nondeterminism is upstream chunking. So the byte-exact original-vs-rust proof
 * is done here, over FIXED frame sequences, against the ORIGINAL's own source-of-truth
 * logic. (Live data-faithfulness + UTF-16 + invariants are proven separately by
 * test/unit/port/oracle/t1-batch-equivalence-rust.test.ts.)
 *
 * SOURCE OF TRUTH: this generator imports the ORIGINAL, pristine
 *   - `createTerminalOutputBarrierScanner`  (output-barrier-scanner.ts) — classification
 *   - `buildTerminalOutputBatches`          (output-batch.ts)           — merge + UTF-16 offsets
 *   - `measureTerminalOutputPayloadBytes`   (serialized-budget.ts)      — JSON byte size
 * and replicates ONLY the thin broker WIRE projection (broker.ts:1377-1520, cited
 * inline) — relative endOffset, rawFrameCount, the serializedBytes 4-pass fixpoint, and
 * over-budget splitting. Each generated payload is self-checked: its serializedBytes
 * must equal its own JSON byte length (the fixpoint invariant, using the real measure).
 *
 * The committed goldens are what `crates/freshell-terminal/tests/batch_wire_golden.rs`
 * must reproduce byte-for-byte from the Rust port of the same three pieces.
 *
 * Run: `node_modules/.bin/tsx port/oracle/baselines/batch/generate-batch-goldens.ts`
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTerminalOutputBarrierScanner } from '../../../../server/terminal-stream/output-barrier-scanner.js'
import { buildTerminalOutputBatches, type TerminalOutputBatch } from '../../../../server/terminal-stream/output-batch.js'
import { measureTerminalOutputPayloadBytes } from '../../../../server/terminal-stream/serialized-budget.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const TERMINAL_ID = 'term-1'
const STREAM_ID = 'stream-1'
const ATTACH_REQUEST_ID = 'attach-1'
const SOURCE = 'replay' as const
const DEFAULT_BATCH_MAX = 16 * 1024

interface BatchScenario {
  name: string
  description: string
  /** Ordered PTY fragments (each becomes one classified ReplayFrame). */
  frames: string[]
  /** Merge budget passed to buildTerminalOutputBatches (default 16 KiB). */
  mergeMaxBytes?: number
  /** Wire split budget passed to the projection (default 16 KiB). */
  batchMaxBytes?: number
}

/** The committed scenario set — exercises the full batch-framing surface. */
const SCENARIOS: BatchScenario[] = [
  { name: 'single-ground', description: 'one transparent-ground frame -> one batch, one segment', frames: ['hello world\r\n'] },
  { name: 'multi-merge', description: 'contiguous transparent-ground frames coalesce into one batch', frames: ['hello ', 'there ', 'world\r\n'] },
  { name: 'barrier-control-sgr', description: 'SGR color = control barrier, does not coalesce', frames: ['red=', '\u001b[31m', 'RED', '\u001b[0m', '\r\n'] },
  { name: 'barrier-turn-complete-bel', description: 'BEL = turn_complete barrier standalone', frames: ['done', '\u0007', 'next\r\n'] },
  { name: 'barrier-request-mode-dsr', description: 'CSI 6n = request_mode (device status report)', frames: ['q', '\u001b[6n', 'a\r\n'] },
  { name: 'barrier-startup-probe-da', description: 'CSI c = startup_probe (device attributes)', frames: ['\u001b[c', 'ok\r\n'] },
  { name: 'barrier-osc52', description: 'OSC 52 clipboard = osc52 barrier (priority beats control)', frames: ['\u001b]52;c;QUJD\u0007', 'z\r\n'] },
  { name: 'multibyte-utf16', description: 'emoji (2 UTF-16 units, 4 bytes) + CJK (1 unit, 3 bytes) — proves endOffset is UTF-16', frames: ['a\u{1F600}b', '\u4e2d\u6587\r\n'] },
  { name: 'stateful-csi-split', description: 'a CSI sequence split across two frames — scanner state persists', frames: ['pre', '\u001b[', '6n', 'post\r\n'] },
  // Over-budget: merge everything (large merge budget) then split the wire payload with
  // a small batchMaxBytes so buildTerminalOutputBatchPayloads greedily repacks segments.
  { name: 'over-budget-split', description: 'a merged batch whose wire payload exceeds batchMaxBytes splits into multiple payloads', frames: ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE'], batchMaxBytes: 210 },
]

// ── source-of-truth classification (replay-ring.ts:62-79) ──────────────────

interface ClassifiedFrame {
  seqStart: number
  seqEnd: number
  data: string
  bytes: number
  at: number
  streamId: string
  barrier: boolean
  barrierReason?: string
  scannerStateBefore: { mode: string }
  scannerStateAfter: { mode: string }
}

/** Run each fragment through the ORIGINAL stateful scanner, in order, exactly as
 * `ReplayRing.append` does (`replay-ring.ts:62-79`); no truncation for these <maxBytes
 * fragments. Assigns seqs 1..N (one per fragment, `replay-deque.ts:59-61`). */
function classifyFrames(fragments: string[]): ClassifiedFrame[] {
  const scanner = createTerminalOutputBarrierScanner()
  return fragments.map((data, i) => {
    const c = scanner.scan(data)
    return {
      seqStart: i + 1,
      seqEnd: i + 1,
      data,
      bytes: Buffer.byteLength(data, 'utf8'),
      at: i + 1,
      streamId: STREAM_ID,
      barrier: c.barrier,
      ...(c.barrier ? { barrierReason: c.reason } : {}),
      scannerStateBefore: c.stateBefore,
      scannerStateAfter: c.stateAfter,
    }
  })
}

// ── the broker WIRE projection (broker.ts:1377-1520), source-of-truth measure ──

type WireSegment = { seqStart: number; seqEnd: number; endOffset: number; rawFrameCount: number; barrier?: string }

/** `buildTerminalOutputBatchWireSegments` (`broker.ts:1502-1520`). */
function wireSegments(batch: TerminalOutputBatch, start: number, end: number, baseOffset: number): WireSegment[] {
  let previousEndOffset = 0
  return batch.segments.slice(start, end).map((segment) => {
    const relative = Math.max(previousEndOffset, Math.floor(segment.endOffset - baseOffset))
    previousEndOffset = relative
    return {
      seqStart: segment.seqStart,
      seqEnd: segment.seqEnd,
      endOffset: relative,
      rawFrameCount: Math.max(1, segment.seqEnd - segment.seqStart + 1),
      ...(segment.barrier && segment.barrierReason ? { barrier: segment.barrierReason } : {}),
    }
  })
}

/** `buildTerminalOutputBatchPayload` (`broker.ts:1452-1500`) — the serializedBytes
 * 4-pass fixpoint uses the REAL measure fn. */
function buildBatchPayload(batch: TerminalOutputBatch, start: number, end: number): Record<string, unknown> {
  const first = batch.segments[start]
  const last = batch.segments[end - 1]
  const startOffset = start === 0 ? 0 : batch.segments[start - 1].endOffset
  const endOffset = last.endOffset
  const data = batch.data.slice(startOffset, endOffset) // UTF-16 slice (broker.ts:1476)
  const segments = wireSegments(batch, start, end, startOffset)
  const base = (serializedBytes: number) => ({
    type: 'terminal.output.batch',
    terminalId: TERMINAL_ID,
    streamId: batch.streamId,
    attachRequestId: ATTACH_REQUEST_ID,
    source: SOURCE,
    seqStart: first.seqStart,
    seqEnd: last.seqEnd,
    data,
    serializedBytes,
    segments,
  })
  let serializedBytes = 0
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = measureTerminalOutputPayloadBytes(base(serializedBytes))
    if (measured === serializedBytes) break
    serializedBytes = measured
  }
  return base(serializedBytes)
}

/** `buildTerminalOutputBatchSingleSegmentFallbackPayloads` (`broker.ts:1425-1450`). */
function singleSegmentFallback(batch: TerminalOutputBatch, index: number): Record<string, unknown> {
  const segment = batch.segments[index]
  const startOffset = index === 0 ? 0 : batch.segments[index - 1].endOffset
  const endOffset = Math.max(startOffset, Math.floor(segment.endOffset))
  return {
    type: 'terminal.output',
    terminalId: TERMINAL_ID,
    streamId: batch.streamId,
    seqStart: segment.seqStart,
    seqEnd: segment.seqEnd,
    data: batch.data.slice(startOffset, endOffset),
    attachRequestId: ATTACH_REQUEST_ID,
    source: SOURCE,
  }
}

/** `buildTerminalOutputBatchPayloads` (`broker.ts:1377-1422`). */
function buildBatchWirePayloads(batch: TerminalOutputBatch, batchMaxBytes: number): Record<string, unknown>[] {
  const segCount = batch.segments.length
  if (segCount === 0) return []
  const full = buildBatchPayload(batch, 0, segCount)
  if ((full.serializedBytes as number) <= batchMaxBytes) return [full]
  if (segCount <= 1) return [singleSegmentFallback(batch, 0)]

  const payloads: Record<string, unknown>[] = []
  let start = 0
  while (start < segCount) {
    let end = start + 1
    let current = buildBatchPayload(batch, start, end)
    if ((current.serializedBytes as number) > batchMaxBytes) {
      payloads.push(singleSegmentFallback(batch, start))
      start = end
      continue
    }
    while (end < segCount) {
      const candidate = buildBatchPayload(batch, start, end + 1)
      if ((candidate.serializedBytes as number) > batchMaxBytes) break
      current = candidate
      end += 1
    }
    payloads.push(current)
    start = end
  }
  return payloads
}

// ── canonical (sorted-key) serialization ───────────────────────────────────

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
const canonical = (value: unknown) => JSON.stringify(sortKeys(value))

// ── generate ───────────────────────────────────────────────────────────────

function generate() {
  const index: Array<Record<string, unknown>> = []
  for (const scenario of SCENARIOS) {
    const frames = classifyFrames(scenario.frames)
    const batches = buildTerminalOutputBatches({
      frames,
      terminalId: TERMINAL_ID,
      attachRequestId: ATTACH_REQUEST_ID,
      source: SOURCE,
      maxSerializedBytes: scenario.mergeMaxBytes ?? DEFAULT_BATCH_MAX,
    })
    const batchMaxBytes = scenario.batchMaxBytes ?? DEFAULT_BATCH_MAX
    const payloads: Record<string, unknown>[] = []
    for (const batch of batches) payloads.push(...buildBatchWirePayloads(batch, batchMaxBytes))

    // Self-check: every batch payload's serializedBytes equals its own JSON byte length
    // (the fixpoint invariant, using the real measure fn) — anchors correctness.
    for (const p of payloads) {
      if (p.type === 'terminal.output.batch') {
        const measured = measureTerminalOutputPayloadBytes(p)
        if (measured !== p.serializedBytes) {
          throw new Error(`serializedBytes self-check failed for ${scenario.name}: claimed ${String(p.serializedBytes)}, measured ${measured}`)
        }
      }
    }

    const golden = {
      scenario: scenario.name,
      description: scenario.description,
      terminalId: TERMINAL_ID,
      streamId: STREAM_ID,
      attachRequestId: ATTACH_REQUEST_ID,
      source: SOURCE,
      batchMaxBytes,
      mergeMaxBytes: scenario.mergeMaxBytes ?? DEFAULT_BATCH_MAX,
      frames: scenario.frames,
      payloads,
    }
    const serialized = canonical(golden)
    const goldenPath = path.join(HERE, `${scenario.name}.batch.json`)
    fs.writeFileSync(goldenPath, `${serialized}\n`)
    const sha256 = createHash('sha256').update(serialized).digest('hex')
    const meta = {
      scenario: scenario.name,
      sha256,
      byteLength: Buffer.byteLength(serialized, 'utf8'),
      payloadCount: payloads.length,
      batchCount: payloads.filter((p) => p.type === 'terminal.output.batch').length,
      fallbackCount: payloads.filter((p) => p.type === 'terminal.output').length,
    }
    fs.writeFileSync(path.join(HERE, `${scenario.name}.batch.meta.json`), `${canonical(meta)}\n`)
    index.push(meta)
    // eslint-disable-next-line no-console
    console.log(`[batch-golden] ${scenario.name}: ${payloads.length} payload(s) (${meta.batchCount} batch, ${meta.fallbackCount} fallback) sha256=${sha256.slice(0, 12)}…`)
  }
  fs.writeFileSync(path.join(HERE, 'index.json'), `${canonical({ scenarios: index })}\n`)
  // eslint-disable-next-line no-console
  console.log(`[batch-golden] wrote ${index.length} scenario goldens to ${HERE}`)
}

generate()
