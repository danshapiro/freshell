import { describe, it, expect, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnFakeKilroy, type KilroyRuntime } from './kilroy-runtime.js'

/**
 * HARNESS-06 kilroy-runtime coverage: the harness-level "full Kilroy runtime"
 * fake. It must speak the real claude-sidecar newline-JSON protocol
 * (crates/freshell-claude-sidecar/index.mjs doc comment) with kilroy flavour,
 * record every request to a JSONL ledger ("records Kilroy invocations"), and
 * expose controllable approval / failure / crash / resume edges.
 */

const runtimes: KilroyRuntime[] = []
const tmpDirs: string[] = []

async function make(env: NodeJS.ProcessEnv = {}): Promise<{ rt: KilroyRuntime; logPath: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-h06-kilroy-'))
  tmpDirs.push(dir)
  const logPath = path.join(dir, 'requests.jsonl')
  const rt = await spawnFakeKilroy({ FAKE_KILROY_LOG: logPath, ...env })
  runtimes.push(rt)
  return { rt, logPath }
}

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.kill()
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop()!, { recursive: true, force: true })
})

async function readLedger(logPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await fsp.readFile(logPath, 'utf8')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

describe('harness-06 fake kilroy runtime', () => {
  it('answers create with created-first, init, idle — and records the invocation', async () => {
    const { rt, logPath } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp/fixture-cwd', model: 'claude-opus-4-6' })

    const created = (await rt.nextEvent('created')) as { requestId: string; sessionId: string }
    expect(created.requestId).toBe('r-1')
    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{16,32}$/) // bare nanoid shape

    const init = (await rt.nextEvent('sdk.session.init', undefined, 5000)) as {
      sessionId: string; cliSessionId: string; model: string; cwd: string
    }
    expect(init.sessionId).toBe(created.sessionId)
    expect(init.cliSessionId).toMatch(/^[0-9a-f-]{36}$/) // canonical durable UUID
    expect(init.cwd).toBe('/tmp/fixture-cwd')

    const idle = (await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle', 5000))
    expect((idle as { sessionId: string }).sessionId).toBe(created.sessionId)

    // The FIRST stdout line must be `created` (read_created discards earlier sdk.*).
    expect((rt.events()[0] as { type: string }).type).toBe('created')

    const ledger = await readLedger(logPath)
    expect(ledger).toHaveLength(1)
    expect((ledger[0].msg as { type: string }).type).toBe('create')
    expect((ledger[0].msg as { cwd?: string }).cwd).toBe('/tmp/fixture-cwd')
  })

  it('runs a full send turn: running -> assistant -> result(success) -> turn.complete -> idle', async () => {
    const { rt, logPath } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'hello kilroy' })

    const running = (await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'running'))
    expect((running as { sessionId: string }).sessionId).toBe(created.sessionId)

    const assistant = (await rt.nextEvent('sdk.assistant')) as { content: Array<{ type: string; text?: string }> }
    expect(Array.isArray(assistant.content)).toBe(true)
    expect(assistant.content[0].type).toBe('text')
    expect(assistant.content[0].text).toContain('hello kilroy')

    const result = (await rt.nextEvent('sdk.result')) as { result: string }
    expect(result.result).toBe('success')

    const complete = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(typeof complete.at).toBe('number')
    expect(complete.at).toBeGreaterThan(0)

    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    // A second turn's `at` must exceed the first (monotonic completion clock).
    rt.send({ type: 'send', sessionId: created.sessionId, text: 'again' })
    const complete2 = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(complete2.at).toBeGreaterThan(complete.at)

    const ledger = await readLedger(logPath)
    expect(ledger.map((row) => (row.msg as { type: string }).type)).toEqual(['create', 'send', 'send'])
  })

  it('approval knob surfaces sdk.turn.waiting before completing (0->=1 pending edge)', async () => {
    const { rt } = await make({ FAKE_KILROY_APPROVAL: '1', FAKE_KILROY_APPROVAL_DELAY_MS: '150' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'needs approval' })

    const waiting = (await rt.nextEvent('sdk.turn.waiting')) as { at: number; sessionId: string }
    expect(waiting.sessionId).toBe(created.sessionId)
    expect(typeof waiting.at).toBe('number')

    // Consume through the completion, THEN assert ordering in the full stream.
    await rt.nextEvent('sdk.assistant')
    await rt.nextEvent('sdk.turn.complete') // auto-allowed after the delay
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
    const types = rt.events().map((e) => (e as { type: string }).type)
    expect(types.indexOf('sdk.turn.waiting')).toBeLessThan(types.indexOf('sdk.assistant'))
    expect(types.indexOf('sdk.assistant')).toBeLessThan(types.indexOf('sdk.turn.complete'))
  })

  it('failure knob yields result(error) AND the unified turn.complete edge (needs-attention)', async () => {
    const { rt } = await make({ FAKE_KILROY_FAIL_RESULT: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'fail me' })
    const result = (await rt.nextEvent('sdk.result')) as { result: string }
    expect(result.result).not.toBe('success')
    const complete = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(Number.isFinite(complete.at)).toBe(true)
    expect((complete as { sessionId?: string }).sessionId).toBe(created.sessionId)
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
    // Stream order mirrors the real sidecar: result -> edge -> idle. An error
    // turn end rings the SAME unified attention edge a success would — the
    // old success-only guard is gone (the fake now imports the REAL gate).
    const types = rt.events().map((e) => (e as { type: string }).type)
    expect(types.indexOf('sdk.turn.complete')).toBeGreaterThan(types.indexOf('sdk.result'))
    expect(
      rt.events().filter((e) => (e as { type: string }).type === 'sdk.turn.complete'),
      'exactly one edge for the errored turn',
    ).toHaveLength(1)
  })

  it('interrupt on a HELD in-flight turn settles ok:true; the armed gate consumes the synthesized interrupted result — never an sdk.exit', async () => {
    const { rt } = await make({ FAKE_KILROY_HOLD_TURN: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'hold' })
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'running')

    rt.send({ type: 'interrupt', sessionId: created.sessionId })
    const settle = (await rt.nextEvent('sdk.interrupt_settled')) as { ok: boolean }
    expect(settle.ok).toBe(true)
    const result = (await rt.nextEvent('sdk.result')) as { result: string }
    expect(result.result).toBe('error_during_execution')
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    // TOTAL silence for the user-initiated interrupt: no attention edge on
    // the wire — the armed gate consumed the interrupted turn's own result —
    // and NEVER an sdk.exit (interrupt ends the TURN, not the session; the
    // old fake's aborted-stream sdk.exit + session-drop was the stale
    // pre-unification mirror).
    expect(
      rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete'),
      'a user-initiated interrupt rings no attention edge',
    ).toBe(false)
    expect(
      rt.events().some((e) => (e as { type: string }).type === 'sdk.exit'),
      'interrupt must never end the session',
    ).toBe(false)
  })

  it('interrupt during a scripted approval defers to the turn: forced non-success result, gate-consumed edge, and the NEXT turn rings', async () => {
    const { rt } = await make({ FAKE_KILROY_APPROVAL: '1', FAKE_KILROY_APPROVAL_DELAY_MS: '1000' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'interrupt me mid-approval' })
    await rt.nextEvent('sdk.turn.waiting')
    // The turn is provably in flight (inside the approval await) — interrupt.
    rt.send({ type: 'interrupt', sessionId: created.sessionId })
    const settle = (await rt.nextEvent('sdk.interrupt_settled')) as { ok: boolean }
    expect(settle.ok).toBe(true)
    // The in-flight scripted completion lands with the forced non-success
    // subtype; its ring is consumed by the armed gate.
    const result = (await rt.nextEvent('sdk.result')) as { result: string }
    expect(result.result).toBe('error_during_execution')
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
    expect(
      rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete'),
      'the interrupted turn stays silent (the gate consumed its result)',
    ).toBe(false)

    // No stray mark survived the consumed interrupt: the NEXT turn on the
    // same live session rings again (the accepted-interrupt mark is
    // single-use by construction).
    rt.send({ type: 'send', sessionId: created.sessionId, text: 'next unrelated turn' })
    const complete = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(Number.isFinite(complete.at)).toBe(true)
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
    expect(
      rt.events().filter((e) => (e as { type: string }).type === 'sdk.turn.complete'),
      'exactly one edge — the next turn rings; the interrupt never did',
    ).toHaveLength(1)
  })

  it('an interrupt with NOTHING in flight settles ok:true and arms nothing — the next turn still rings (task-004 F-I1 parity)', async () => {
    const { rt } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'interrupt', sessionId: created.sessionId })
    const settle = (await rt.nextEvent('sdk.interrupt_settled')) as { ok: boolean }
    expect(settle.ok).toBe(true)
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'next unrelated turn' })
    const complete = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(Number.isFinite(complete.at)).toBe(true)
  })

  it('crash knob kills the process mid-turn with NO completion edge (the Rust death synthesis rings, not the fake)', async () => {
    const { rt } = await make({ FAKE_KILROY_CRASH_ON_SEND: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'boom' })
    const code = await new Promise<number | null>((resolve) => {
      rt.proc.once('exit', (c) => resolve(c))
    })
    expect(code).toBe(3)
    // A real crash screams no protocol frame — the fake must NOT mint an
    // edge here or a real crash would double-ring (sidecar edge + the Rust
    // unrequested-death synthesis). The RUST side rings for process death.
    expect(rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete')).toBe(false)
  })

  it('resume keeps the durable cliSessionId and replays a session snapshot', async () => {
    const durable = randomUUID()
    const { rt } = await make()
    rt.send({ type: 'create', protocol: 2, requestId: 'r-1', cwd: '/tmp', boot: { kind: 'resume', resume: durable } })
    const init = (await rt.nextEvent('sdk.session.init')) as { cliSessionId: string }
    expect(init.cliSessionId).toBe(durable)
    const snapshot = (await rt.nextEvent('sdk.session.snapshot')) as { messages: unknown[] }
    expect(Array.isArray(snapshot.messages)).toBe(true)
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
  })

  it('shutdown exits 0', async () => {
    const { rt } = await make()
    rt.send({ type: 'shutdown' })
    const code = await new Promise<number | null>((resolve) => rt.proc.once('exit', (c) => resolve(c)))
    expect(code).toBe(0)
    runtimes.pop() // already exited
  })
})
