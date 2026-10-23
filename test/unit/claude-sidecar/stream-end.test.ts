// @vitest-environment node

// The sidecar's end of stream (G02, G23; design §5.1 and §5.7 of
// docs/plans/2026-10-22-freshclaude-core-runtime.md). Each sidecar hosts one
// session, so when its SDK message stream ends without being asked to, the
// sidecar is done: it reports how the stream ended in `sdk.stream.ended`, its
// last stdout line, and exits with code 3. The Rust server's end-of-output path
// then ends the session. A requested teardown (shutdown, stdin closing) exits 0
// and reports nothing about the stream.
//
// Driven through the production index.mjs over the CLI simulator (harness.ts),
// plus the pure `streamEnd` classification on the SDK's exact error strings
// (claude-cli-contract.test.ts pins the CLI-death message, T14).

import { describe, expect, it } from 'vitest'
import { STREAM_ENDED_EXIT_CODE, streamEnd } from '../../../crates/freshell-claude-sidecar/stream-end.mjs'
import { startRealSidecar, type RealSidecar, type SidecarFrame } from './harness'

const ALERT_FRAMES = new Set(['sdk.stream.ended', 'sdk.turn.complete', 'sdk.error', 'sdk.status'])

/**
 * A frame that reports an end or a status the client shows. A model request
 * (`sdk.status requesting`) and the end of a status (`null`) are lifecycle
 * facts for the server's turn accounting (lifecycle-frames.mjs), not alerts.
 */
function isAlertFrame(frame: SidecarFrame): boolean {
  if (frame.type === 'sdk.status' && (frame.status === 'requesting' || frame.status === null)) return false
  return ALERT_FRAMES.has(frame.type)
}

/** The statuses the client is shown, in order. */
function shownStatuses(sidecar: RealSidecar): unknown[] {
  return framesOf(sidecar, 'sdk.status').filter(isAlertFrame).map((frame) => frame.status)
}

/** A session whose simulated CLI has booted, with nothing in flight. */
async function bootedSession(sidecar: RealSidecar) {
  const sessionId = await sidecar.create()
  await sidecar.waitForBoot()
  return sessionId
}

function framesOf(sidecar: RealSidecar, type: string): SidecarFrame[] {
  return sidecar.frames.filter((frame) => frame.type === type)
}

describe('streamEnd', () => {
  it('names a CLI death by the SDK\'s own message (a signal or an exit code)', () => {
    expect(streamEnd({ error: new Error('Claude Code process terminated by signal SIGKILL') }))
      .toEqual({ reason: 'cli_exited', message: 'Claude Code process terminated by signal SIGKILL' })
    expect(streamEnd({ error: new Error('Claude Code process exited with code 143') }))
      .toEqual({ reason: 'cli_exited', message: 'Claude Code process exited with code 143' })
  })

  it('calls any other error a stream error, keeping its message', () => {
    expect(streamEnd({ error: new Error('Unexpected end of JSON input') }))
      .toEqual({ reason: 'stream_error', message: 'Unexpected end of JSON input' })
    expect(streamEnd({ error: 'a thrown string' })).toEqual({ reason: 'stream_error', message: 'a thrown string' })
  })

  it('calls a stream that ended without an error an end of stream', () => {
    expect(streamEnd(undefined)).toMatchObject({ reason: 'stream_eof' })
    expect(streamEnd(undefined).message).toEqual(expect.any(String))
  })

  it('cuts a long message (the SDK appends the CLI\'s stderr tail)', () => {
    const long = `Claude Code process exited with code 1\n${'x'.repeat(5000)}`
    const ended = streamEnd({ error: new Error(long) })
    expect(ended.reason).toBe('cli_exited')
    expect(ended.message.length).toBeLessThanOrEqual(1000)
    expect(long.startsWith(ended.message)).toBe(true)
  })
})

describe('the sidecar exits when its SDK stream ends', () => {
  it('a CLI crash mid-turn: sdk.stream.ended (cli_exited) is the last line and the exit code is 3', async () => {
    const sidecar = await startRealSidecar({ program: { rules: [{ on: 'msg:prompt', emit: [{ kind: 'text', data: { text: 'partial' } }, { kind: 'crash' }] }] } })
    const sessionId = await bootedSession(sidecar)
    sidecar.send({ type: 'send', sessionId, text: 'a turn the CLI dies in' })

    expect(await sidecar.waitExit()).toEqual({ code: STREAM_ENDED_EXIT_CODE, signal: null })
    expect(sidecar.frames.at(-1)).toEqual({
      type: 'sdk.stream.ended',
      sessionId,
      reason: 'cli_exited',
      message: 'Claude Code process terminated by signal SIGKILL',
    })
    // The cause travels in sdk.stream.ended; no second error frame repeats it.
    expect(framesOf(sidecar, 'sdk.error')).toEqual([])
    expect(framesOf(sidecar, 'sdk.result')).toEqual([])
    // Interim (until Rust mints every edge, C18): the sidecar still rings the
    // result-less turn end, once.
    expect(framesOf(sidecar, 'sdk.turn.complete')).toHaveLength(1)
    // No stream-end idle: the server reports the ended session as `exited` (C09).
    expect(framesOf(sidecar, 'sdk.status').filter((frame) => frame.status === 'idle')).toEqual([])
  })

  it('a CLI crash mid-compaction ends with no status after compacting: the server reports exited', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await bootedSession(sidecar)
    sidecar.send({ type: 'send', sessionId, text: 'something to compact' })
    await sidecar.waitFor('sdk.turn.complete')
    sidecar.send({ type: 'send', sessionId, text: '/compact HANG' })
    await sidecar.waitFor((frame) => frame.type === 'sdk.status' && frame.status === 'compacting', 'compacting')
    // Kill the (stand-in) CLI, not the sidecar.
    process.kill((await sidecar.waitForBoot()).cliPid, 'SIGKILL')

    expect(await sidecar.waitExit()).toEqual({ code: STREAM_ENDED_EXIT_CODE, signal: null })
    expect(sidecar.frames.at(-1)).toMatchObject({ type: 'sdk.stream.ended', sessionId, reason: 'cli_exited' })
    expect(shownStatuses(sidecar)).toEqual(['compacting'])
    // Nothing reports a status after compacting: no idle, and no end of the compaction.
    expect(framesOf(sidecar, 'sdk.status').at(-1)).toMatchObject({ status: 'compacting' })
  })

  it('a natural end of stream mid-turn (the CLI exits 0): sdk.stream.ended (stream_eof) and exit code 3', async () => {
    const sidecar = await startRealSidecar({ program: { rules: [
      { on: 'msg:prompt', match: { text: 'second' }, emit: [{ kind: 'text', data: { text: 'partial' } }, { kind: 'crash', data: { code: 0 } }] },
    ] } })
    const sessionId = await bootedSession(sidecar)
    sidecar.send({ type: 'send', sessionId, text: 'first' })
    await sidecar.waitFor('sdk.turn.complete')
    sidecar.send({ type: 'send', sessionId, text: 'second' })

    expect(await sidecar.waitExit()).toEqual({ code: STREAM_ENDED_EXIT_CODE, signal: null })
    expect(sidecar.frames.at(-1)).toMatchObject({ type: 'sdk.stream.ended', sessionId, reason: 'stream_eof' })
    expect(framesOf(sidecar, 'sdk.result')).toHaveLength(1)
    // One edge for the first turn's result, one (interim) for the second turn's end.
    expect(framesOf(sidecar, 'sdk.turn.complete')).toHaveLength(2)
  })

  it('a stream that fails for another reason: sdk.stream.ended (stream_error) and exit code 3', async () => {
    // An approval step under bypassPermissions is a simulator failure: the
    // stream throws an error that is not a CLI death.
    const sidecar = await startRealSidecar({ program: { rules: [{ on: 'msg:prompt', emit: [{ kind: 'approval', data: { tool: 'Bash', input: { command: 'ls' } } }] }] } })
    const sessionId = await sidecar.create({ permissionMode: 'bypassPermissions' })
    await sidecar.waitForBoot()
    sidecar.send({ type: 'send', sessionId, text: 'go' })

    expect(await sidecar.waitExit()).toEqual({ code: STREAM_ENDED_EXIT_CODE, signal: null })
    const ended = sidecar.frames.at(-1)!
    expect(ended).toMatchObject({ type: 'sdk.stream.ended', sessionId, reason: 'stream_error' })
    expect(ended.message).toMatch(/^Claude CLI simulator failure: /)
  })

  it('an idle session whose CLI dies still ends the sidecar, with no edge', async () => {
    const sidecar = await startRealSidecar({ program: { rules: [{ on: 'start', emit: [{ kind: 'crash', delayMs: 200 }] }] } })
    const sessionId = await sidecar.create()

    expect(await sidecar.waitExit()).toEqual({ code: STREAM_ENDED_EXIT_CODE, signal: null })
    expect(sidecar.frames.at(-1)).toMatchObject({ type: 'sdk.stream.ended', sessionId, reason: 'cli_exited' })
    expect(framesOf(sidecar, 'sdk.turn.complete')).toEqual([])
  })

  it('a shutdown request mid-turn exits 0 and reports nothing alert-related', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await bootedSession(sidecar)
    sidecar.send({ type: 'send', sessionId, text: 'SLOW a turn still streaming' })
    await sidecar.waitFor('sdk.session.init')
    sidecar.send({ type: 'shutdown' })

    expect(await sidecar.waitExit()).toEqual({ code: 0, signal: null })
    expect(sidecar.frames.filter(isAlertFrame)).toEqual([])
  })

  it('stdin closing (the server let go of the sidecar) exits 0 and reports nothing alert-related', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await bootedSession(sidecar)
    sidecar.send({ type: 'send', sessionId, text: 'SLOW a turn still streaming' })
    await sidecar.waitFor('sdk.session.init')
    sidecar.child.stdin!.end()

    expect(await sidecar.waitExit()).toEqual({ code: 0, signal: null })
    expect(sidecar.frames.filter(isAlertFrame)).toEqual([])
  })
})
