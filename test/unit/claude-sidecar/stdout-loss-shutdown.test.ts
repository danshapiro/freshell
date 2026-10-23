// @vitest-environment node

// The real sidecar (index.mjs), driven through the FRESHELL_CLAUDE_SDK_QUERY_MODULE
// seam, losing its stdout reader mid-turn. Rust drops that reader whenever it
// aborts a session's stdout consumer (a pane kill, a handoff stop), which can
// happen before it writes the shutdown line. A sidecar that is still streaming
// then writes into a pipe nobody reads. It must treat that like stdin EOF:
// stop its SDK query (which stops the claude CLI) and exit 0, instead of dying
// on an uncaught EPIPE and leaving the CLI running the turn.

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { BOOT_FAILED_EXIT_CODE } from '../../../crates/freshell-claude-sidecar/boot.mjs'
import { STREAM_ENDED_EXIT_CODE } from '../../../crates/freshell-claude-sidecar/stream-end.mjs'
import { SIDECAR_INDEX, startRealSidecar, type RealSidecar } from './harness'

const children = new Set<ChildProcess>()
const directories: string[] = []
afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('Claude sidecar with a lost stdout reader', () => {
  it('stops its SDK query and exits 0 when the stdout reader goes away mid-stream', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sidecar-stdout-loss-'))
    directories.push(directory)
    const record = path.join(directory, 'sdk-record.txt')
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../crates/freshell-claude-sidecar/index.mjs', import.meta.url))], {
      env: {
        ...process.env,
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: fileURLToPath(new URL('./fixtures/streaming-query-module.mjs', import.meta.url)),
        FRESHELL_TEST_SDK_RECORD: record,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.add(child)
    let stderr = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const frames: Record<string, any>[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => frames.push(JSON.parse(line)))
    const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`)

    send({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId: 'create', model: 'opus' })
    await expect.poll(() => frames.find((frame) => frame.type === 'created'), { timeout: 5_000 }).toBeTruthy()
    const { sessionId } = frames.find((frame) => frame.type === 'created')!
    send({ type: 'send', sessionId, uuid: randomUUID(), text: 'stream until stopped' })
    await expect.poll(() => frames.filter((frame) => frame.type === 'sdk.stream').length, { timeout: 5_000 }).toBeGreaterThan(2)

    child.stdout!.destroy()

    let timer: NodeJS.Timeout | undefined
    const exit = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the sidecar kept running without a stdout reader; stderr=${stderr}`)), 5_000)
      }),
    ]).finally(() => clearTimeout(timer))
    expect(exit, stderr).toEqual({ code: 0, signal: null })
    expect(fs.readFileSync(record, 'utf8').split('\n'), stderr).toEqual(expect.arrayContaining(['aborted', 'closed']))
    // The server re-emits this record at its severity (claude_sidecar_io.rs);
    // it is the one log line that says why the sidecar stopped on its own.
    const records = stderr.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    expect(records.filter((entry) => entry.event === 'stdout.closed'), stderr).toEqual([
      expect.objectContaining({ severity: 'warn', component: 'claude-sidecar', event: 'stdout.closed', code: 'EPIPE', error: expect.any(String) }),
    ])
  })
})

/** The sidecar's JSONL log records (stderr); other stderr lines are skipped. */
function logRecords(stderr: string): Record<string, any>[] {
  return stderr.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/**
 * The production sidecar behind a slow stderr reader: its exit flush (the
 * wait of a sidecar exiting on its own) takes half a second, so the stdout
 * error of a write into a readerless pipe arrives while it is still exiting.
 *
 * Its stdout reader lives in a relay process (stdout-reader-relay.mjs), not
 * in this test process: these cases need the ONE write the sidecar makes
 * after losing its reader to fail with EPIPE, and a child this process spawns
 * for another test file holds a copy of every descriptor here until it execs,
 * long enough for that write to land in the copy instead.
 */
function startWithSlowStderr() {
  return startRealSidecar({
    entry: fileURLToPath(new URL('./fixtures/stdout-reader-relay.mjs', import.meta.url)),
    env: {
      RELAY_ENTRY: fileURLToPath(new URL('./fixtures/slow-stderr-flush-entry.mjs', import.meta.url)),
      SIDECAR_INDEX_PATH: SIDECAR_INDEX,
      STDERR_FLUSH_DELAY_MS: '500',
    },
  })
}

/** Close the only reader of the sidecar's stdout, and wait until it is closed. */
async function dropStdoutReader(sidecar: RealSidecar) {
  await sidecar.waitFor('relay.ready', 'the relay to handle SIGUSR2')
  sidecar.child.kill('SIGUSR2')
  await sidecar.waitFor('relay.reader_dropped', 'the relay to close its stdout reader')
}

// A sidecar that is already exiting on its own (its SDK stream ended, exit 3;
// its boot was refused, exit 2) has closed its query. Losing its stdout reader
// then changes nothing: it logs `stdout.closed` and keeps its own exit code,
// so the Rust side reads why it ended instead of a graceful stop (exit 0).
describe('Claude sidecar losing its stdout reader while it exits on its own', () => {
  it('a stream that ends after the reader went away still exits 3', async () => {
    const sidecar = await startWithSlowStderr()
    await sidecar.create()
    const { cliPid } = await sidecar.waitForBoot()
    // The boot catalog is the last line an idle session writes.
    await sidecar.waitFor((frame) => frame.type === 'sdk.session.changed', 'the boot catalog')

    await dropStdoutReader(sidecar)
    // The CLI dies under the idle session: sdk.stream.ended is the first write
    // into the readerless pipe, made by a sidecar already exiting with code 3.
    process.kill(cliPid, 'SIGKILL')

    expect(await sidecar.waitExit(), sidecar.stderr()).toEqual({ code: STREAM_ENDED_EXIT_CODE, signal: null })
    const records = logRecords(sidecar.stderr())
    expect(records.filter((entry) => entry.event === 'stdout.closed'), sidecar.stderr()).toEqual([
      expect.objectContaining({ severity: 'warn', event: 'stdout.closed', code: 'EPIPE' }),
    ])
    expect(records.filter((entry) => entry.event === 'stream.ended'), sidecar.stderr()).toEqual([
      expect.objectContaining({ reason: 'cli_exited' }),
    ])
  })

  it('a boot refused after the reader went away still exits 2', async () => {
    const sidecar = await startWithSlowStderr()
    await dropStdoutReader(sidecar)
    // A create that does not speak protocol 2 is refused at once: create.failed
    // is the first write into the readerless pipe.
    sidecar.send({ type: 'create', protocol: 1, boot: { kind: 'fresh' }, requestId: 'create', cwd: sidecar.cwd })

    expect(await sidecar.waitExit(), sidecar.stderr()).toEqual({ code: BOOT_FAILED_EXIT_CODE, signal: null })
    const records = logRecords(sidecar.stderr())
    expect(records.filter((entry) => entry.event === 'stdout.closed'), sidecar.stderr()).toEqual([
      expect.objectContaining({ severity: 'warn', event: 'stdout.closed', code: 'EPIPE' }),
    ])
    expect(records.filter((entry) => entry.event === 'boot.failed'), sidecar.stderr()).toEqual([
      expect.objectContaining({ code: 'SIDECAR_PROTOCOL_MISMATCH' }),
    ])
  })
})
