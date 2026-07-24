import { createHash, randomUUID } from 'node:crypto'
import { WsCaptureClient } from './ws-capture-client.js'
import { normalizeTranscript } from './normalize.js'
import type { ExternalServerHandle } from './external-server.js'
import type { PtyScenario } from '../fixtures/pty-scenarios.js'

/**
 * PTY byte-stream golden-capture harness (equivalence oracle, T1).
 *
 * Drives a fixed sequence of shell commands through a REAL pseudo-terminal
 * (node-pty, spawned by the ORIGINAL freshell server) over the live WebSocket
 * wire and captures the exact terminal output BYTES the shell produces. Those
 * bytes — bounded deterministically by sentinels — become the committed golden
 * the Rust port must reproduce.
 *
 * The whole value is a BYTE-STABLE capture, so every nondeterminism source is
 * pinned:
 *   - We attach BEFORE sending any input so all payload output is live/ordered.
 *   - A one-shot SETUP line neutralises the interactive shell: it disables
 *     readline line-editing (`set +o emacs/+o vi`) and tty echo (`stty -echo`),
 *     empties the prompts (`PS1`/`PS2`) and clears `PROMPT_COMMAND`. Its own
 *     output is EXCLUDED from the golden window. We wait for a `SETUP_DONE`
 *     sentinel (in the terminal OUTPUT, CR-LF anchored) so echo is provably off
 *     before any payload byte is sent — no echo can leak into the golden.
 *   - Sentinels bound the golden window: `printf <START>`, payload, `printf
 *     <END>`. We extract exactly the bytes between the START line and the END
 *     marker, removing the shell-init banner, prompts, and any residual noise.
 *   - The stream is REASSEMBLED by ordering frames by `seqStart` and
 *     concatenating decoded `data` (handling `terminal.output` AND
 *     `terminal.output.batch`), so nondeterministic chunk boundaries never
 *     affect the compared bytes.
 *
 * `data` ENCODING: raw UTF-8 (NOT base64). node-pty is spawned emitting string
 * data (terminal-registry.ts pty.spawn) and the wire `data` field is that string
 * verbatim (Buffer.byteLength(data,'utf8') accounting in terminal-stream/broker).
 * The scenarios are ASCII-only, so no multi-byte splits at chunk boundaries.
 *
 * This is transport-only: it imports NO server internals, so it will drive the
 * node original and the future Rust port identically.
 */

export interface SentinelConfig {
  /** Printed once before the payload; golden begins after this marker's line. */
  start: string
  /** Printed once after the payload; golden ends at this marker. */
  end: string
  /** Printed at the end of the setup line; proves echo is off before payload. */
  setupDone: string
}

export const DEFAULT_SENTINELS: SentinelConfig = {
  start: '<<<FRESHELL_OSTART>>>',
  end: '<<<FRESHELL_OEND>>>',
  setupDone: '<<<FRESHELL_SETUP_DONE>>>',
}

/**
 * One-shot environment-neutralising setup line. Runs before the payload; its
 * output is excluded from the golden. Ends by printing the setupDone sentinel so
 * the harness can prove echo/line-editing are off before it sends any payload.
 *
 * `{setupDone}` is substituted by the harness. `2>/dev/null` guards make this a
 * no-op-if-unsupported on non-bash shells rather than emitting an error line.
 */
export const DEFAULT_SETUP_TEMPLATE = [
  'set +o emacs 2>/dev/null',
  'set +o vi 2>/dev/null',
  'stty -echo 2>/dev/null',
  "PS1=''",
  "PS2=''",
  "PROMPT_COMMAND=''",
  'unset PROMPT_COMMAND 2>/dev/null',
  "printf '{setupDone}\\n'",
].join('; ')

export interface PtyCaptureOptions {
  /** Terminal columns for attach (default 120 — matches the server spawn size, so no resize). */
  cols?: number
  /** Terminal rows for attach (default 30 — matches the server spawn size). */
  rows?: number
  /** Sentinel overrides. */
  sentinels?: Partial<SentinelConfig>
  /** Override the setup line (must still print `{setupDone}\n`). */
  setupTemplate?: string
  /** Per-wait budget in ms for the handshake / sentinels (default 20000). */
  timeoutMs?: number
  /**
   * Client capabilities to advertise in `hello.capabilities` (e.g.
   * `{ terminalOutputBatchV1: true }`). Default: none — so output arrives as legacy
   * `terminal.output` frames (the T1 default). When `terminalOutputBatchV1` is set the
   * server emits `terminal.output.batch` instead (`ws-handler.ts:1846-1848`).
   */
  capabilities?: Record<string, boolean>
  /** Optional sink for human-readable progress (test diagnostics). */
  log?: (msg: string) => void
}

export interface PtyCaptureResult {
  /** Scenario captured. */
  scenario: string
  /** Exact bytes between the sentinels — the golden. */
  goldenBytes: Buffer
  /** Same bytes as a UTF-8 string (convenience for readable assertions). */
  goldenText: string
  /** SHA-256 of `goldenBytes`, hex. */
  sha256: string
  /** Total chars in the fully reassembled stream (banner + sentinels + payload). */
  reassembledLength: number
  /** Number of output frames used in reassembly. */
  frameCount: number
  /** Count of each output message type seen (terminal.output / .batch / .gap). */
  outputTypeCounts: Record<string, number>
  /** terminalId assigned by the server (raw — masked in normalizedEnvelope). */
  terminalId: string
  /** streamId from terminal.attach.ready (raw). */
  streamId: string
  /**
   * The `terminal.created` + `terminal.attach.ready` envelopes with
   * nondeterministic fields (ids/seqs) normalised — stable across boots, so the
   * envelope shape can be compared even though the golden is compared by bytes.
   */
  normalizedEnvelope: { created: string; attachReady: string }
  /** `terminal.output.gap` occurrences (should be empty; non-empty = lost bytes). */
  gaps: Array<{ fromSeq: number; toSeq: number; reason: string }>
  /**
   * Raw `terminal.output.batch` wire payloads for this stream, in capture order
   * (empty unless `terminalOutputBatchV1` was negotiated). Exposed so the batch tier
   * can assert per-batch structural invariants (UTF-16 `endOffset`, `rawFrameCount`,
   * `serializedBytes` fixpoint, `barrier` reason) on the live wire.
   */
  outputBatches: CapturedBatch[]
}

/** A `terminal.output.batch` wire payload (the fields the batch tier asserts on). */
export interface CapturedBatch {
  seqStart: number
  seqEnd: number
  data: string
  serializedBytes: number
  segments: Array<{ seqStart: number; seqEnd: number; endOffset: number; rawFrameCount: number; barrier?: string }>
  /** UTF-8 byte length of the EXACT wire frame — must equal `serializedBytes` (the fixpoint). */
  rawByteLength: number
}

interface OutputFrame {
  seqStart: number
  seqEnd: number
  data: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Build `printf '<marker>\n'` + submitting newline as raw pty input bytes. */
function printfLine(marker: string): string {
  // Inside the command, \n is the two literal chars backslash+n (printf's
  // escape); the trailing \n is the real newline that submits the line.
  return `printf '${marker}\\n'\n`
}

/**
 * Order output frames by seq and concatenate their decoded data. Chunk
 * boundaries are nondeterministic; the concatenated byte content is not.
 */
function reassemble(frames: OutputFrame[]): string {
  return [...frames]
    .sort((a, b) => a.seqStart - b.seqStart)
    .map((f) => f.data)
    .join('')
}

interface CollectResult {
  frames: OutputFrame[]
  gaps: Array<{ fromSeq: number; toSeq: number; reason: string }>
  typeCounts: Record<string, number>
  batches: CapturedBatch[]
}

/** Pull the output frames for a given stream out of the capture transcript. */
function collectOutput(client: WsCaptureClient, streamId: string): CollectResult {
  const frames: OutputFrame[] = []
  const gaps: Array<{ fromSeq: number; toSeq: number; reason: string }> = []
  const typeCounts: Record<string, number> = {}
  const batches: CapturedBatch[] = []
  for (const m of client.getServerMessages()) {
    const p = m.parsed as Record<string, unknown> | null
    if (!p || typeof p !== 'object') continue
    if (p.streamId !== streamId) continue
    const type = m.type
    if (type === 'terminal.output' || type === 'terminal.output.batch') {
      typeCounts[type] = (typeCounts[type] ?? 0) + 1
      if (typeof p.data === 'string') {
        frames.push({ seqStart: Number(p.seqStart), seqEnd: Number(p.seqEnd), data: p.data })
      }
      if (type === 'terminal.output.batch' && Array.isArray(p.segments)) {
        batches.push({
          seqStart: Number(p.seqStart),
          seqEnd: Number(p.seqEnd),
          data: String(p.data),
          serializedBytes: Number(p.serializedBytes),
          segments: (p.segments as Array<Record<string, unknown>>).map((s) => ({
            seqStart: Number(s.seqStart),
            seqEnd: Number(s.seqEnd),
            endOffset: Number(s.endOffset),
            rawFrameCount: Number(s.rawFrameCount),
            ...(typeof s.barrier === 'string' ? { barrier: s.barrier } : {}),
          })),
          rawByteLength: Buffer.byteLength(m.raw, 'utf8'),
        })
      }
    } else if (type === 'terminal.output.gap') {
      typeCounts[type] = (typeCounts[type] ?? 0) + 1
      gaps.push({
        fromSeq: Number(p.fromSeq),
        toSeq: Number(p.toSeq),
        reason: String(p.reason),
      })
    }
  }
  return { frames, gaps, typeCounts, batches }
}

/** True once the marker appears in its terminal-OUTPUT form (CR-LF or LF). */
function outputHasMarker(stream: string, marker: string): boolean {
  return stream.includes(`${marker}\r\n`) || stream.includes(`${marker}\n`)
}

/**
 * Poll the reassembled stream until `marker` appears in output form, or throw
 * with a hex tail of what WAS captured (so residual nondeterminism is legible).
 */
async function waitForOutputMarker(
  client: WsCaptureClient,
  streamId: string,
  marker: string,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const start = Date.now()
  let stream = ''
  while (Date.now() - start < timeoutMs) {
    stream = reassemble(collectOutput(client, streamId).frames)
    if (outputHasMarker(stream, marker)) return stream
    await sleep(25)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label} marker ${JSON.stringify(marker)} ` +
      `in terminal output (stream ${streamId}). Reassembled ${stream.length} chars; ` +
      `tail(hex)=${hexTail(Buffer.from(stream, 'utf8'), 96)}`,
  )
}

/**
 * Extract the bytes strictly between the start and end sentinels.
 *
 * Anchored on the OUTPUT form of each marker (`marker\r\n`, falling back to
 * `marker\n` if CR-LF translation was off): the shell only ever prints the
 * marker followed by a newline, whereas an echoed *command* would be
 * `printf '<marker>\n'` (marker followed by backslash-n-quote), so the anchor
 * can never collide with a leaked echo.
 */
function extractGolden(
  stream: string,
  start: string,
  end: string,
): { golden: string; reason?: string } {
  const anchor = (m: string): { idx: number; len: number } => {
    const crlf = stream.indexOf(`${m}\r\n`)
    if (crlf !== -1) return { idx: crlf, len: `${m}\r\n`.length }
    const lf = stream.indexOf(`${m}\n`)
    if (lf !== -1) return { idx: lf, len: `${m}\n`.length }
    return { idx: -1, len: 0 }
  }
  const s = anchor(start)
  if (s.idx === -1) return { golden: '', reason: `start sentinel ${JSON.stringify(start)} not found in output` }
  const goldenStart = s.idx + s.len
  const eCrlf = stream.indexOf(`${end}\r\n`, goldenStart)
  const eLf = eCrlf === -1 ? stream.indexOf(`${end}\n`, goldenStart) : -1
  const endIdx = eCrlf !== -1 ? eCrlf : eLf
  if (endIdx === -1) return { golden: '', reason: `end sentinel ${JSON.stringify(end)} not found after start` }
  return { golden: stream.slice(goldenStart, endIdx) }
}

/** First N bytes of a buffer as spaced hex (diagnostics). */
export function hexHead(buf: Buffer, n = 64): string {
  return buf.subarray(0, n).toString('hex').replace(/(..)/g, '$1 ').trim()
}

/** Last N bytes of a buffer as spaced hex (diagnostics). */
export function hexTail(buf: Buffer, n = 64): string {
  return buf.subarray(Math.max(0, buf.length - n)).toString('hex').replace(/(..)/g, '$1 ').trim()
}

/**
 * Render a byte-level diff of two captures as aligned hex (so residual
 * nondeterminism is visible in test output). Returns '' when identical.
 */
export function hexDiff(a: Buffer, b: Buffer, context = 16): string {
  if (a.equals(b)) return ''
  const max = Math.max(a.length, b.length)
  let firstDiff = -1
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      firstDiff = i
      break
    }
  }
  const from = Math.max(0, firstDiff - context)
  const to = Math.min(max, firstDiff + context)
  const slice = (buf: Buffer) =>
    buf
      .subarray(from, to)
      .toString('hex')
      .replace(/(..)/g, '$1 ')
      .trim()
  return [
    `lengths: a=${a.length} b=${b.length}; first byte diff at offset ${firstDiff}`,
    `a[${from}..${to}]: ${slice(a)}`,
    `b[${from}..${to}]: ${slice(b)}`,
    `a(txt): ${JSON.stringify(a.subarray(from, to).toString('utf8'))}`,
    `b(txt): ${JSON.stringify(b.subarray(from, to).toString('utf8'))}`,
  ].join('\n')
}

/** Normalise a single captured message envelope to its stable serialized form. */
function normalizeEnvelope(parsed: unknown): string {
  const { normalized } = normalizeTranscript([{ dir: 'in', parsed }])
  return normalized[0]?.serialized ?? '{}'
}

/**
 * Capture the golden byte stream for one scenario against a running server.
 *
 * Full flow: handshake → terminal.create → terminal.attach → SETUP (excluded) →
 * START sentinel → payload lines → END sentinel → reassemble → extract → kill.
 * The caller owns the server lifecycle (boot + stop); this owns its own WS
 * client and the terminal it creates (killed before return).
 */
export async function capturePtyScenario(
  server: ExternalServerHandle,
  scenario: PtyScenario,
  options: PtyCaptureOptions = {},
): Promise<PtyCaptureResult> {
  const cols = options.cols ?? 120
  const rows = options.rows ?? 30
  const timeoutMs = options.timeoutMs ?? 20_000
  const sentinels: SentinelConfig = { ...DEFAULT_SENTINELS, ...options.sentinels }
  const log = options.log ?? (() => {})
  const setupLine = (options.setupTemplate ?? DEFAULT_SETUP_TEMPLATE).replace(
    '{setupDone}',
    sentinels.setupDone,
  )

  const client = new WsCaptureClient(server.wsUrl, server.token)
  let terminalId = ''
  try {
    await client.connect()
    // Advertise capabilities BEFORE captureHandshake drives the default hello, so the
    // server negotiates them (`ws-handler.ts:1846-1848`). With no capabilities, output
    // arrives as legacy `terminal.output`; with `terminalOutputBatchV1`, as
    // `terminal.output.batch`.
    if (options.capabilities) {
      client.sendHello({ capabilities: options.capabilities })
    }
    // Drive the full connect handshake (hello → … → terminal.inventory).
    await client.captureHandshake(timeoutMs)

    // 1) create the terminal (pinned shell enum; argv/env pinned via setup line)
    const createRequestId = `oracle-pty-create-${randomUUID()}`
    client.send({
      type: 'terminal.create',
      requestId: createRequestId,
      mode: scenario.mode,
      shell: scenario.shell,
    })
    const created = await client.waitForType('terminal.created', timeoutMs)
    const createdParsed = created.parsed as Record<string, unknown>
    terminalId = String(createdParsed.terminalId)
    if (!terminalId) throw new Error('terminal.created did not carry a terminalId')
    log(`created terminal ${terminalId} (req ${String(createdParsed.requestId)})`)

    // 2) attach to start the output stream (match spawn geometry → no resize)
    const attachRequestId = `oracle-pty-attach-${randomUUID()}`
    client.send({
      type: 'terminal.attach',
      terminalId,
      intent: 'viewport_hydrate',
      cols,
      rows,
      attachRequestId,
    })
    const attachReady = await client.waitForType('terminal.attach.ready', timeoutMs)
    const attachParsed = attachReady.parsed as Record<string, unknown>
    const streamId = String(attachParsed.streamId)
    if (!streamId) throw new Error('terminal.attach.ready did not carry a streamId')
    log(`attached stream ${streamId}`)

    // 3) SETUP (excluded from golden): neutralise echo/line-editing/prompt, then
    //    prove it took effect by waiting for the setupDone sentinel in OUTPUT.
    client.send({ type: 'terminal.input', terminalId, data: `${setupLine}\n` })
    await waitForOutputMarker(client, streamId, sentinels.setupDone, timeoutMs, 'setup-done')
    log('setup applied (echo + line-editing off, prompt cleared)')

    // 4) START sentinel, payload lines, END sentinel — all echo-free now.
    client.send({ type: 'terminal.input', terminalId, data: printfLine(sentinels.start) })
    for (const line of scenario.inputLines) {
      client.send({ type: 'terminal.input', terminalId, data: `${line}\n` })
    }
    client.send({ type: 'terminal.input', terminalId, data: printfLine(sentinels.end) })

    // 5) wait until the END sentinel lands (guarantees all payload bytes arrived,
    //    since the wire preserves byte order by seq), then reassemble + extract.
    const stream = await waitForOutputMarker(client, streamId, sentinels.end, timeoutMs, 'end-sentinel')
    const { frames, gaps, typeCounts, batches } = collectOutput(client, streamId)
    const reassembled = reassemble(frames)
    const { golden, reason } = extractGolden(reassembled, sentinels.start, sentinels.end)
    if (reason) {
      throw new Error(
        `Golden extraction failed for scenario "${scenario.name}": ${reason}. ` +
          `Reassembled ${reassembled.length} chars; head(hex)=${hexHead(Buffer.from(reassembled, 'utf8'), 96)}`,
      )
    }

    const goldenBytes = Buffer.from(golden, 'utf8')
    const sha256 = createHash('sha256').update(goldenBytes).digest('hex')
    log(`captured ${goldenBytes.length} golden bytes (sha256 ${sha256.slice(0, 12)}…), frames=${frames.length}`)

    return {
      scenario: scenario.name,
      goldenBytes,
      goldenText: golden,
      sha256,
      reassembledLength: reassembled.length,
      frameCount: frames.length,
      outputTypeCounts: typeCounts,
      terminalId,
      streamId,
      normalizedEnvelope: {
        created: normalizeEnvelope(created.parsed),
        attachReady: normalizeEnvelope(attachReady.parsed),
      },
      gaps,
      outputBatches: batches,
    }
  } finally {
    // Clean terminal teardown before the caller stops the server.
    try {
      if (terminalId) client.send({ type: 'terminal.kill', terminalId })
    } catch {
      /* socket may already be closing — server.stop() reaps regardless */
    }
    await client.close().catch(() => {})
  }
}
