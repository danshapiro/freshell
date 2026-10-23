// test/unit/claude-sidecar/rollback-quiesce.test.ts
//
// Process-level contract for the ep4-r3 rollback quiesce protocol in
// crates/freshell-claude-sidecar/index.mjs — the SDK's queued-input surface
// cannot cancel never-started items (UUID-less compact messages), so
// rollback's cancellation authority lives in the sidecar's OWN input queue:
//
// 1. `/compact` sends that were never handed to an awaiting SDK consumer are
//    DROPPED at `rollback.quiesce` and counted as `cancelledQueue`;
// 2. a compact that crossed the same-tick handoff (pushed while the SDK
//    consumer was awaiting) is un-cancellable — the answer's
//    `handedCompactLikely` forces rollback to refuse;
// 3. the flags clear on the compact run's OWN terminal SDK frames (evidence
//    stream order), so a later quiesce is all-clear again;
// 4. an open turn flags `inFlightTurn` (a handle_mirrored busy fold alone
//    cannot see an open-but-unproduced turn at probe time);
// 5. the answer echoes `probeId` verbatim (request/receipt correlation — a
//    stale receipt can never close a later live probe).
//
// Runs the real index.mjs over the CLI simulator (harness.ts). The SDK's
// input pump is eager: it awaits the sidecar's queue, takes one message,
// writes it to the CLI and comes back for the next. So the window in which a
// /compact is still in the sidecar's own queue is a stdin chunk: lines that
// arrive together are all pushed before the pump returns (sendLines), and
// everything after the first is queued. Nothing here depends on wall-clock
// timing: a hung model request (HANG) keeps the CLI from starting a queued
// compact until the test lets it.

import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar, type SidecarFrame } from './harness'

type Frame = SidecarFrame

async function bootSession(h: RealSidecar): Promise<string> {
  return h.create({ requestId: 'q-create' })
}

const isQuiescedFor = (sid: string, probeId: string) => (f: Frame) =>
  f.type === 'sdk.rollback.quiesced' && f.sessionId === sid && f.probeId === probeId

describe('rollback quiesce protocol (ep4-r3)', () => {
  it('drains never-handed queued compacts and reports the count (all-clear verdict)', async () => {
    const h = await startRealSidecar()
    const sid = await bootSession(h)
    // One stdin chunk: the first send is handed to the awaiting SDK pump; both
    // /compact sends land in the sidecar's queue before the pump comes back,
    // and the probe runs in the same chunk.
    h.sendLines([
      { type: 'send', sessionId: sid, text: 'HANG' },
      { type: 'send', sessionId: sid, text: '/compact' },
      { type: 'send', sessionId: sid, text: '/compact focus X' },
      { type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-drain-1' },
    ])
    const answer = await h.waitFor(isQuiescedFor(sid, 'probe-drain-1'), 'quiesced drained')
    expect(answer.cancelledQueue).toBe(2)
    expect(answer.inFlightTurn).toBe(false)
    expect(answer.handedCompactLikely).toBe(false)
  })

  it('flags handedCompactLikely when a compact crossed the same-tick handoff, then clears it at the run result (cases 2+3)', async () => {
    const h = await startRealSidecar()
    const sid = await bootSession(h)
    // The SDK pump idles on next() between prompts — a /compact pushed now is
    // handed over synchronously (un-cancellable).
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-handed-1' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-handed-1'), 'quiesced handed busy')
    expect(busy.handedCompactLikely).toBe(true)
    expect(busy.cancelledQueue).toBe(0)

    // The compact RUN provably happened (its own result frame): both flags
    // discharge into the evidence stream — the next probe is all-clear again.
    await h.waitFor((f) => f.type === 'sdk.result', 'compact run result')
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-handed-2' })
    const clear = await h.waitFor(isQuiescedFor(sid, 'probe-handed-2'), 'quiesced after result')
    expect(clear.handedCompactLikely).toBe(false)
    expect(clear.inFlightTurn).toBe(false)
  })

  it('flags inFlightTurn while a turn is open (its result never landed)', async () => {
    const h = await startRealSidecar()
    const sid = await bootSession(h)
    // A long Bash call: its tool_use assistant frame arrives and the turn stays open.
    h.send({ type: 'send', sessionId: sid, text: 'TOOL:sleep=600' })
    await h.waitFor((f) => f.type === 'sdk.assistant', 'assistant frame')
    // give the sidecar's bookkeeping a beat (the frame already ordered in)
    await new Promise((r) => setTimeout(r, 40))
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-inflight-1' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-inflight-1'), 'quiesced inflight busy')
    expect(busy.inFlightTurn).toBe(true)
  })

  it('ep4-r4: a compact QUEUED behind another send arming on its LATER pull (the queued-cells handoff) is busy-flagged until its result (case 6)', async () => {
    const h = await startRealSidecar()
    const sid = await bootSession(h)
    // One stdin chunk: the /compact is queued behind the first send, and the
    // pre-pull probe in the same chunk drains it → all-clear.
    h.sendLines([
      { type: 'send', sessionId: sid, text: 'HANG' },
      { type: 'send', sessionId: sid, text: '/compact' },
      { type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-prepull' },
    ])
    const pre = await h.waitFor(isQuiescedFor(sid, 'probe-prepull'), 'quiesced pre-pull')
    expect(pre.cancelledQueue).toBe(1)
    expect(pre.handedCompactLikely).toBe(false)

    // ep4-r0 regression anchor for this exact finding: with the compact
    // REMOVED from the queue pre-pull (drained above), there is nothing left
    // to pull — assert instead with a fresh compact queued behind another
    // send in one chunk, so its HANDOFF happens when the SDK pump comes back
    // for it (the pull path this case names). The CLI is still busy with the
    // hung first turn, so the compact cannot start (and discharge the flag
    // with its own evidence) before the probe.
    h.sendLines([
      { type: 'send', sessionId: sid, text: 'HANG' },
      { type: 'send', sessionId: sid, text: '/compact queued-second' },
    ])
    // The pull happens right after that chunk; a probe in a LATER chunk sees
    // it — synchronize on the sidecar having read the chunk, never on
    // wall-clock arithmetic (the reviewer-flagged flake).
    await h.barrier(sid)
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-pulled' })
    const pulled = await h.waitFor(isQuiescedFor(sid, 'probe-pulled'), 'quiesced post-pull busy')
    expect(pulled.handedCompactLikely).toBe(true)
    expect(pulled.cancelledQueue).toBe(0)
  })

  it('ep4-r6 F1: an unrelated turn result never discharges the handed-compact busy truth; only the compact evidence does', async () => {
    const h = await startRealSidecar()
    const sid = await bootSession(h)
    // Two turns ahead of the compact: the first finishes (an unrelated
    // result), the second is a hung model request that keeps the CLI from
    // starting the compact until it is interrupted.
    h.sendLines([
      { type: 'send', sessionId: sid, text: 'first turn' },
      { type: 'send', sessionId: sid, text: 'HANG' },
    ])
    await h.barrier(sid)
    // /compact against an idle (awaiting) SDK pump: the handoff is same-tick (armed).
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    // An unrelated turn's terminal result lands FIRST (the SDK drives inputs
    // and results independently) — then, and only then, the compact's own
    // evidence.
    await h.waitFor(
      (f) => f.type === 'sdk.result',
      'the unrelated result lands mid-window',
    )
    // MID-WINDOW probe: the handed flag must survive the unrelated result.
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-f1-mid' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-f1-mid'), 'mid-window busy answer')
    expect(busy.handedCompactLikely).toBe(true)

    // Stopping the hung turn lets the CLI run the compact. Its OWN evidence
    // lands: status discharges the handed flag, its result closes the turn —
    // a probe after both is all-clear again.
    h.send({ type: 'interrupt', sessionId: sid })
    await h.waitFor((f) => f.type === 'sdk.status' && f.status === 'compacting', 'compacting status')
    await h.waitFor(
      () => h.frames.filter((x) => x.type === 'sdk.result').length >= 3,
      'the compact result (after the first turn and the interrupted one)',
    )
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-f1-after' })
    const clear = await h.waitFor(isQuiescedFor(sid, 'probe-f1-after'), 'post-evidence all-clear')
    expect(clear.handedCompactLikely).toBe(false)
    expect(clear.inFlightTurn).toBe(false)
  })

  it('echoes only the requesting probeId (an unrelated probeId is its own answer)', async () => {
    const h = await startRealSidecar()
    const sid = await bootSession(h)
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-correlation-a' })
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-correlation-b' })
    const a = await h.waitFor(isQuiescedFor(sid, 'probe-correlation-a'), 'quiesced probe A')
    const b = await h.waitFor(isQuiescedFor(sid, 'probe-correlation-b'), 'quiesced probe B')
    expect(a.probeId).toBe('probe-correlation-a')
    expect(b.probeId).toBe('probe-correlation-b')
  })
})
