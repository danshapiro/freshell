// Unit coverage for the AGENT-04/05/06 arms of the HARNESS-03 fake claude-SDK
// sidecar (`test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs`):
// permission.respond/question.respond pending-resolution, interrupt-time
// pending cancellation (cancel frames, never an sdk.exit), the result facts
// the server's verdict reads (C18: the fake mints no attention edge, like the
// real sidecar), the parked-turn rule (no canned completion while parked), the
// stream-error lane's exit (the real sidecar's end of stream), the
// FRESHELL_FAKE_STDIN raw-stdin audit, and the durable-transcript writes the
// reload-while-pending snapshot route depends on. Process/wire-level contract
// for all seven fixtures stays in specs/harness-03-provider-fixtures.spec.ts;
// this file pins only the new arms, driven through real child processes with
// per-test tmp HOMEs.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE = path.resolve(__dirname, '../fixtures/providers/fake-claude-sdk-sidecar.mjs')

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-sidecar-arms-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

type Launched = {
  proc: ChildProcess
  stdoutLines: () => any[]
  send: (msg: Record<string, unknown>) => void
  waitLine: (pred: (o: any) => boolean, what: string) => Promise<any>
  stop: () => Promise<void>
}

function launch(program: unknown, extraEnv: Record<string, string> = {}): Launched {
  const proc = spawn(process.execPath, [FIXTURE], {
    env: {
      ...process.env,
      HOME: tmp,
      FRESHELL_FAKE_PROVIDER: 'freshclaude',
      FRESHELL_FAKE_PROGRAM: JSON.stringify(program),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let killed = false
  const parsed: any[] = []
  let carry = ''
  proc.stdout!.on('data', (chunk) => {
    carry += String(chunk)
    let idx
    while ((idx = carry.indexOf('\n')) !== -1) {
      const line = carry.slice(0, idx)
      carry = carry.slice(idx + 1)
      try {
        parsed.push(JSON.parse(line))
      } catch {
        // non-JSON stdout is not part of this protocol; ignore
      }
    }
  })
  return {
    proc,
    stdoutLines: () => parsed.slice(),
    send: (msg) => proc.stdin!.write(`${JSON.stringify(msg)}\n`),
    waitLine: async (pred, what) => {
      const deadline = Date.now() + 10_000
      for (;;) {
        const hit = parsed.find(pred)
        if (hit) return hit
        if (Date.now() > deadline) {
          throw new Error(`fake sidecar: timed out waiting for ${what}; saw ${JSON.stringify(parsed.map((o) => o?.type))}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    },
    stop: async () => {
      if (proc.exitCode !== null || killed) return
      killed = true
      proc.kill('SIGKILL')
    },
  }
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const RAISE_PROGRAM = {
  rules: [
    {
      on: 'msg:send',
      match: { text: 'RAISE_PERMISSION' },
      emit: [
        { kind: 'approval', data: { id: 'req-perm-1', tool: 'Bash', input: { command: 'ls' } } },
      ],
    },
    {
      // A DISTINCT second id: the real sidecar nanoids each raise, so a
      // concurrent-parking probe never reuses the first request's id.
      on: 'msg:send',
      match: { text: 'RAISE_PERMISSION_2' },
      emit: [
        { kind: 'approval', data: { id: 'req-perm-2', tool: 'Bash', input: { command: 'ls -la' } } },
      ],
    },
    {
      on: 'msg:permission.respond',
      match: { decision: { behavior: 'allow' } },
      emit: [{ kind: 'completion', data: { subtype: 'success' } }],
    },
    {
      on: 'msg:send',
      match: { text: 'RAISE_QUESTION' },
      emit: [
        {
          kind: 'question',
          data: {
            id: 'req-q-1',
            questions: [
              {
                question: 'Pick one',
                header: 'Fixture',
                options: [{ label: 'A', description: 'alpha' }, { label: 'B', description: 'beta' }],
                multiSelect: false,
              },
            ],
          },
        },
      ],
    },
    {
      on: 'msg:question.respond',
      emit: [{ kind: 'completion', data: { subtype: 'success' }, delayMs: 10 }],
    },
  ],
}

describe('fake-claude-sdk-sidecar respond/interrupt arms (AGENT-05/06 fixture)', () => {
  it(
    'responds resolve the parked requests; the fake mints no waiting or completion edge (the server does, C18)',
    async () => {
      const stdinLog = path.join(tmp, 'stdin.jsonl')
      const fx = launch(RAISE_PROGRAM, { FRESHELL_FAKE_STDIN: stdinLog })
      try {
        fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
        const created = await fx.waitLine((o) => o.type === 'created', 'created')
        const sessionId = created.sessionId as string

        fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION' })
        const request = await fx.waitLine((o) => o.type === 'sdk.permission.request', 'sdk.permission.request')
        expect(request).toMatchObject({
          sessionId,
          requestId: 'req-perm-1',
          subtype: 'can_use_tool',
          tool: { name: 'Bash', input: { command: 'ls' } },
        })
        // Parked: NO result may arrive before the respond.
        expect(fx.stdoutLines().some((o) => o.type === 'sdk.result')).toBe(false)

        // A second CONCURRENT raise (distinct request id, like the real
        // sidecar's nanoid mint) while parked.
        fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION_2' })
        await fx.waitLine((o) => o.type === 'sdk.permission.request' && o.requestId === 'req-perm-2', 'second permission.request')

        // Each respond resolves its own parked request and its turn ends.
        fx.send({ type: 'permission.respond', sessionId, requestId: 'req-perm-1', decision: { behavior: 'allow' } })
        await fx.waitLine((o) => o.type === 'sdk.result', 'turn result after allow')
        fx.send({ type: 'permission.respond', sessionId, requestId: 'req-perm-2', decision: { behavior: 'allow' } })
        await fx.waitLine(
          (o) => o.type === 'sdk.result' && fx.stdoutLines().filter((r) => r.type === 'sdk.result').length >= 2,
          'second turn result',
        )
        fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION' })
        await fx.waitLine(
          (o) => o.type === 'sdk.permission.request' && fx.stdoutLines().filter((r) => r.type === 'sdk.permission.request').length === 3,
          'third permission.request',
        )
        // The server folds these requests and results into its own edges.
        expect(
          fx.stdoutLines().filter((o) => o.type === 'sdk.turn.waiting' || o.type === 'sdk.turn.complete'),
          'the fake mints no attention edge',
        ).toEqual([])

        // Raw-stdin audit: both respond frames landed verbatim in the
        // fixture's log (exactly the frames this test wrote — zero fabricated).
        const stdinRows = readJsonl(stdinLog)
        const responds = stdinRows
          .map((row) => {
            try {
              return JSON.parse(row.line)
            } catch {
              return null
            }
          })
          .filter((m) => m?.type === 'permission.respond')
        expect(responds).toHaveLength(2)
        expect(responds[0]).toMatchObject({ sessionId, requestId: 'req-perm-1', decision: { behavior: 'allow' } })
        expect(responds[1]).toMatchObject({ sessionId, requestId: 'req-perm-2', decision: { behavior: 'allow' } })
      } finally {
        await fx.stop()
      }
    },
  )

  it('a respond for a NEVER-raised requestId does not poison the pending ledger (task-008-review N-2)', async () => {
    const fx = launch(RAISE_PROGRAM)
    try {
      fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
      const created = await fx.waitLine((o) => o.type === 'created', 'created')
      const sessionId = created.sessionId as string

      fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION' })
      await fx.waitLine((o) => o.type === 'sdk.permission.request', 'permission.request')

      // Resolve a requestId that was NEVER raised. (deny matches no
      // RAISE_PROGRAM rule, so this respond emits nothing else; only the
      // resolvePending ledger bookkeeping runs.)
      fx.send({ type: 'permission.respond', sessionId, requestId: 'req-never-raised', decision: { behavior: 'deny' } })

      // The ledger must still hold the real parked request: an interrupt
      // cancels exactly it, and nothing for the foreign id.
      fx.send({ type: 'interrupt', sessionId, stopId: 'stop-1' })
      await fx.waitLine((o) => o.type === 'sdk.interrupt_settled', 'the settle')
      expect(
        fx.stdoutLines().filter((o) => o.type === 'sdk.permission.cancelled').map((o) => o.requestId),
        'the foreign respond must not have resolved the real parked request',
      ).toEqual(['req-perm-1'])
    } finally {
      await fx.stop()
    }
  })

  it('interrupt cancels every parked entry with cancel frames and never emits sdk.exit', async () => {
    const stdinLog = path.join(tmp, 'stdin.jsonl')
    const fx = launch(RAISE_PROGRAM, { FRESHELL_FAKE_STDIN: stdinLog })
    try {
      fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
      const created = await fx.waitLine((o) => o.type === 'created', 'created')
      const sessionId = created.sessionId as string

      fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION' })
      await fx.waitLine((o) => o.type === 'sdk.permission.request', 'permission.request')
      fx.send({ type: 'send', sessionId, text: 'RAISE_QUESTION' })
      await fx.waitLine((o) => o.type === 'sdk.question.request', 'question.request')

      fx.send({ type: 'interrupt', sessionId, stopId: 'stop-1' })
      const cancelledPermission = await fx.waitLine((o) => o.type === 'sdk.permission.cancelled', 'sdk.permission.cancelled')
      expect(cancelledPermission).toMatchObject({ sessionId, requestId: 'req-perm-1' })
      const cancelledQuestion = await fx.waitLine((o) => o.type === 'sdk.question.cancelled', 'sdk.question.cancelled')
      expect(cancelledQuestion).toMatchObject({ sessionId, requestId: 'req-q-1' })
      // The receipt echoes the Stop's id, and the interrupted turn ends with
      // its own aborted result, like the real CLI's (T11).
      expect(await fx.waitLine((o) => o.type === 'sdk.interrupt_settled', 'the settle')).toMatchObject({ sessionId, stopId: 'stop-1', ok: true })
      const stopped = await fx.waitLine((o) => o.type === 'sdk.result' && o.result === 'error_during_execution', 'the interrupted turn result')
      expect(stopped).toMatchObject({ subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming' })

      // AGENT-03 separation: interrupt ends the turn, never the session.
      expect(fx.stdoutLines().some((o) => o.type === 'sdk.exit')).toBe(false)

      // Zero fabricated decisions: the stdin audit contains NO respond frame.
      const stdinRows = readJsonl(stdinLog)
      expect(
        stdinRows.filter((row) => /"(permission|question)\.respond"/.test(String(row.line))),
        'interrupt must never invent a user decision',
      ).toEqual([])

      // The session is still usable: a plain send completes normally.
      fx.send({ type: 'send', sessionId, text: 'plain follow-up' })
      await fx.waitLine((o) => o.type === 'sdk.result' && o.result === 'success', 'post-interrupt completion')
    } finally {
      await fx.stop()
    }
  })

  it('a deny/errored completion emits sdk.result with its facts, no edge (the server rings it) and no per-turn idle', async () => {
    const eventsLog = path.join(tmp, 'events.jsonl')
    const fx = launch({
      rules: [
        {
          on: 'msg:send',
          match: { text: 'RAISE_PERMISSION' },
          emit: [
            { kind: 'approval', data: { id: 'req-perm-1', tool: 'Bash', input: { command: 'ls' } } },
          ],
        },
        {
          on: 'msg:permission.respond',
          match: { decision: { behavior: 'deny' } },
          emit: [{ kind: 'completion', data: { subtype: 'error', text: 'The user denied this request.' } }],
        },
      ],
    }, { FRESHELL_FAKE_EVENTS: eventsLog })
    try {
      fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
      const created = await fx.waitLine((o) => o.type === 'created', 'created')
      const sessionId = created.sessionId as string

      fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION' })
      await fx.waitLine((o) => o.type === 'sdk.permission.request', 'permission.request')
      // Parked: NO completion frame may arrive before the respond.
      expect(fx.stdoutLines().some((o) => o.type === 'sdk.turn.complete')).toBe(false)

      fx.send({ type: 'permission.respond', sessionId, requestId: 'req-perm-1', decision: { behavior: 'deny' } })
      // The errored sdk.result is the terminal marker for the deny
      // continuation: it carries the facts the server's verdict reads.
      const errored = await fx.waitLine((o) => o.type === 'sdk.result' && o.result === 'error', 'errored sdk.result')
      expect(errored).toMatchObject({ sessionId, subtype: 'error', isError: true })
      const out = fx.stdoutLines()
      const resultIdx = out.findIndex(
        (o) => o.type === 'sdk.result' && o.result === 'error' && o.sessionId === sessionId,
      )
      expect(resultIdx, 'the denied turn produced an errored sdk.result').toBeGreaterThanOrEqual(0)
      // Like the real sidecar, the turn ends with its result alone: no idle
      // follows it (the real sidecar sends no idle at all).
      expect(
        out.filter((o, i) => i > resultIdx && o.type === 'sdk.status' && o.sessionId === sessionId && o.status === 'idle'),
        'no per-turn idle after the result',
      ).toEqual([])
      expect(
        out.some((o) => o.type === 'sdk.assistant' && o.sessionId === sessionId
          && o.content?.[0]?.text?.includes('denied')),
        'the denial assistant frame arrived',
      ).toBe(true)

      // The outbound wire audit records exactly what went over stdout.
      const wires = readJsonl(eventsLog).filter((r) => r.kind === 'wire')
      expect(
        wires.filter((r) => r.frame?.type === 'sdk.result' && r.frame?.sessionId === sessionId),
        'the wire audit shows the errored result on stdout',
      ).toHaveLength(1)

      // A plain turn still completes the positive way (fidelity pin).
      fx.send({ type: 'send', sessionId, text: 'plain follow-up' })
      const success = await fx.waitLine((o) => o.type === 'sdk.result' && o.result === 'success', 'the follow-up success result')
      expect(success).toMatchObject({ subtype: 'success', isError: false, terminalReason: 'completed' })
      expect(
        fx.stdoutLines().filter((o) => o.type === 'sdk.turn.complete' || o.type === 'sdk.turn.waiting'),
        'the fake mints no attention edge',
      ).toEqual([])
    } finally {
      await fx.stop()
    }
  })

  it('an interrupt on an idle session settles ok:true (SDK resolution) with its stopId, and the next turn runs', async () => {
    const fx = launch({ rules: [] })
    try {
      fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
      const created = await fx.waitLine((o) => o.type === 'created', 'created')
      const sessionId = created.sessionId as string
      await fx.waitLine((o) => o.type === 'sdk.status' && o.status === 'idle', 'initial idle')

      // Nothing awaits a terminal frame. The real SDK RESOLVES an
      // idle-session interrupt (sdk.d.ts:2384-2394 — resolution, not
      // rejection; the ok:false 'no in-flight SDK query' shape fires only
      // when the SDK surface lacks the interrupt method entirely), so the
      // real sidecar settles ok:true. The fake must mirror that shape.
      fx.send({ type: 'interrupt', sessionId, stopId: 'stop-idle' })
      const settle = await fx.waitLine((o) => o.type === 'sdk.interrupt_settled', 'idle interrupt settle')
      expect(settle).toMatchObject({ sessionId, stopId: 'stop-idle', ok: true })

      fx.send({ type: 'send', sessionId, text: 'next unrelated turn' })
      await fx.waitLine((o) => o.type === 'sdk.result' && o.result === 'success', 'the next turn runs')
    } finally {
      await fx.stop()
    }
  })

  it('an interrupt against a dead session settles ok:false, never a fabricated ok:true (real-sidecar parity)', async () => {
    const fx = launch({ rules: [] })
    try {
      // No create ever ran: the session id is unknown. The REAL sidecar's
      // handleInterrupt refuses it: its receipt is ok:false, echoing the
      // Stop's id (index.mjs). The kilroy fake mirrors this; the claude fake
      // must too.
      fx.send({ type: 'interrupt', sessionId: 'never-created', stopId: 'stop-x' })
      const settle = await fx.waitLine((o) => o.type === 'sdk.interrupt_settled', 'dead-session interrupt settle')
      expect(settle).toMatchObject({ sessionId: 'never-created', stopId: 'stop-x', ok: false })
      const out = fx.stdoutLines()
      expect(out.filter((o) => o.type === 'sdk.error'), 'no error frame for a dead session').toEqual([])
      expect(out.filter((o) => o.type === 'sdk.status'), 'no fabricated activity for a dead session').toEqual([])
    } finally {
      await fx.stop()
    }
  })

  it('the stream-error lane ends the sidecar like the real one: sdk.stream.ended last, exit code 3, no edge', async () => {
    const fx = launch({
      rules: [
        { on: 'msg:send', match: { text: 'DIE' }, emit: [{ kind: 'stream-error' }] },
      ],
    })
    try {
      fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
      const created = await fx.waitLine((o) => o.type === 'created', 'created')
      const sessionId = created.sessionId as string
      const exited = new Promise<number | null>((resolve) => fx.proc.once('exit', (code) => resolve(code)))

      // The stream ends mid-turn: the end report, then the exit. The server
      // rings the cut-off turn (C18), not the fake.
      fx.send({ type: 'send', sessionId, text: 'DIE' })
      expect(await exited).toBe(3)
      const out = fx.stdoutLines()
      expect(out.at(-1)).toEqual({ type: 'sdk.stream.ended', sessionId, reason: 'stream_error', message: 'Fixture stream error' })
      expect(out.filter((o) => o.type === 'sdk.turn.complete'), 'the fake mints no edge').toEqual([])
      expect(out.filter((o) => o.type === 'sdk.result'), 'the turn ended with no result').toEqual([])
      expect(out.filter((o) => o.type === 'sdk.error'), 'the end report carries the cause; no error frame repeats it').toEqual([])
      const turnOpened = out.findLastIndex((o) => o.type === 'sdk.status' && o.status === 'running')
      expect(turnOpened, 'the send opened its turn').toBeGreaterThanOrEqual(0)
      expect(
        out.slice(turnOpened + 1).filter((o) => o.type === 'sdk.status'),
        'no stream-end status: the server reports the ended session as exited',
      ).toEqual([])
    } finally {
      await fx.stop()
    }
  })

  it('writes the durable claude transcript the snapshot route reads (create-touch, user on send, assistant on completion)', async () => {
    const fx = launch(RAISE_PROGRAM)
    try {
      fx.send({ type: 'create', requestId: 'req-1', cwd: tmp })
      await fx.waitLine((o) => o.type === 'sdk.session.init', 'sdk.session.init')
      const created = fx.stdoutLines().find((o) => o.type === 'created')
      const init = fx.stdoutLines().find((o) => o.type === 'sdk.session.init')
      const cliSessionId = init.cliSessionId as string
      expect(cliSessionId).toMatch(/^[0-9a-f-]{36}$/)
      const transcript = path.join(tmp, '.claude', 'projects', tmp.replace(/[^A-Za-z0-9]/g, '-'), `${cliSessionId}.jsonl`)
      expect(fs.existsSync(transcript), 'create must ensure the durable transcript file').toBe(true)

      fx.send({ type: 'send', sessionId: created.sessionId, text: 'hello durable world' })
      await fx.waitLine((o) => o.type === 'sdk.result', 'completion')

      const lines = readJsonl(transcript)
      expect(lines.map((l) => l.type)).toEqual(['user', 'assistant'])
      expect(lines[0]).toMatchObject({ type: 'user', cwd: tmp, message: { role: 'user', content: [{ type: 'text', text: 'hello durable world' }] } })
      expect(lines[1].message.role).toBe('assistant')
    } finally {
      await fx.stop()
    }
  })
})

describe('fake-claude-sdk-sidecar fork-at-point arm (kata 1wxv e2e fixture)', () => {
  /** The fixture's transcript dir for a cwd under this test's tmp HOME. */
  function transcriptFor(cliSessionId: string, cwd: string): string {
    return path.join(tmp, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${cliSessionId}.jsonl`)
  }

  /** Drive ORIG through two complete turns so its transcript holds u1/a1/u2/a2. */
  async function seedTwoTurns(fx: Launched): Promise<{ sessionId: string; cliSessionId: string }> {
    fx.send({ type: 'create', requestId: 'req-orig', cwd: tmp })
    const created = await fx.waitLine((o) => o.type === 'created' && o.requestId === 'req-orig', 'created ORIG')
    const init = await fx.waitLine(
      (o) => o.type === 'sdk.session.init' && o.sessionId === created.sessionId,
      'sdk.session.init ORIG',
    )
    fx.send({ type: 'send', sessionId: created.sessionId, text: 'turn one' })
    await fx.waitLine((o) => o.type === 'sdk.result', 'turn one completion')
    fx.send({ type: 'send', sessionId: created.sessionId, text: 'turn two' })
    await fx.waitLine(
      (o) => o.type === 'sdk.result' && fx.stdoutLines().filter((r) => r.type === 'sdk.result').length >= 2,
      'turn two completion',
    )
    return { sessionId: created.sessionId as string, cliSessionId: init.cliSessionId as string }
  }

  it('a fork boot mints a fresh cliSessionId and seeds the transcript prefix (s2rk correction)', async () => {
    const fx = launch({ rules: [] })
    try {
      const { cliSessionId: ORIG } = await seedTwoTurns(fx)
      const parentLines = readJsonl(transcriptFor(ORIG, tmp))
      expect(parentLines.map((l) => l.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
      // Every chain line carries a uuid + parentUuid backbone (the rollback
      // resume math runs over the RAW parentUuid chain).
      expect(parentLines.every((l) => typeof l.uuid === 'string' && l.uuid.length > 0)).toBe(true)
      expect(parentLines[0].parentUuid ?? null).toBe(null)
      expect(parentLines[1].parentUuid).toBe(parentLines[0].uuid)
      expect(parentLines[2].parentUuid).toBe(parentLines[1].uuid)

      // Fork at a1 (keep through-and-including a1); the dropsTurn guard
      // is the RAW-chain successor of the resume point (u2).
      fx.send({
        type: 'create',
        protocol: 2,
        requestId: 'req-fork',
        cwd: tmp,
        boot: { kind: 'fork', resume: ORIG, resumeSessionAt: parentLines[1].uuid, dropsTurn: parentLines[2].uuid },
      })
      const forkCreated = await fx.waitLine((o) => o.type === 'created' && o.requestId === 'req-fork', 'created fork')
      const forkInit = await fx.waitLine(
        (o) => o.type === 'sdk.session.init' && o.sessionId === forkCreated.sessionId,
        'sdk.session.init fork',
      )
      const CHILD = forkInit.cliSessionId as string
      expect(CHILD, 'real claude --fork-session mints a NEW durable id').not.toBe(ORIG)
      expect(CHILD).toMatch(/^[0-9a-f-]{36}$/)

      // The child file is the parent's transcript PREFIX through a1, uuids
      // preserved verbatim (fork prefix retention) — visible to freshell's
      // transcript readers as a real durable JSONL.
      const childLines = readJsonl(transcriptFor(CHILD, tmp))
      expect(childLines).toEqual(parentLines.slice(0, 2))

      // A follow-up plain-resume create still keeps ORIG (no same-id divergence
      // regression on the non-fork arm).
      fx.send({ type: 'create', protocol: 2, requestId: 'req-plain', cwd: tmp, boot: { kind: 'resume', resume: ORIG } })
      const plainCreated = await fx.waitLine((o) => o.type === 'created' && o.requestId === 'req-plain', 'created plain resume')
      const plainInit = await fx.waitLine(
        (o) => o.type === 'sdk.session.init' && o.sessionId === plainCreated.sessionId,
        'sdk.session.init plain resume',
      )
      expect(plainInit.cliSessionId).toBe(ORIG)
    } finally {
      await fx.stop()
    }
  })

  it('a resume boot keeps the existing same-cliSessionId behavior', async () => {
    const fx = launch({ rules: [] })
    try {
      const { cliSessionId: ORIG } = await seedTwoTurns(fx)
      fx.send({ type: 'create', protocol: 2, requestId: 'req-resume', cwd: tmp, boot: { kind: 'resume', resume: ORIG } })
      const created = await fx.waitLine((o) => o.type === 'created' && o.requestId === 'req-resume', 'created resume')
      const init = await fx.waitLine(
        (o) => o.type === 'sdk.session.init' && o.sessionId === created.sessionId,
        'sdk.session.init resume',
      )
      expect(init.cliSessionId).toBe(ORIG)
      // The untouched original transcript is never rewritten by a plain resume.
      expect(readJsonl(transcriptFor(ORIG, tmp)).map((l) => l.type)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ])
    } finally {
      await fx.stop()
    }
  })

  it('a dropsTurn guard that is NOT the raw-chain successor of the resume point refuses with the SDK prefix', async () => {
    const fx = launch({ rules: [] })
    try {
      const { cliSessionId: ORIG } = await seedTwoTurns(fx)
      const parentLines = readJsonl(transcriptFor(ORIG, tmp))
      // Fork at u1: the successor is a1; a guard naming anything else is the
      // SDK's refused-completion contract (freshell retries once guard-less).
      fx.send({
        type: 'create',
        protocol: 2,
        requestId: 'req-refused',
        cwd: tmp,
        // dropsTurn a2 — NOT the successor of u1
        boot: { kind: 'fork', resume: ORIG, resumeSessionAt: parentLines[0].uuid, dropsTurn: parentLines[3].uuid },
      })
      // This fake still reports the refusal after its placeholder `created`, the
      // shape from before sidecar protocol v2 (the real sidecar now answers
      // create.failed{FORK_GUARD_REFUSED} instead: test/unit/claude-sidecar/
      // boot-handshake.test.ts); the server's rollback treats both as the guard
      // refusal.
      await fx.waitLine((o) => o.type === 'created' && o.requestId === 'req-refused', 'created refused fork')
      const refusal = await fx.waitLine(
        (o) => typeof o?.message === 'string' && o.message.startsWith('Resume rejected by --resume-drops-turn:'),
        'resume-drops-turn refusal line',
      )
      expect(refusal.message).toContain(parentLines[3].uuid)
      // The refused fork must never mint a DURABLE session: the only
      // sdk.session.init on the whole wire is ORIG's own (from seedTwoTurns).
      expect(
        fx.stdoutLines().filter((o) => o.type === 'sdk.session.init'),
        'no sdk.session.init ever lands for a refused fork',
      ).toHaveLength(1)
    } finally {
      await fx.stop()
    }
  })
})
