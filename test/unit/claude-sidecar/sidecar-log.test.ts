// @vitest-environment node
//
// The claude sidecar's structured log (crates/freshell-claude-sidecar/log.mjs,
// G14): every stderr line is one JSON record with a real severity, an event
// name and ids, never prompt text. The Rust side re-emits each record through
// `tracing` at that severity (claude_sidecar_io.rs), so a wrong severity or a
// missing event name is a wrong server log line.
//
// The pure module is tested directly; the sidecar's own records are read from
// the real index.mjs running over the CLI simulator (harness.ts).

import { describe, expect, it } from 'vitest'
import { CLI_STDERR_MAX_BYTES, cliStderrLogger, createLog, errorText, isHostedSidecar } from '../../../crates/freshell-claude-sidecar/log.mjs'
import { startRealSidecar, type RealSidecar } from './harness'

const SEVERITIES = ['debug', 'info', 'warn', 'error']

/** A log function that records the lines it would have written. */
function capturedLog(component = 'test-component') {
  const lines: string[] = []
  const log = createLog(component, (line: string) => { lines.push(line) })
  const records = () => lines.map((line) => {
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    return JSON.parse(line)
  })
  return { log, lines, records }
}

/** Every stderr line of the sidecar so far, parsed (each one must be a JSON record). */
function stderrRecords(sidecar: Pick<RealSidecar, 'stderr'>): Record<string, any>[] {
  return sidecar.stderr().split('\n').filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line) } catch { throw new Error(`a stderr line is not a JSON record: ${line}`) }
  })
}

/** The first stderr record matching `predicate`; stderr is its own pipe, so it may trail stdout. */
async function waitForRecord(sidecar: RealSidecar, label: string, predicate: (record: Record<string, any>) => boolean) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const hit = stderrRecords(sidecar).find(predicate)
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`no stderr record ${label}; stderr=${sidecar.stderr().slice(-2000)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('log.mjs', () => {
  it('writes one JSON record per line with the severity, component, event and fields', () => {
    const { log, records } = capturedLog('claude-sidecar')
    log('info', 'sidecar.ready', { pid: 42 })
    log('error', 'stream.consume_failed', { sessionId: 's-1', error: 'boom' })
    expect(records()).toEqual([
      { severity: 'info', component: 'claude-sidecar', event: 'sidecar.ready', pid: 42 },
      { severity: 'error', component: 'claude-sidecar', event: 'stream.consume_failed', sessionId: 's-1', error: 'boom' },
    ])
  })

  it('keeps severity, component and event from being overwritten by fields', () => {
    const { log, records } = capturedLog('claude-sidecar')
    log('debug', 'x.happened', { severity: 'error', component: 'other', event: 'y', extra: 1 })
    expect(records()).toEqual([{ severity: 'debug', component: 'claude-sidecar', event: 'x.happened', extra: 1 }])
  })

  it('logs an unknown severity at warn and says what it was', () => {
    const { log, records } = capturedLog()
    log('loud' as any, 'x.happened')
    expect(records()).toEqual([{ severity: 'warn', component: 'test-component', event: 'x.happened', invalidSeverity: 'loud' }])
  })

  it('still writes a record when a field cannot be serialized', () => {
    const { log, records } = capturedLog()
    expect(() => log('warn', 'x.happened', { big: 10n })).not.toThrow()
    const [record] = records()
    expect(record).toMatchObject({ severity: 'warn', component: 'test-component', event: 'x.happened' })
    expect(typeof record.unserializable).toBe('string')
  })

  it('renders errors as their message', () => {
    expect(errorText(new Error('nope'))).toBe('nope')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(undefined)).toBe('undefined')
  })

  it('treats any FRESHELL_HOSTED_FRESH_AGENT value as a hosted sidecar (claude and kilroy alike)', () => {
    expect(isHostedSidecar({ FRESHELL_HOSTED_FRESH_AGENT: 'claude' })).toBe(true)
    expect(isHostedSidecar({ FRESHELL_HOSTED_FRESH_AGENT: 'kilroy' })).toBe(true)
    expect(isHostedSidecar({ FRESHELL_HOSTED_FRESH_AGENT: '' })).toBe(false)
    expect(isHostedSidecar({})).toBe(false)
  })

  it('logs CLI stderr at info, cut to 2 KiB with the full byte count', () => {
    const { log, records } = capturedLog('claude-sidecar')
    const onStderr = cliStderrLogger(log, { hosted: false, fields: { sessionId: 's-1' } })
    onStderr('a short warning\n')
    const long = `${'é'.repeat(CLI_STDERR_MAX_BYTES)}\n`
    onStderr(long)
    const [short, cut] = records()
    expect(short).toEqual({ severity: 'info', component: 'claude-sidecar', event: 'cli.stderr', sessionId: 's-1', text: 'a short warning' })
    expect(cut).toMatchObject({ severity: 'info', event: 'cli.stderr', sessionId: 's-1', truncated: true, bytes: Buffer.byteLength(long) })
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(CLI_STDERR_MAX_BYTES)
    expect(cut.text).toBe('é'.repeat(CLI_STDERR_MAX_BYTES / 2))
  })

  it('logs only the byte count of CLI stderr in hosted mode', () => {
    const { log, records } = capturedLog('claude-sidecar')
    cliStderrLogger(log, { hosted: true, fields: { sessionId: 's-1' } })('secret-looking stderr\n')
    expect(records()).toEqual([{ severity: 'info', component: 'claude-sidecar', event: 'cli.stderr', sessionId: 's-1', bytes: 22 }])
  })
})

describe('the sidecar log', () => {
  it('announces ready at info', async () => {
    const sidecar = await startRealSidecar()
    const ready = await waitForRecord(sidecar, 'sidecar.ready', (record) => record.event === 'sidecar.ready')
    expect(ready).toMatchObject({ severity: 'info', component: 'claude-sidecar', event: 'sidecar.ready', pid: sidecar.child.pid })
    expect(stderrRecords(sidecar)[0]).toEqual(ready)
  })

  it('logs a refused configure at warn with its ids', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await sidecar.create()
    sidecar.send({ type: 'configure', sessionId, requestId: 'bad-mode', settings: { permissionMode: 'no-such-mode' } })
    expect(await sidecar.waitFor('sdk.configured')).toMatchObject({ ok: false })
    const failed = await waitForRecord(sidecar, 'configure.failed', (record) => record.event === 'configure.failed')
    expect(failed).toMatchObject({ severity: 'warn', component: 'claude-sidecar', sessionId, requestId: 'bad-mode' })
    expect(failed.error).toContain('Cannot set permission mode')
  })

  it('logs answers to unknown permission and question requests at warn', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await sidecar.create()
    sidecar.sendLines([
      { type: 'permission.respond', sessionId, requestId: 'no-such-permission', decision: { behavior: 'allow' } },
      { type: 'permission.respond', sessionId, requestId: 'no-decision' },
      { type: 'question.respond', sessionId, requestId: 'no-such-question', answers: {} },
    ])
    const unknownPermission = await waitForRecord(sidecar, 'respond.unknown permission', (record) => record.event === 'respond.unknown' && record.kind === 'permission')
    expect(unknownPermission).toMatchObject({ severity: 'warn', sessionId, requestId: 'no-such-permission' })
    const invalid = await waitForRecord(sidecar, 'respond.invalid', (record) => record.event === 'respond.invalid')
    expect(invalid).toMatchObject({ severity: 'warn', kind: 'permission', sessionId, requestId: 'no-decision' })
    const unknownQuestion = await waitForRecord(sidecar, 'respond.unknown question', (record) => record.event === 'respond.unknown' && record.kind === 'question')
    expect(unknownQuestion).toMatchObject({ severity: 'warn', sessionId, requestId: 'no-such-question' })
  })

  it('logs a bad request line by its size only, and an unknown request type by its type', async () => {
    const sidecar = await startRealSidecar()
    const secret = 'PROMPT-TEXT-MUST-NOT-BE-LOGGED'
    const garbled = `{"type":"send","text":"${secret}"`
    sidecar.child.stdin!.write(`${garbled}\n`)
    sidecar.send({ type: 'no.such.request' })
    const unparseable = await waitForRecord(sidecar, 'request.unparseable', (record) => record.event === 'request.unparseable')
    expect(unparseable).toEqual({ severity: 'warn', component: 'claude-sidecar', event: 'request.unparseable', bytes: Buffer.byteLength(garbled) })
    const unknown = await waitForRecord(sidecar, 'request.unknown_type', (record) => record.event === 'request.unknown_type')
    expect(unknown).toMatchObject({ severity: 'warn', requestType: 'no.such.request' })
    expect(sidecar.stderr()).not.toContain(secret)
  })

  it('logs an SDK stream that ends in an error at warn, with the error', async () => {
    const sidecar = await startRealSidecar({ program: { rules: [{ on: 'msg:prompt', emit: [{ kind: 'crash' }] }] } })
    const sessionId = await sidecar.create()
    sidecar.send({ type: 'send', sessionId, text: 'hello' })
    const ended = await waitForRecord(sidecar, 'stream.ended', (record) => record.event === 'stream.ended')
    expect(ended).toMatchObject({ severity: 'warn', component: 'claude-sidecar', sessionId, reason: 'stream_error' })
    expect(ended.error).toContain('terminated by signal SIGKILL')
  })

  it('writes only JSON records with a real severity and an event name', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await sidecar.create()
    sidecar.send({ type: 'send', sessionId, text: 'hello' })
    await sidecar.waitFor('sdk.result')
    sidecar.send({ type: 'no.such.request' })
    await waitForRecord(sidecar, 'request.unknown_type', (record) => record.event === 'request.unknown_type')
    const records = stderrRecords(sidecar)
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(SEVERITIES).toContain(record.severity)
      expect(typeof record.event).toBe('string')
      expect(record.component).toBe('claude-sidecar')
    }
    expect(sidecar.stderr()).not.toContain('hello')
  })
})
