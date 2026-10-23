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

/** Whether the fake wrote an idle status between event indexes `from` and `to`. */
function idleBetween(rt: KilroyRuntime, from: number, to: number): boolean {
  return rt.events().slice(from, to).some((e) => e.type === 'sdk.status' && e.status === 'idle')
}

/**
 * Every frame the fake wrote before this call has been read: an interrupt with
 * nothing in flight is settled after all of them (it arms nothing). Returns the
 * index of its settle.
 */
async function readEverythingSoFar(rt: KilroyRuntime, sessionId: string): Promise<number> {
  rt.send({ type: 'interrupt', sessionId })
  const settle = await rt.nextEvent('sdk.interrupt_settled')
  return rt.events().indexOf(settle)
}

describe('harness-06 fake kilroy runtime', () => {
  it('answers create with created-first, init, idle — and records the invocation', async () => {
    const { rt, logPath } = await make()
    const sessionId = '11111111-1111-4111-8111-111111111111'
    rt.send({ type: 'create', sessionId, requestId: 'r-1', cwd: '/tmp/fixture-cwd', model: 'claude-opus-4-6' })

    const created = (await rt.nextEvent('created')) as { requestId: string; sessionId: string }
    expect(created.requestId).toBe('r-1')
    expect(created.sessionId).toBe(sessionId)

    const init = (await rt.nextEvent('sdk.session.init', undefined, 5000)) as {
      sessionId: string; cliSessionId: string; model: string; cwd: string
    }
    expect(init.sessionId).toBe(created.sessionId)
    expect(init.cliSessionId).toBe(sessionId)
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

  it('runs a full send turn: running -> assistant -> result(success, with its facts), with no edge and no idle after it', async () => {
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

    const result = (await rt.nextEvent('sdk.result')) as Record<string, unknown>
    // The facts the server's verdict reads (it mints the edge, C18).
    expect(result).toMatchObject({ result: 'success', subtype: 'success', isError: false, terminalReason: 'completed' })

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'again' })
    await rt.nextEvent('sdk.result')
    expect(rt.events().filter((e) => e.type === 'sdk.turn.complete'), 'the fake mints no edge').toEqual([])
    // The result ends the turn, as with the real sidecar (which sends no idle):
    // nothing between the first turn's result and the second turn is an idle.
    const secondRunning = rt.events().findIndex(
      (e, i) => i > rt.events().indexOf(result) && e.type === 'sdk.status' && e.status === 'running',
    )
    expect(secondRunning).toBeGreaterThan(0)
    expect(idleBetween(rt, rt.events().indexOf(result), secondRunning), 'no per-turn idle').toBe(false)

    const ledger = await readLedger(logPath)
    expect(ledger.map((row) => (row.msg as { type: string }).type)).toEqual(['create', 'send', 'send'])
  })

  it('approval knob surfaces an approval request before completing (the server mints the waiting edge)', async () => {
    const { rt } = await make({ FAKE_KILROY_APPROVAL: '1', FAKE_KILROY_APPROVAL_DELAY_MS: '150' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'needs approval' })

    const request = (await rt.nextEvent('sdk.permission.request')) as { requestId: string; sessionId: string }
    expect(request.sessionId).toBe(created.sessionId)

    // Consume through the completion, THEN assert ordering in the full stream.
    await rt.nextEvent('sdk.assistant')
    await rt.nextEvent('sdk.result') // allowed by the fake after the delay
    const types = rt.events().map((e) => (e as { type: string }).type)
    expect(types.indexOf('sdk.permission.request')).toBeLessThan(types.indexOf('sdk.permission.cancelled'))
    expect(types.indexOf('sdk.permission.cancelled')).toBeLessThan(types.indexOf('sdk.assistant'))
    expect(types.indexOf('sdk.assistant')).toBeLessThan(types.indexOf('sdk.result'))
    expect(types.filter((type) => type === 'sdk.turn.waiting' || type === 'sdk.turn.complete'), 'the fake mints no edge').toEqual([])
  })

  it('failure knob yields a failed result with its error text, and no edge (the server rings it)', async () => {
    const { rt } = await make({ FAKE_KILROY_FAIL_RESULT: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'fail me' })
    const result = (await rt.nextEvent('sdk.result')) as Record<string, unknown>
    expect(result).toMatchObject({ subtype: 'error_during_execution', isError: true, errorText: 'Fixture turn failed', sessionId: created.sessionId })
    expect(result).not.toHaveProperty('terminalReason')
    await readEverythingSoFar(rt, created.sessionId)
    expect(rt.events().filter((e) => e.type === 'sdk.turn.complete' || e.type === 'sdk.error'), 'no edge, no banner').toEqual([])
  })

  it('interrupt on a HELD in-flight turn settles ok:true with its stopId, then the aborted result — never an edge or an sdk.exit', async () => {
    const { rt } = await make({ FAKE_KILROY_HOLD_TURN: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'hold' })
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'running')

    rt.send({ type: 'interrupt', sessionId: created.sessionId, stopId: 'stop-1' })
    const settle = (await rt.nextEvent('sdk.interrupt_settled')) as { ok: boolean; stopId: string }
    expect(settle).toMatchObject({ ok: true, stopId: 'stop-1' })
    const result = (await rt.nextEvent('sdk.result')) as Record<string, unknown>
    expect(result).toMatchObject({ result: 'error_during_execution', terminalReason: 'aborted_streaming' })
    const settled = await readEverythingSoFar(rt, created.sessionId)
    // The stopped turn's result ends it: no idle follows (the real sidecar sends none).
    expect(idleBetween(rt, rt.events().indexOf(result), settled), 'no idle after the stopped result').toBe(false)

    // No attention edge on the wire (the server silences the user's own
    // Stop) and NEVER an sdk.exit (interrupt ends the TURN, not the session).
    expect(
      rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete'),
      'a user-initiated interrupt rings no attention edge',
    ).toBe(false)
    expect(
      rt.events().some((e) => (e as { type: string }).type === 'sdk.exit'),
      'interrupt must never end the session',
    ).toBe(false)
  })

  it('interrupt during a scripted approval defers to the turn: its aborted result, no edge, and the NEXT turn runs', async () => {
    const { rt } = await make({ FAKE_KILROY_APPROVAL: '1', FAKE_KILROY_APPROVAL_DELAY_MS: '1000' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'interrupt me mid-approval' })
    await rt.nextEvent('sdk.permission.request')
    // The turn is provably in flight (inside the approval await) — interrupt.
    rt.send({ type: 'interrupt', sessionId: created.sessionId })
    const settle = (await rt.nextEvent('sdk.interrupt_settled')) as { ok: boolean }
    expect(settle.ok).toBe(true)
    // The in-flight scripted completion lands with the aborted result.
    const result = (await rt.nextEvent('sdk.result')) as Record<string, unknown>
    expect(result).toMatchObject({ result: 'error_during_execution', terminalReason: 'aborted_streaming' })

    // The NEXT turn on the same live session runs to success.
    rt.send({ type: 'send', sessionId: created.sessionId, text: 'next unrelated turn' })
    const next = (await rt.nextEvent('sdk.result')) as Record<string, unknown>
    expect(next).toMatchObject({ subtype: 'success' })
    expect(rt.events().filter((e) => e.type === 'sdk.turn.complete'), 'the fake mints no edge').toEqual([])
  })

  it('an interrupt with NOTHING in flight settles ok:true and leaves the session as it was: the next turn runs', async () => {
    const { rt } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'interrupt', sessionId: created.sessionId })
    const settle = (await rt.nextEvent('sdk.interrupt_settled')) as { ok: boolean }
    expect(settle.ok).toBe(true)
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'next unrelated turn' })
    expect(await rt.nextEvent('sdk.result')).toMatchObject({ subtype: 'success' })
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
