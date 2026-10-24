import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  spawnKilroyRuntime,
  readKilroyLedger,
  type KilroyRuntime,
  type KilroyRuntimeOptions,
} from './kilroy-runtime.js'

// Drive the production sidecar, not a second implementation of its protocol.
// The simulator supplies model turns and records the real SDK's inputs.
const runtimes: KilroyRuntime[] = []
async function make(options: KilroyRuntimeOptions = {}): Promise<KilroyRuntime> {
  const runtime = await spawnKilroyRuntime({ timeScale: 0.02, ...options })
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.kill()
})

async function create(rt: KilroyRuntime, extra: Record<string, unknown> = {}): Promise<string> {
  const sessionId = randomUUID()
  rt.send({ type: 'create', protocol: 2, sessionType: 'kilroy', sessionId, requestId: 'create', cwd: rt.cwd, boot: { kind: 'fresh' }, ...extra })
  const answer = await rt.nextEvent('created')
  return answer.sessionId as string
}

function send(rt: KilroyRuntime, sessionId: string, text: string): string {
  const uuid = randomUUID()
  rt.send({ type: 'send', sessionId, uuid, text })
  return uuid
}

function serverOnlyFrames(rt: KilroyRuntime) {
  return rt.events().filter((event) => ['sdk.turn.complete', 'sdk.turn.waiting', 'sdk.exit'].includes(event.type))
}

async function barrier(rt: KilroyRuntime, sessionId: string) {
  const requestId = randomUUID()
  rt.send({ type: 'configure', sessionId, requestId, settings: {} })
  await rt.nextEvent('sdk.configured', (event) => event.requestId === requestId)
}

const APPROVAL_PROGRAM = {
  rules: [{
    on: 'msg:prompt', match: { text: 'needs approval' },
    emit: [
      { kind: 'approval', data: { tool: 'Bash', input: { command: 'ls' } } },
      { kind: 'text', data: { text: 'approved reply' } },
    ],
  }],
}

describe('harness-06 production Kilroy runtime', () => {
  it('answers create first with the native UUID and defers session init until a real prompt', async () => {
    const rt = await make()
    const sessionId = await create(rt, { model: 'claude-opus-4-6' })
    expect(rt.events()[0]).toMatchObject({ type: 'created', requestId: 'create', sessionId, protocol: 2 })
    rt.send({ type: 'interrupt', sessionId, stopId: 'idle-before-prompt' })
    await rt.nextEvent('sdk.interrupt_settled')
    expect(rt.events().filter((event) => event.type === 'sdk.session.init')).toEqual([])
    const query = (await readKilroyLedger(rt.ledgerPath)).find((row) => row.kind === 'query')!
    expect(query.options).toMatchObject({ sessionId, cwd: rt.cwd, model: 'claude-opus-4-6' })

    send(rt, sessionId, 'first prompt')
    expect(await rt.nextEvent('sdk.session.init')).toMatchObject({ sessionId, cliSessionId: sessionId, cwd: rt.cwd, model: 'claude-opus-4-6' })
    await rt.nextEvent('sdk.result')
  })

  it('runs successive real turns with their submitted UUIDs and result facts, and mints no edge or synthetic idle', async () => {
    const rt = await make({ program: { rules: [{ on: 'msg:prompt', emit: [{ kind: 'text', data: { text: 'kilroy reply' } }] }] } })
    const sessionId = await create(rt)
    const first = send(rt, sessionId, 'hello kilroy')
    const assistant = await rt.nextEvent('sdk.assistant')
    expect(assistant.content).toEqual([{ type: 'text', text: 'kilroy reply' }])
    const result = await rt.nextEvent('sdk.result')
    expect(result).toMatchObject({ sessionId, result: 'success', subtype: 'success', isError: false, terminalReason: 'completed' })
    const second = send(rt, sessionId, 'again')
    await rt.nextEvent('sdk.result')
    const prompts = (await readKilroyLedger(rt.ledgerPath)).filter((row) => row.kind === 'prompt')
    expect(prompts.map((row) => [row.sessionId, row.uuid, row.text])).toEqual([
      [sessionId, first, 'hello kilroy'], [sessionId, second, 'again'],
    ])
    expect(serverOnlyFrames(rt)).toEqual([])
    expect(rt.events().slice(rt.events().indexOf(result)).filter((event) => event.type === 'sdk.status' && event.status === 'idle')).toEqual([])
  })

  it('waits for the actual approval decision before completing and records what canUseTool received', async () => {
    const rt = await make({ program: APPROVAL_PROGRAM })
    const sessionId = await create(rt)
    send(rt, sessionId, 'needs approval')
    const request = await rt.nextEvent('sdk.permission.request')
    expect(request).toMatchObject({ sessionId, tool: { name: 'Bash', input: { command: 'ls' } } })
    await barrier(rt, sessionId)
    expect(rt.events().some((event) => event.type === 'sdk.result')).toBe(false)
    expect((await readKilroyLedger(rt.ledgerPath)).filter((row) => row.kind === 'can_use_tool')).toEqual([])
    rt.send({ type: 'permission.respond', sessionId, requestId: request.requestId, decision: { behavior: 'allow', updatedInput: { command: 'ls' } } })
    // A user answer resolves canUseTool; cancellation frames belong to aborts.
    const assistant = await rt.nextEvent('sdk.assistant', (event) => event.content?.some((block: any) => block.text === 'approved reply'))
    const result = await rt.nextEvent('sdk.result')
    expect(rt.events().indexOf(request)).toBeLessThan(rt.events().indexOf(assistant))
    expect(rt.events().indexOf(assistant)).toBeLessThan(rt.events().indexOf(result))
    const decision = (await readKilroyLedger(rt.ledgerPath)).find((row) => row.kind === 'can_use_tool')!
    expect(decision.decision).toMatchObject({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(serverOnlyFrames(rt)).toEqual([])
  })

  it('forwards a failed result with its error text while leaving attention accounting to Rust', async () => {
    const rt = await make({ program: { rules: [{ on: 'msg:prompt', emit: [{ kind: 'completion', data: { subtype: 'error_max_turns', errors: ['Fixture turn failed'] } }] }] } })
    const sessionId = await create(rt)
    send(rt, sessionId, 'fail me')
    const result = await rt.nextEvent('sdk.result')
    expect(result).toMatchObject({ sessionId, subtype: 'error_max_turns', isError: true, errorText: 'Fixture turn failed' })
    await barrier(rt, sessionId)
    expect(serverOnlyFrames(rt)).toEqual([])
    expect(rt.events().filter((event) => event.type === 'sdk.error')).toEqual([])
  })

  it('interrupts an actual held turn with the Stop receipt and aborted result, then runs the next turn', async () => {
    const rt = await make()
    const sessionId = await create(rt)
    send(rt, sessionId, 'HANG')
    await rt.nextEvent('sdk.status', (event) => event.status === 'requesting')
    rt.send({ type: 'interrupt', sessionId, stopId: 'stop-1' })
    expect(await rt.nextEvent('sdk.interrupt_settled')).toMatchObject({ sessionId, stopId: 'stop-1', ok: true, stillQueued: [] })
    const result = await rt.nextEvent('sdk.result')
    expect(result).toMatchObject({ sessionId, subtype: 'error_during_execution', isError: true })
    expect(result.terminalReason).toMatch(/^aborted_/)
    send(rt, sessionId, 'next unrelated turn')
    expect(await rt.nextEvent('sdk.result')).toMatchObject({ subtype: 'success' })
    expect(serverOnlyFrames(rt)).toEqual([])
  })

  it('interrupts a pending approval through the SDK and keeps the session usable', async () => {
    const rt = await make({ program: APPROVAL_PROGRAM })
    const sessionId = await create(rt)
    send(rt, sessionId, 'needs approval')
    const request = await rt.nextEvent('sdk.permission.request')
    rt.send({ type: 'interrupt', sessionId, stopId: 'stop-approval' })
    expect(await rt.nextEvent('sdk.interrupt_settled')).toMatchObject({ sessionId, stopId: 'stop-approval', ok: true })
    expect(await rt.nextEvent('sdk.result')).toMatchObject({ sessionId, subtype: 'error_during_execution', terminalReason: 'aborted_streaming' })
    expect(rt.events().some((event) => event.type === 'sdk.permission.cancelled' && event.requestId === request.requestId)).toBe(true)
    send(rt, sessionId, 'next unrelated turn')
    expect(await rt.nextEvent('sdk.result')).toMatchObject({ subtype: 'success' })
    expect(serverOnlyFrames(rt)).toEqual([])
  })

  it('settles an idle interrupt without a synthetic status or latch that affects the next turn', async () => {
    const rt = await make()
    const sessionId = await create(rt)
    rt.send({ type: 'interrupt', sessionId, stopId: 'idle-stop' })
    expect(await rt.nextEvent('sdk.interrupt_settled')).toMatchObject({ sessionId, stopId: 'idle-stop', ok: true })
    send(rt, sessionId, 'next unrelated turn')
    expect(await rt.nextEvent('sdk.result')).toMatchObject({ subtype: 'success' })
    expect(rt.events().filter((event) => event.type === 'sdk.status' && event.status === 'idle')).toEqual([])
    expect(serverOnlyFrames(rt)).toEqual([])
  })

  it('reports a mid-turn CLI crash as the real stream end and process exit, without a result or edge', async () => {
    const rt = await make({ program: { rules: [{ on: 'msg:prompt', emit: [{ kind: 'crash' }] }] } })
    const sessionId = await create(rt)
    send(rt, sessionId, 'crash now')
    expect(await rt.nextEvent('sdk.stream.ended')).toMatchObject({ sessionId, reason: 'cli_exited' })
    expect(await rt.waitExit()).toMatchObject({ code: 3, signal: null })
    expect(rt.events().filter((event) => event.type === 'sdk.result')).toEqual([])
    expect(serverOnlyFrames(rt)).toEqual([])
  })

  it('resumes the saved native conversation and initializes it only after the next prompt', async () => {
    const rt = await make()
    const durable = randomUUID()
    const project = path.join(rt.claudeConfigDir, 'projects', 'saved')
    await fs.mkdir(project, { recursive: true })
    const saved = path.join(project, `${durable}.jsonl`)
    await fs.writeFile(saved, `${JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: durable, cwd: rt.cwd, message: { role: 'user', content: 'saved history' } })}\n`)
    expect(await create(rt, { sessionId: durable, boot: { kind: 'resume', resume: durable } })).toBe(durable)
    expect(rt.events().some((event) => event.type === 'sdk.session.init')).toBe(false)
    const query = (await readKilroyLedger(rt.ledgerPath)).find((row) => row.kind === 'query')!
    expect(query.options.resume).toBe(durable)
    const uuid = send(rt, durable, 'continue the conversation')
    expect(await rt.nextEvent('sdk.session.init')).toMatchObject({ sessionId: durable, cliSessionId: durable })
    await rt.nextEvent('sdk.result')
    const prompt = (await readKilroyLedger(rt.ledgerPath)).find((row) => row.kind === 'prompt')!
    expect(prompt).toMatchObject({ sessionId: durable, uuid, text: 'continue the conversation' })
    await expect.poll(() => fs.readFile(saved, 'utf8')).toContain('continue the conversation')
    const lines = (await fs.readFile(saved, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: { role: 'user', content: 'saved history' } }),
      expect.objectContaining({ sessionId: durable, uuid, type: 'user' }),
    ]))
  })

  it('shutdown exits zero even before a session is created', async () => {
    const rt = await make()
    rt.send({ type: 'shutdown' })
    expect(await rt.waitExit()).toEqual({ code: 0, signal: null })
  })

  it('cleanup confirms the sidecar exit and removes the owned workspace and ledger', async () => {
    const rt = await make()
    const sessionId = await create(rt)
    const boot = (await readKilroyLedger(rt.ledgerPath)).find((row) => row.kind === 'boot')!
    const cliPid = boot.cliPid as number
    let cliStart: string | undefined
    const running = async () => {
      if (process.platform === 'linux') {
        try {
          const stat = await fs.readFile(`/proc/${cliPid}/stat`, 'utf8')
          const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
          if (cliStart !== undefined && fields[19] !== cliStart) return false
          cliStart ??= fields[19]
          return fields[0] !== 'Z' && fields[0] !== 'X'
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      }
      try { process.kill(cliPid, 0); return true } catch { return false }
    }
    expect(sessionId).toBe(boot.sessionId)
    expect(await running(), 'the actual simulated CLI is alive before cleanup').toBe(true)
    await rt.kill()
    expect(rt.proc.exitCode).toBe(0)
    expect(rt.proc.signalCode).toBeNull()
    await expect.poll(running).toBe(false)
    await expect(fs.stat(rt.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(rt.ledgerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
