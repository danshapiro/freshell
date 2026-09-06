// test/unit/server/claude-sidecar/rollback-quiesce.test.ts
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
// Harness mirrors permission-channel.test.ts's spawnSidecar seam
// (FRESHELL_CLAUDE_SDK_QUERY_MODULE=fake-query-module.mjs).

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SIDECAR_INDEX = path.join(REPO_ROOT, 'crates', 'freshell-claude-sidecar', 'index.mjs')
const FAKE_QUERY_MODULE = path.join(__dirname, 'fixtures', 'fake-query-module.mjs')

type Frame = Record<string, any>

const children = new Set<ChildProcess>()
function trackChild(c: ChildProcess) {
  children.add(c)
  return c
}
afterEach(async () => {
  for (const c of children) c.kill('SIGKILL')
  children.clear()
})

function spawnSidecar(env: Record<string, string> = {}) {
  const child = trackChild(
    spawn(process.execPath, [SIDECAR_INDEX], {
      env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: FAKE_QUERY_MODULE, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  )
  const frames: Frame[] = []
  let stdoutBuf = ''
  let stderrOut = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      try {
        frames.push(JSON.parse(line))
      } catch {
        /* non-JSON line: ignore */
      }
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrOut += chunk.toString('utf8')
  })
  const send = (msg: Frame) => child.stdin!.write(`${JSON.stringify(msg)}\n`)
  const waitFor = (pred: (f: Frame) => boolean, label: string, timeoutMs = 10_000) =>
    new Promise<Frame>((resolve, reject) => {
      const started = Date.now()
      const poll = () => {
        const hit = frames.find(pred)
        if (hit) {
          resolve(hit)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(
            new Error(
              `timed out waiting for ${label}; frames=${JSON.stringify(frames)}; stderr=${stderrOut.slice(-800)}`,
            ),
          )
          return
        }
        setTimeout(poll, 10)
      }
      poll()
    })
  return { child, frames, send, waitFor, stderr: () => stderrOut }
}

async function bootSession(h: ReturnType<typeof spawnSidecar>): Promise<string> {
  h.send({ type: 'create', requestId: 'q-create' })
  const created = await h.waitFor((f) => f.type === 'created', 'created')
  return created.sessionId as string
}

const isQuiescedFor = (sid: string, probeId: string) => (f: Frame) =>
  f.type === 'sdk.rollback.quiesced' && f.sessionId === sid && f.probeId === probeId

describe('rollback quiesce protocol (ep4-r3)', () => {
  it('drains never-handed queued compacts and reports the count (all-clear verdict)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    // Park the module INSIDE its message handler so its consumer is provably
    // NOT awaiting next(): both /compact sends land in the sidecar's queue.
    h.send({ type: 'send', sessionId: sid, text: '__park_500__' })
    await new Promise((r) => setTimeout(r, 60)) // the park owns the loop
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    h.send({ type: 'send', sessionId: sid, text: '/compact focus X' })
    await new Promise((r) => setTimeout(r, 40))
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-drain-1' })
    const answer = await h.waitFor(isQuiescedFor(sid, 'probe-drain-1'), 'quiesced drained')
    expect(answer.cancelledQueue).toBe(2)
    expect(answer.inFlightTurn).toBe(false)
    expect(answer.handedCompactLikely).toBe(false)
  })

  it('flags handedCompactLikely when a compact crossed the same-tick handoff, then clears it at the run result (cases 2+3)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    // The module idles on next() between prompts — a /compact pushed now is
    // handed over synchronously (un-cancellable).
    await new Promise((r) => setTimeout(r, 80))
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
    const h = spawnSidecar()
    const sid = await bootSession(h)
    h.send({ type: 'send', sessionId: sid, text: '__open_turn__' })
    await h.waitFor((f) => f.type === 'sdk.assistant' || (f.type === 'sdk.assistant'), 'assistant frame')
    // give the sidecar's bookkeeping a beat (the frame already ordered in)
    await new Promise((r) => setTimeout(r, 40))
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-inflight-1' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-inflight-1'), 'quiesced inflight busy')
    expect(busy.inFlightTurn).toBe(true)
  })

  it('ep4-r4: a compact QUEUED behind a parked turn arming on its LATER pull (the queued-cells handoff) is busy-flagged until its result (case 6)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    // Park the module INSIDE its message handler: the consumer is provably
    // not awaiting next(), so the /compact lands in the sidecar queue.
    h.send({ type: 'send', sessionId: sid, text: '__park_600__' })
    await new Promise((r) => setTimeout(r, 60)) // the park owns the loop
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    await new Promise((r) => setTimeout(r, 40))
    // Pre-pull probe: the compact is still queued → drained, all-clear.
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-prepull' })
    const pre = await h.waitFor(isQuiescedFor(sid, 'probe-prepull'), 'quiesced pre-pull')
    expect(pre.cancelledQueue).toBe(1)
    expect(pre.handedCompactLikely).toBe(false)

    // ep4-r0 regression anchor for this exact finding: with the compact
    // REMOVED from the queue pre-pull (drained above), there is nothing left
    // to pull — assert instead with a fresh compact parked across the
    // park boundary: queue it behind a second park so its HANDOFF happens
    // under the module's return to next() (the pull path this case names).
    h.send({ type: 'send', sessionId: sid, text: '__park_400__' }) // consumed after park 1 ends
    h.send({ type: 'send', sessionId: sid, text: '/compact queued-second' })
    // The first park ends; the loop pulls __park_400__ (busy again), and only
    // after IT ends is the queued compact pulled (armed) + run. The module
    // signals the run start with probe.compact_running — synchronize on THAT,
    // never on wall-clock arithmetic (the reviewer-flagged flake).
    await h.waitFor(
      (f) => f.type === 'probe.compact_running',
      'the queued compact starts running',
    )
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-pulled' })
    const pulled = await h.waitFor(isQuiescedFor(sid, 'probe-pulled'), 'quiesced post-pull busy')
    expect(pulled.handedCompactLikely).toBe(true)
    expect(pulled.cancelledQueue).toBe(0)
  })

  it('ep4-r6 F1: an unrelated turn result never discharges the handed-compact busy truth; only the compact evidence does', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    // /compact against an eagerly-draining module: the handoff is same-tick (armed).
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    await h.waitFor((f) => f.type === 'probe.compact_running', 'compact run started')
    // An unrelated turn's terminal result lands FIRST (the SDK drives inputs
    // and results independently) — then, and only then, the compact's own
    // evidence (status compacting at +300ms, its result at +500ms).
    h.send({ type: 'send', sessionId: sid, text: '__one_result__' })
    await h.waitFor(
      (f) => f.type === 'sdk.result',
      'the unrelated result lands mid-window',
    )
    // MID-WINDOW probe: the handed flag must survive the unrelated result.
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-f1-mid' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-f1-mid'), 'mid-window busy answer')
    expect(busy.handedCompactLikely).toBe(true)

    // The compact's OWN evidence lands: status discharges the handed flag, its
    // result closes the turn — a probe after both is all-clear again.
    await h.waitFor((f) => f.type === 'sdk.status' && f.status === 'compacting', 'compacting status')
    await h.waitFor(
      (f) => h.frames.filter((x) => x.type === 'sdk.result').length >= 2,
      'the compact result',
    )
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-f1-after' })
    const clear = await h.waitFor(isQuiescedFor(sid, 'probe-f1-after'), 'post-evidence all-clear')
    expect(clear.handedCompactLikely).toBe(false)
    expect(clear.inFlightTurn).toBe(false)
  })

  it('echoes only the requesting probeId (an unrelated probeId is its own answer)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-correlation-a' })
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-correlation-b' })
    const a = await h.waitFor(isQuiescedFor(sid, 'probe-correlation-a'), 'quiesced probe A')
    const b = await h.waitFor(isQuiescedFor(sid, 'probe-correlation-b'), 'quiesced probe B')
    expect(a.probeId).toBe('probe-correlation-a')
    expect(b.probeId).toBe('probe-correlation-b')
  })
})
