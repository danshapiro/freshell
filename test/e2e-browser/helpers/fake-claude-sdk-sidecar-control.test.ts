// Unit coverage for the AGENT-04/05/06 arms of the HARNESS-03 fake claude-SDK
// sidecar (`test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs`):
// permission.respond/question.respond pending-resolution (waiting edge
// re-fires), interrupt-time pending cancellation (cancel frames, never an
// sdk.exit), the parked-turn rule (no canned completion while parked), the
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
    'responds resolve the parked request and the waiting edge re-fires on a later raise',
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
        // Parked: NO completion frame may arrive before the respond.
        expect(fx.stdoutLines().some((o) => o.type === 'sdk.turn.complete')).toBe(false)
        expect(
          fx.stdoutLines().filter((o) => o.type === 'sdk.turn.waiting'),
          'first raise emits the 0->>=1 waiting edge exactly once',
        ).toHaveLength(1)

        // A second CONCURRENT raise (distinct request id, like the real
        // sidecar's nanoid mint) while parked must NOT re-fire the edge.
        fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION_2' })
        await fx.waitLine((o) => o.type === 'sdk.permission.request' && o.requestId === 'req-perm-2', 'second permission.request')
        expect(fx.stdoutLines().filter((o) => o.type === 'sdk.turn.waiting')).toHaveLength(1)

        // Resolving BOTH parked requests returns pending to 0, so the NEXT
        // raise crosses 0->>=1 again and the edge re-fires — the proof the
        // respond arm decrements the counter (pre-fix: reset only by interrupt).
        fx.send({ type: 'permission.respond', sessionId, requestId: 'req-perm-1', decision: { behavior: 'allow' } })
        await fx.waitLine((o) => o.type === 'sdk.turn.complete', 'turn completion after allow')
        fx.send({ type: 'permission.respond', sessionId, requestId: 'req-perm-2', decision: { behavior: 'allow' } })
        await fx.waitLine(
          (o) => o.type === 'sdk.turn.complete' && fx.stdoutLines().filter((r) => r.type === 'sdk.turn.complete').length >= 2,
          'second turn completion',
        )
        fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION' })
        await fx.waitLine(
          (o) => o.type === 'sdk.permission.request' && fx.stdoutLines().filter((r) => r.type === 'sdk.permission.request').length === 3,
          'third permission.request',
        )
        expect(
          fx.stdoutLines().filter((o) => o.type === 'sdk.turn.waiting'),
          'a respond decrements pending, so the next raise re-fires sdk.turn.waiting',
        ).toHaveLength(2)

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
      expect(fx.stdoutLines().filter((o) => o.type === 'sdk.turn.waiting')).toHaveLength(1)

      // Resolve a requestId that was NEVER raised. (deny matches no
      // RAISE_PROGRAM rule, so this respond emits nothing else; only the
      // resolvePending ledger bookkeeping runs.)
      fx.send({ type: 'permission.respond', sessionId, requestId: 'req-never-raised', decision: { behavior: 'deny' } })

      // The ledger must still hold the real parked request: the next raise
      // crosses NO 0->>=1 boundary, so no second waiting edge may fire.
      // Pre-fix resolvePending decremented `pending` on ANY respond, so the
      // re-raise below re-fired sdk.turn.waiting (pending desync).
      fx.send({ type: 'send', sessionId, text: 'RAISE_PERMISSION_2' })
      await fx.waitLine(
        (o) => o.type === 'sdk.permission.request' && o.requestId === 'req-perm-2',
        'second permission.request',
      )
      expect(
        fx.stdoutLines().filter((o) => o.type === 'sdk.turn.waiting'),
        'the foreign respond must not have decremented pending (no spurious waiting-edge re-fire)',
      ).toHaveLength(1)
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

      fx.send({ type: 'interrupt', sessionId })
      const cancelledPermission = await fx.waitLine((o) => o.type === 'sdk.permission.cancelled', 'sdk.permission.cancelled')
      expect(cancelledPermission).toMatchObject({ sessionId, requestId: 'req-perm-1' })
      const cancelledQuestion = await fx.waitLine((o) => o.type === 'sdk.question.cancelled', 'sdk.question.cancelled')
      expect(cancelledQuestion).toMatchObject({ sessionId, requestId: 'req-q-1' })
      await fx.waitLine((o) => o.type === 'sdk.status' && o.status === 'idle', 'idle after interrupt')

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
      await fx.waitLine((o) => o.type === 'sdk.turn.complete', 'post-interrupt completion')
    } finally {
      await fx.stop()
    }
  })

  it('a deny/errored completion emits sdk.result + idle and NEVER an sdk.turn.complete (D1-F2)', async () => {
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
      // Race-free: the errored sdk.result is the terminal marker for the deny
      // continuation (the following sdk.status idle renders synchronously).
      await fx.waitLine((o) => o.type === 'sdk.result' && o.result === 'error', 'errored sdk.result')

      const out = fx.stdoutLines()
      expect(
        out.filter((o) => o.type === 'sdk.turn.complete' && o.sessionId === sessionId),
        'a denied turn must NEVER emit a positive completion edge (AGENTS.md invariant)',
      ).toEqual([])
      expect(
        out.some((o) => o.type === 'sdk.assistant' && o.sessionId === sessionId
          && o.content?.[0]?.text?.includes('denied')),
        'the denial assistant frame arrived',
      ).toBe(true)
      expect(
        out.some((o) => o.type === 'sdk.status' && o.sessionId === sessionId && o.status === 'idle'),
        'the turn still closes to idle',
      ).toBe(true)

      // The outbound wire audit records exactly what went over stdout.
      const wires = readJsonl(eventsLog).filter((r) => r.kind === 'wire')
      expect(
        wires.some((r) => r.frame?.type === 'sdk.turn.complete'),
        'the wire audit too shows NO turn.complete for the deny',
      ).toBe(false)
      expect(
        wires.some((r) => r.frame?.type === 'sdk.result' && r.frame?.result === 'error'),
        'the wire audit records the errored sdk.result',
      ).toBe(true)

      // A plain turn still completes the positive way (fidelity pin):
      // sdk.result{success} AND sdk.turn.complete.
      fx.send({ type: 'send', sessionId, text: 'plain follow-up' })
      await fx.waitLine((o) => o.type === 'sdk.turn.complete', 'positive completion')
      const out2 = fx.stdoutLines()
      expect(out2.some((o) => o.type === 'sdk.result' && o.result === 'success')).toBe(true)
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
      await fx.waitLine((o) => o.type === 'sdk.turn.complete', 'completion')

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
    await fx.waitLine((o) => o.type === 'sdk.turn.complete', 'turn one completion')
    fx.send({ type: 'send', sessionId: created.sessionId, text: 'turn two' })
    await fx.waitLine(
      (o) => o.type === 'sdk.turn.complete' && fx.stdoutLines().filter((r) => r.type === 'sdk.turn.complete').length >= 2,
      'turn two completion',
    )
    return { sessionId: created.sessionId as string, cliSessionId: init.cliSessionId as string }
  }

  it('forkSession create mints a fresh cliSessionId and seeds the transcript prefix (s2rk correction)', async () => {
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

      // Fork at a1 (keep through-and-including a1); the resumeDropsTurn guard
      // is the RAW-chain successor of the resume point (u2).
      fx.send({
        type: 'create',
        requestId: 'req-fork',
        cwd: tmp,
        resumeSessionId: ORIG,
        resumeSessionAt: parentLines[1].uuid,
        forkSession: true,
        resumeDropsTurn: parentLines[2].uuid,
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
      fx.send({ type: 'create', requestId: 'req-plain', cwd: tmp, resumeSessionId: ORIG })
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

  it('forkSession=false resume keeps the existing same-cliSessionId behavior', async () => {
    const fx = launch({ rules: [] })
    try {
      const { cliSessionId: ORIG } = await seedTwoTurns(fx)
      fx.send({ type: 'create', requestId: 'req-resume', cwd: tmp, resumeSessionId: ORIG })
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

  it('a resumeDropsTurn guard that is NOT the raw-chain successor of the resume point refuses with the SDK prefix', async () => {
    const fx = launch({ rules: [] })
    try {
      const { cliSessionId: ORIG } = await seedTwoTurns(fx)
      const parentLines = readJsonl(transcriptFor(ORIG, tmp))
      // Fork at u1: the successor is a1; a guard naming anything else is the
      // SDK's refused-completion contract (freshell retries once guard-less).
      fx.send({
        type: 'create',
        requestId: 'req-refused',
        cwd: tmp,
        resumeSessionId: ORIG,
        resumeSessionAt: parentLines[0].uuid,
        forkSession: true,
        resumeDropsTurn: parentLines[3].uuid, // a2 — NOT the successor of u1
      })
      // The bridge placeholder `created` still lands (the real sidecar emits it
      // immediately, before the SDK query runs — crates/freshell-claude-sidecar/
      // index.mjs:278); the refusal surfaces on the wire AFTER it.
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
