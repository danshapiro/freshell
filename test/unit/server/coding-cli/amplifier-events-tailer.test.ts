import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AMPLIFIER_TAILER_PARTIAL_MAX_BYTES,
  AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES,
  createAmplifierEventsTailer,
  type AmplifierTailerFs,
  type AmplifierTailerReadResult,
} from '../../../../server/coding-cli/amplifier-events-tailer.js'

const SCHEMA = '"schema": {"name": "amplifier.log", "ver": "1.0.0"}'

function line(event: string, extra = ''): string {
  return `{"ts": "2026-07-08T15:50:50.757003704+00:00", "lvl": "INFO", ${SCHEMA}, `
    + `"event": "${event}", "session_id": "session-1", "data": {"parent_id": null${extra}}}\n`
}

type FakeFs = AmplifierTailerFs & {
  append(text: string): void
  truncate(bytes: number): void
  readCalls: Array<{ position: number; length: number }>
}

function createFakeFs(initial = ''): FakeFs {
  let content = Buffer.from(initial, 'utf8')
  const readCalls: Array<{ position: number; length: number }> = []
  return {
    readCalls,
    append(text: string) {
      content = Buffer.concat([content, Buffer.from(text, 'utf8')])
    },
    truncate(bytes: number) {
      content = content.subarray(0, bytes)
    },
    async stat() {
      return { size: content.length }
    },
    async open() {
      return {
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          readCalls.push({ position, length })
          const slice = content.subarray(position, position + length)
          slice.copy(buffer, offset)
          return { bytesRead: slice.length }
        },
        async close() {},
      }
    },
  }
}

function okRecords(result: AmplifierTailerReadResult): string[] {
  if (!result.ok) throw new Error(`expected ok read, got degrade: ${result.reason}`)
  return result.records.map((record) => record.event)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('amplifier events tailer', () => {
  it('attaches at offset 0 (fresh) and parses lifecycle records in order', async () => {
    const fsImpl = createFakeFs(
      line('session:start')
      + line('session:config')
      + line('prompt:submit')
      + line('execution:start')
      + line('prompt:complete'),
    )
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    const attached = await tailer.attach()
    expect(attached).toEqual({ ok: true, offset: 0 })

    const result = await tailer.read()
    expect(okRecords(result)).toEqual([
      'session:start',
      'session:config',
      'prompt:submit',
      'execution:start',
      'prompt:complete',
    ])
  })

  it('attaches at EOF (resume) and only sees records appended afterwards', async () => {
    const historical = line('session:start') + line('session:config') + line('prompt:submit') + line('prompt:complete')
    const fsImpl = createFakeFs(historical)
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'eof' })
    const attached = await tailer.attach()
    expect(attached).toEqual({ ok: true, offset: Buffer.byteLength(historical) })

    const empty = await tailer.read()
    expect(okRecords(empty)).toEqual([])

    fsImpl.append(line('session:resume') + line('prompt:submit'))
    const appended = await tailer.read()
    expect(okRecords(appended)).toEqual(['session:resume', 'prompt:submit'])
  })

  it('reads only appended bytes on subsequent reads (never re-reads consumed bytes)', async () => {
    const first = line('session:start')
    const fsImpl = createFakeFs(first)
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()
    okRecords(await tailer.read())

    fsImpl.readCalls.length = 0
    fsImpl.append(line('prompt:submit'))
    const result = await tailer.read()
    expect(okRecords(result)).toEqual(['prompt:submit'])
    expect(fsImpl.readCalls.length).toBeGreaterThan(0)
    for (const call of fsImpl.readCalls) {
      expect(call.position).toBeGreaterThanOrEqual(Buffer.byteLength(first))
    }
  })

  it('does not open the file at all when size has not grown', async () => {
    const fsImpl = createFakeFs(line('session:start'))
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()
    okRecords(await tailer.read())

    fsImpl.readCalls.length = 0
    const result = await tailer.read()
    expect(okRecords(result)).toEqual([])
    expect(fsImpl.readCalls).toEqual([])
  })

  it('buffers a partial trailing line until it is completed', async () => {
    const whole = line('prompt:submit')
    const cut = 40
    const fsImpl = createFakeFs(line('session:start') + whole.slice(0, cut))
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()

    const first = await tailer.read()
    expect(okRecords(first)).toEqual(['session:start'])

    // Still partial: nothing new, no torn parse.
    const second = await tailer.read()
    expect(okRecords(second)).toEqual([])

    fsImpl.append(whole.slice(cut))
    const third = await tailer.read()
    expect(okRecords(third)).toEqual(['prompt:submit'])
  })

  it('pre-filters noise lines without calling JSON.parse on them', async () => {
    const fsImpl = createFakeFs(
      line('session:start')
      + line('prompt:submit')
      + line('llm:request', ', "raw": "big"')
      + line('llm:response')
      + line('content_block:start')
      + line('content_block:end')
      + line('tool:pre')
      + line('tool:post')
      + line('mentions:resolved')
      + line('provider:request')
      + line('provider:retry')
      + line('cleanup:render_begin')
      + line('orchestrator:complete')
      + line('orchestrator:steering_injected')
      + line('execution:end')
      + line('prompt:complete'),
    )
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()

    const parseSpy = vi.spyOn(JSON, 'parse')
    const result = await tailer.read()

    // session:start, prompt:submit, orchestrator:steering_injected, execution:end, prompt:complete
    expect(okRecords(result)).toEqual([
      'session:start',
      'prompt:submit',
      'orchestrator:steering_injected',
      'execution:end',
      'prompt:complete',
    ])
    expect(parseSpy).toHaveBeenCalledTimes(5)
    if (!result.ok) throw new Error('unreachable')
    expect(result.skippedLines).toBe(11)
  })

  it('degrades with file_reset when size < offset, and stays degraded', async () => {
    const initial = line('session:start') + line('prompt:submit')
    const fsImpl = createFakeFs(initial)
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()
    okRecords(await tailer.read())

    fsImpl.truncate(10)
    const reset = await tailer.read()
    expect(reset.ok).toBe(false)
    if (reset.ok) throw new Error('unreachable')
    expect(reset.reason).toBe('file_reset')

    fsImpl.append(line('prompt:complete'))
    const after = await tailer.read()
    expect(after.ok).toBe(false)
    if (after.ok) throw new Error('unreachable')
    expect(after.reason).toBe('file_reset')
  })

  it('degrades with schema_mismatch when the first parsed record fails the schema gate', async () => {
    const fsImpl = createFakeFs(
      '{"ts": "2026-07-08T15:50:50.757003704+00:00", "schema": {"name": "amplifier.log", "ver": "2.0.0"}, '
      + '"event": "session:start", "session_id": "session-1", "data": {"parent_id": null}}\n',
    )
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()

    const result = await tailer.read()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('schema_mismatch')
  })

  it('validates the schema only once per file (single gate on first parsed record)', async () => {
    const fsImpl = createFakeFs(line('session:start'))
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()
    okRecords(await tailer.read())

    // A later record with a bad schema does not degrade the tailer; per-record
    // gating is the reducer's job (the tailer validates the file header once).
    fsImpl.append(
      '{"ts": "2026-07-08T15:50:51.000000000+00:00", "schema": {"name": "amplifier.log", "ver": "2.0.0"}, '
      + '"event": "prompt:submit", "session_id": "session-1", "data": {"parent_id": null}}\n',
    )
    const result = await tailer.read()
    expect(okRecords(result)).toEqual(['prompt:submit'])
  })

  it('degrades with read_error when the file cannot be statted', async () => {
    const fsImpl = createFakeFs('')
    fsImpl.stat = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()

    const result = await tailer.read()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('read_error')
  })

  it('forceRead() reads the tail without any watcher having fired', async () => {
    const fsImpl = createFakeFs(line('session:start'))
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()
    okRecords(await tailer.read())

    fsImpl.append(line('prompt:complete'))
    const result = await tailer.forceRead()
    expect(okRecords(result)).toEqual(['prompt:complete'])
  })

  it('caps the partial-line buffer: a 10MB no-newline stream is dropped, later lines still parse', async () => {
    // Multi-MB llm:request lines are normal (plan §2 last row): the tailer must
    // bound its remainder buffer instead of retaining the whole line.
    const oversized = 'x'.repeat(10 * 1024 * 1024)
    const fsImpl = createFakeFs(line('session:start') + oversized)
    const debug = vi.fn()
    const tailer = createAmplifierEventsTailer({
      filePath: '/fake/events.jsonl',
      fsImpl,
      attachAt: 'start',
      log: { debug },
    })
    await tailer.attach()

    const first = await tailer.read()
    expect(okRecords(first)).toEqual(['session:start'])
    // Buffered bytes stay bounded (the oversized partial is dropped outright).
    expect(tailer.getBufferedBytes()).toBeLessThanOrEqual(AMPLIFIER_TAILER_PARTIAL_MAX_BYTES)
    expect(debug).toHaveBeenCalledTimes(1)

    // Completing the oversized line and appending a valid record: the oversized
    // line counts as skipped, the lane does NOT degrade, and parsing resumes.
    fsImpl.append('tail-of-oversized-line\n' + line('prompt:submit'))
    const second = await tailer.read()
    expect(okRecords(second)).toEqual(['prompt:submit'])
    if (!second.ok) throw new Error('unreachable')
    expect(second.skippedLines).toBe(1)
    expect(tailer.getBufferedBytes()).toBe(0)
  })

  it('reads large appends in bounded batches without splitting records across batch boundaries', async () => {
    // > one read batch of noise so readAppended must loop; lifecycle records on
    // both sides of the batch boundary must still parse exactly once.
    const noise = line('content_block:start').repeat(
      Math.ceil((AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES + 64 * 1024) / line('content_block:start').length),
    )
    const fsImpl = createFakeFs(line('session:start') + noise + line('prompt:complete'))
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()

    const result = await tailer.read()
    expect(okRecords(result)).toEqual(['session:start', 'prompt:complete'])
    if (!result.ok) throw new Error('unreachable')
    expect(result.offset).toBe(tailer.getOffset())
    // Every positional read stays within the batch bound.
    for (const call of fsImpl.readCalls) {
      expect(call.length).toBeLessThanOrEqual(AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES)
    }
  })

  it('tracks the byte offset across reads, including buffered partial bytes', async () => {
    const first = line('session:start')
    const partial = '{"ts": "2026-07-08T15:'
    const fsImpl = createFakeFs(first + partial)
    const tailer = createAmplifierEventsTailer({ filePath: '/fake/events.jsonl', fsImpl, attachAt: 'start' })
    await tailer.attach()
    await tailer.read()

    // Offset covers everything read so far (partial bytes live in the buffer).
    expect(tailer.getOffset()).toBe(Buffer.byteLength(first + partial))
  })
})
