/**
 * Offset-based incremental reader for Amplifier's `events.jsonl`.
 *
 * Tailer contract (docs/plans/2026-07-08-amplifier-session-durability-plan.md
 * §6): remembers a byte offset per file; on caller-driven reads (watcher
 * change or force-read — this module owns NO watchers), reads only appended
 * bytes via positional fd reads; buffers a partial trailing line until it is
 * completed; applies a cheap substring pre-filter before `JSON.parse` so the
 * ~450KB/turn of `content_block:*`/`tool:*` noise is skipped without parsing;
 * validates the schema once per file; `size < offset` means file reset —
 * degrade, never guess. Injected `fsImpl` for tests, imitating
 * `codex-app-server/durability-proof.ts`.
 */

import fsp from 'node:fs/promises'
import {
  checkAmplifierRecordSchema,
  type AmplifierParsedRecord,
} from './amplifier-events-reducer.js'

const READ_CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a

/**
 * Cap on the buffered partial-line remainder. Multi-MB `llm:request` lines are
 * NORMAL (plan §2 last row: full raw payloads are embedded), so an oversized
 * line never degrades the lane: the buffered bytes are dropped and the tailer
 * skips to the next newline, counting one skipped line (adversarial finding E).
 */
export const AMPLIFIER_TAILER_PARTIAL_MAX_BYTES = 8 * 1024 * 1024

/**
 * Cap on a single positional read batch so no `Buffer.concat` scales with the
 * file size (events files up to hundreds of MB exist). `readAppended` loops
 * over batches until the stat'd size is consumed.
 */
export const AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES = 16 * 1024 * 1024

/**
 * Lifecycle event-name prefixes the reducer cares about. Lines are checked
 * with plain substring scans (both `"event":"x` and `"event": "x` spellings —
 * the live CLI writes a space after the colon) so noise never reaches
 * JSON.parse.
 */
const EVENT_PREFIXES = ['session:', 'prompt:', 'execution:', 'orchestrator:steering'] as const

const PREFILTER_NEEDLES: string[] = EVENT_PREFIXES.flatMap((prefix) => [
  `"event":"${prefix}`,
  `"event": "${prefix}`,
])

export type AmplifierTailerFileHandle = {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export type AmplifierTailerFs = {
  open(path: string, flags: string): Promise<AmplifierTailerFileHandle>
  stat(path: string): Promise<{ size: number }>
}

export type AmplifierTailerDegradeReason = 'file_reset' | 'schema_mismatch' | 'read_error'

export type AmplifierTailerReadResult =
  | {
    ok: true
    records: AmplifierParsedRecord[]
    /** Complete lines dropped by the pre-filter (or unparseable). */
    skippedLines: number
    /** Bytes consumed from the file by this read (including buffered partial-line bytes). */
    bytesConsumed: number
    offset: number
  }
  | {
    ok: false
    reason: AmplifierTailerDegradeReason
    message: string
  }

export type AmplifierTailerAttachResult =
  | { ok: true; offset: number }
  | { ok: false; reason: AmplifierTailerDegradeReason; message: string }

export type AmplifierEventsTailer = {
  attach(): Promise<AmplifierTailerAttachResult>
  /** Incremental read of appended bytes. Driven by callers (watcher change in Phase 2). */
  read(): Promise<AmplifierTailerReadResult>
  /** Missed-signal failsafe entry point (deadman force-read): stat + manual incremental read. */
  forceRead(): Promise<AmplifierTailerReadResult>
  getOffset(): number
  /** Bytes currently held in the partial-line buffer (diagnostics/tests). */
  getBufferedBytes(): number
}

export function createAmplifierEventsTailer(input: {
  filePath: string
  /** 'start' = fresh session (offset 0); 'eof' = resume attach (E7). */
  attachAt: 'start' | 'eof'
  fsImpl?: AmplifierTailerFs
  log?: { debug?: (payload: object, message?: string) => void }
}): AmplifierEventsTailer {
  const fsImpl: AmplifierTailerFs = input.fsImpl ?? defaultFs()
  const filePath = input.filePath

  let offset = 0
  let partial: Buffer = Buffer.alloc(0)
  // True while discarding the tail of an oversized line (partial cap overflow):
  // bytes are dropped until the next newline, then parsing resumes.
  let skippingOversizedLine = false
  let oversizedLineLogged = false
  let schemaValidated = false
  let degraded: { reason: AmplifierTailerDegradeReason; message: string } | undefined
  let chain: Promise<unknown> = Promise.resolve()

  const degrade = (
    reason: AmplifierTailerDegradeReason,
    message: string,
  ): { ok: false; reason: AmplifierTailerDegradeReason; message: string } => {
    degraded = { reason, message }
    return { ok: false, reason, message }
  }

  async function readAppended(): Promise<AmplifierTailerReadResult> {
    if (degraded) return { ok: false, ...degraded }

    let size: number
    try {
      size = (await fsImpl.stat(filePath)).size
    } catch (error) {
      return degrade('read_error', `Could not stat amplifier events file: ${errorMessage(error)}`)
    }

    if (size < offset) {
      return degrade(
        'file_reset',
        `Amplifier events file shrank (size ${size} < offset ${offset}); refusing to guess.`,
      )
    }
    if (size === offset) {
      return { ok: true, records: [], skippedLines: 0, bytesConsumed: 0, offset }
    }

    const records: AmplifierParsedRecord[] = []
    let skippedLines = 0
    let bytesConsumed = 0

    // Bounded batches: no single Buffer.concat scales with the backlog size
    // (adversarial finding E — events files of hundreds of MB exist).
    while (offset < size) {
      const batchLength = Math.min(size - offset, AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES)
      let appended: Buffer
      try {
        appended = await readRange(fsImpl, filePath, offset, batchLength)
      } catch (error) {
        return degrade('read_error', `Could not read amplifier events file: ${errorMessage(error)}`)
      }
      if (appended.length === 0) break
      bytesConsumed += appended.length
      offset += appended.length

      let chunk = appended
      if (skippingOversizedLine) {
        const newlineIndex = chunk.indexOf(NEWLINE)
        if (newlineIndex === -1) continue // still inside the oversized line: drop bytes
        skippingOversizedLine = false
        skippedLines += 1 // the dropped oversized line finally ended
        chunk = chunk.subarray(newlineIndex + 1)
      }

      const combined = partial.length > 0 ? Buffer.concat([partial, chunk]) : chunk
      const { lines, remainder } = splitCompleteLines(combined)
      if (remainder.length > AMPLIFIER_TAILER_PARTIAL_MAX_BYTES) {
        // Oversized line (multi-MB llm:request payloads are normal): drop the
        // buffered bytes and skip to the next newline. Never degrade the lane.
        partial = Buffer.alloc(0)
        skippingOversizedLine = true
        if (!oversizedLineLogged) {
          oversizedLineLogged = true
          input.log?.debug?.({
            component: 'amplifier-events-tailer',
            event: 'amplifier_tailer_oversized_line_dropped',
            filePath,
            bufferedBytes: remainder.length,
          }, 'Amplifier events line exceeded the partial-buffer cap; dropping to next newline.')
        }
      } else {
        partial = remainder
      }

      for (const lineBuffer of lines) {
        const line = lineBuffer.toString('utf8').replace(/\r$/, '')
        if (line.trim().length === 0) continue
        if (!matchesPrefilter(line)) {
          skippedLines += 1
          continue
        }
        let record: AmplifierParsedRecord
        try {
          record = JSON.parse(line) as AmplifierParsedRecord
        } catch {
          skippedLines += 1
          continue
        }
        if (!schemaValidated) {
          const failure = checkAmplifierRecordSchema(record)
          if (failure) {
            return degrade(
              'schema_mismatch',
              `Amplifier events schema gate failed (${failure}); expected amplifier.log major version 1.`,
            )
          }
          schemaValidated = true
        }
        records.push(record)
      }
    }

    return { ok: true, records, skippedLines, bytesConsumed, offset }
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  return {
    async attach() {
      return serialize(async (): Promise<AmplifierTailerAttachResult> => {
        if (degraded) return { ok: false, ...degraded }
        if (input.attachAt === 'eof') {
          try {
            offset = (await fsImpl.stat(filePath)).size
          } catch (error) {
            return degrade(
              'read_error',
              `Could not stat amplifier events file for EOF attach: ${errorMessage(error)}`,
            )
          }
        } else {
          offset = 0
        }
        partial = Buffer.alloc(0)
        skippingOversizedLine = false
        return { ok: true, offset }
      })
    },
    read() {
      return serialize(readAppended)
    },
    forceRead() {
      // Same stat + manual incremental read; a distinct entry point so the
      // Phase 2 deadman failsafe (WSL2 inotify backstop) reads the tail
      // without a watcher event.
      return serialize(readAppended)
    },
    getOffset() {
      return offset
    },
    getBufferedBytes() {
      return partial.length
    },
  }
}

function matchesPrefilter(line: string): boolean {
  for (const needle of PREFILTER_NEEDLES) {
    if (line.includes(needle)) return true
  }
  return false
}

function splitCompleteLines(buffer: Buffer): { lines: Buffer[]; remainder: Buffer } {
  const lines: Buffer[] = []
  let start = 0
  while (start < buffer.length) {
    const newlineIndex = buffer.indexOf(NEWLINE, start)
    if (newlineIndex === -1) break
    lines.push(buffer.subarray(start, newlineIndex))
    start = newlineIndex + 1
  }
  return { lines, remainder: buffer.subarray(start) }
}

async function readRange(
  fsImpl: AmplifierTailerFs,
  filePath: string,
  position: number,
  length: number,
): Promise<Buffer> {
  const handle = await fsImpl.open(filePath, 'r')
  const chunks: Buffer[] = []
  let bytesSeen = 0
  try {
    while (bytesSeen < length) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, length - bytesSeen))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position + bytesSeen)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      bytesSeen += bytesRead
    }
  } finally {
    await handle.close()
  }
  return Buffer.concat(chunks)
}

function defaultFs(): AmplifierTailerFs {
  return {
    open: (path, flags) => fsp.open(path, flags),
    stat: (path) => fsp.stat(path),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
