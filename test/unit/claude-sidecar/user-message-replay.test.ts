// @vitest-environment node
//
// Checkpoint identity at the SDK replay boundary, through the real index.mjs
// over the CLI simulator (harness.ts). A checkpointed send carries a uuid; the
// CLI echoes the message back as an isReplay user row with that uuid when it
// takes it (T8), and only that replay binds the attempt. Each mode drives a
// stream the real CLI produces:
//   match     the send is replayed with our uuid;
//   mismatch  while the attempt waits, the CLI replays a uuid it minted itself
//             (setModel's /model command, T8) and never replays the attempt
//             (an unknown slash command, T8);
//   absent    the attempt is never replayed (an unknown slash command);
//   ordinary  while the attempt waits, ordinary user rows go by (a tool
//             result) and the attempt is never replayed.
// The shapes the CLI never produces (a non-replay row carrying our own uuid)
// are pinned on the pure binding in checkpoint-identity.test.ts.

import { describe, expect, it } from 'vitest'
import { startRealSidecar, type SidecarFrame } from './harness'

const UNKNOWN_SLASH_COMMAND = '/no-such-command-xyz'

interface Attempt { uuid: string; requestId: string; logicalAttemptId: string }

const MODES: Record<string, { lines: (sessionId: string, checkpointAttempt: Attempt) => object[]; results: number }> = {
  match: {
    lines: (sessionId, checkpointAttempt) => [{ type: 'send', sessionId, text: 'same prompt', checkpointAttempt }],
    results: 1,
  },
  mismatch: {
    lines: (sessionId, checkpointAttempt) => [
      { type: 'send', sessionId, text: UNKNOWN_SLASH_COMMAND, checkpointAttempt },
      { type: 'configure', sessionId, requestId: 'model-1', settings: { model: 'claude-opus-4-1-20250805' } },
    ],
    results: 1,
  },
  absent: {
    lines: (sessionId, checkpointAttempt) => [{ type: 'send', sessionId, text: UNKNOWN_SLASH_COMMAND, checkpointAttempt }],
    results: 1,
  },
  ordinary: {
    lines: (sessionId, checkpointAttempt) => [
      { type: 'send', sessionId, text: 'TOOL:sleep=0' },
      { type: 'send', sessionId, text: UNKNOWN_SLASH_COMMAND, checkpointAttempt },
    ],
    results: 2,
  },
}

describe('Claude checkpoint identity at the SDK replay boundary', () => {
  it.each([
    { mode: 'match' as const, shouldBind: true },
    { mode: 'mismatch' as const, shouldBind: false },
    { mode: 'absent' as const, shouldBind: false },
    { mode: 'ordinary' as const, shouldBind: false },
  ])('$mode replay binds only its own correlated user row', async ({ mode, shouldBind }) => {
    const sidecar = await startRealSidecar()
    const { frames, waitFor } = sidecar
    const sessionId = await sidecar.create({ requestId: 'create-1' })
    const checkpointAttempt = {
      uuid: 'b3eaf0e1-c8fe-4fb3-8802-b3ce52ca0b16',
      requestId: 'send-1',
      logicalAttemptId: 'attempt-1',
    }
    sidecar.sendLines(MODES[mode].lines(sessionId, checkpointAttempt))
    // The turn that carries the attempt has ended.
    await waitFor(() => frames.filter((frame: SidecarFrame) => frame.type === 'sdk.result').length >= MODES[mode].results, 'the attempt turn result')

    const receipts = frames.filter((frame) => frame.type === 'sdk.checkpointTurnIdentity')
    if (shouldBind) {
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        logicalAttemptId: 'attempt-1',
        requestId: 'send-1',
        sessionId,
        nativeTurnId: checkpointAttempt.uuid,
        displayTurnId: checkpointAttempt.uuid,
      })
      expect(receipts[0]).not.toHaveProperty('text')
    } else {
      expect(receipts).toHaveLength(0)
    }
    expect(frames.some((frame) => frame.type === 'sdk.assistant')).toBe(true)

    sidecar.send({ type: 'shutdown' })
    expect(await sidecar.waitExit()).toEqual({ code: 0, signal: null })
  })
})
