/**
 * HARNESS-03 — deterministic provider fixtures: fixture-only contract spec.
 *
 * Invokes each of the seven fake provider executables DIRECTLY (no Freshell
 * server boots — the fixtures are the deliverable; later TERM/AGENT items wire
 * them into the real pane picker/server later) and asserts, per provider:
 *
 *   1. the launch ledger recorded the exact argv/cwd/pid and the allowlisted
 *      env probe (and nothing secret);
 *   2. scripted session/activity/approval/question/completion/crash/resume
 *      events land in the normalized event ledger in scripted order;
 *   3. the provider's wire surface carries the real protocol shape (stdout
 *      markers + bare BEL for terminal CLIs; newline-JSON sdk.* frames for
 *      the kilroy/claude sidecar; WS JSON-RPC notifications for the codex
 *      app-server; SSE frames for the opencode server);
 *   4. crash exits with the scripted code after recording the crash event;
 *   5. resume: each provider's real resume argv shape yields a resume event.
 *
 * Server-kind independence: the spec uses bare `@playwright/test` (no
 * assertions against the fixtures — that sameness IS the fixture-only proof.
 */
import { test, expect } from '@playwright/test'
import { WebSocket } from 'ws'
import {
  childPidsOf,
  launchProviderFixture,
  type LaunchedFixture,
} from '../helpers/provider-fixture-launcher.js'

const TURN_PROGRAM = {
  rules: [
    {
      on: 'stdin:^do work$',
      emit: [
        { kind: 'activity', data: { state: 'busy' } },
        { kind: 'approval', data: { id: 'ap-1', tool: 'Bash', input: 'rm -rf /tmp/x' } },
        { kind: 'question', data: { id: 'q-1', text: 'which file?' } },
        { kind: 'completion', delayMs: 30, data: { subtype: 'success' } },
      ],
    },
    { on: 'stdin:explode', emit: [{ kind: 'crash', data: { code: 3 }, delayMs: 10 }] },
  ],
}

function expectLedgerRow(fixture: LaunchedFixture, provider: string, argv: string[]) {
  const ledger = fixture.readLedger()
  expect(ledger.length).toBeGreaterThan(0)
  const row = ledger[0]
  expect(row.provider).toBe(provider)
  expect(row.argv).toEqual(argv)
  expect(row.pid).toBe(fixture.pid)
  expect(row.cwd).toBe(fixture.cwd)
  // The env probe is recorded via the FRESHELL_FAKE_ENV_RECORD allowlist…
  expect(row.env.HARNESS03_PROBE).toBe(`probe-${provider}`)
  // …and nothing beyond control keys + the probe ever lands in the ledger.
  for (const key of Object.keys(row.env)) {
    expect(key.startsWith('FRESHELL_FAKE_') || key === 'HARNESS03_PROBE').toBe(true)
  }
}

const PROBE_ENV = {
  FRESHELL_FAKE_ENV_RECORD: 'HARNESS03_PROBE',
}

for (const provider of ['claude', 'gemini', 'kimi'] as const) {
  test.describe(`terminal CLI fixture: ${provider}`, () => {
    let fixture: LaunchedFixture
    test.afterEach(async () => {
      await fixture?.stop()
    })

    test('records argv/env and emits controllable turn events', async () => {
      const argv = ['--session-id', '11111111-2222-4333-8444-555555555555', '--model', 'fixture-1']
      fixture = await launchProviderFixture({
        fixture: `fake-${provider}.mjs`,
        args: argv,
        program: TURN_PROGRAM,
        env: { ...PROBE_ENV, HARNESS03_PROBE: `probe-${provider}` },
      })
      await fixture.waitOutput(`${provider}> `)
      expectLedgerRow(fixture, provider, argv)
      const sessionEvent = await fixture.waitEvent('session')
      expect(sessionEvent.data.id).toBe('11111111-2222-4333-8444-555555555555')

      fixture.sendLine('do work')
      await fixture.waitEvent('completion')
      const kinds = fixture.readEvents().map((event) => event.kind)
      expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])
      const approval = fixture.readEvents().find((event) => event.kind === 'approval')
      expect(approval?.data).toMatchObject({ id: 'ap-1', tool: 'Bash' })
      // Wire realism: the completion renders as a bare BEL (the real
      // turn-complete signal, shared/turn-complete-signal.ts) + a done line.
      await fixture.waitOutput('\x07')
      expect(fixture.stdout).toContain('turn done.')
      expect(fixture.stdout).toContain(`approval requested [ap-1] Bash`)
      expect(fixture.stdout).toContain(`question [q-1] which file?`)

      fixture.sendLine('explode')
      expect(await fixture.exited()).toBe(3)
      expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
    })

    test('resume argv yields a resume event + resumed marker', async () => {
      fixture = await launchProviderFixture({
        fixture: `fake-${provider}.mjs`,
        args: ['--resume', 'sess-resumed-9'],
        env: { ...PROBE_ENV, HARNESS03_PROBE: `probe-${provider}` },
      })
      const resume = await fixture.waitEvent('resume')
      expect(resume.data.id).toBe('sess-resumed-9')
      await fixture.waitOutput(`${provider}: resumed session sess-resumed-9`)
    })
  })
}

test.describe('terminal CLI fixture: amplifier', () => {
  let fixture: LaunchedFixture
  test.afterEach(async () => {
    await fixture?.stop()
  })

  test('records argv/env and emits controllable turn events', async () => {
    fixture = await launchProviderFixture({
      fixture: 'fake-amplifier.mjs',
      args: [],
      program: TURN_PROGRAM,
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-amplifier' },
    })
    await fixture.waitOutput('amplifier> ')
    expectLedgerRow(fixture, 'amplifier', [])

    fixture.sendLine('do work')
    await fixture.waitEvent('completion')
    const kinds = fixture.readEvents().map((event) => event.kind)
    expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])

    fixture.sendLine('explode')
    expect(await fixture.exited()).toBe(3)
    expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
  })

  test('session resume --full-history shape yields a resume event', async () => {
    fixture = await launchProviderFixture({
      fixture: 'fake-amplifier.mjs',
      args: ['session', 'resume', '--full-history', 'amp-42'],
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-amplifier' },
    })
    const resume = await fixture.waitEvent('resume')
    expect(resume.data.id).toBe('amp-42')
    await fixture.waitOutput('amplifier: resumed session amp-42')
  })
})

// ── Kilroy / Claude-SDK sidecar ─────────────────────────────────────────────
// The kilroy/freshclaude providers are ONE protocol family: the Node sidecar
// speaking the newline-JSON bridge of crates/freshell-claude-sidecar/index.mjs
// (created FIRST, sdk.* after). Program rules key on bridge message types
// (`msg:create`, `msg:send`, …).

const SIDECAR_PROGRAM = {
  sessionId: '66666666-6666-4666-8666-666666666666',
  rules: [
    {
      on: 'msg:send',
      match: { text: 'please approve' },
      emit: [
        { kind: 'approval', data: { id: 'perm-1', tool: 'Bash', input: { command: 'rm -rf /tmp/x' } } },
        { kind: 'question', data: { id: 'q-1', text: 'which file should I edit?' } },
        { kind: 'completion', delayMs: 20, data: { subtype: 'success' } },
      ],
    },
    {
      on: 'msg:send',
      match: { text: 'explode' },
      emit: [{ kind: 'crash', data: { code: 5 }, delayMs: 10 }],
    },
  ],
}

async function sendSidecar(fixture: LaunchedFixture, msg: Record<string, unknown>) {
  fixture.proc.stdin?.write(`${JSON.stringify(msg)}\n`)
}

async function readSidecarLine(fixture: LaunchedFixture, pred: (obj: any) => boolean, what: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const lines = fixture.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const match = lines.find(pred)
    if (match) return match
    if (Date.now() > deadline) {
      throw new Error(`sidecar: timed out waiting for ${what}. stdout: ${fixture.stdout}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

for (const provider of ['kilroy', 'freshclaude'] as const) {
  test.describe(`claude-sdk sidecar fixture (${provider} flavour)`, () => {
    let fixture: LaunchedFixture
    test.afterEach(async () => {
      await fixture?.stop()
    })

    test('create/send protocol with controllable approval, question, completion', async () => {
      fixture = await launchProviderFixture({
        fixture: 'fake-claude-sdk-sidecar.mjs',
        program: SIDECAR_PROGRAM,
        env: {
          ...PROBE_ENV,
          HARNESS03_PROBE: `probe-${provider}`,
          FRESHELL_FAKE_PROVIDER: provider,
        },
      })
      await sendSidecar(fixture, { type: 'create', requestId: 'req-1', cwd: fixture.cwd, model: 'fixture-model' })
      const created = await readSidecarLine(fixture, (o) => o.type === 'created', 'created')
      expect(created.requestId).toBe('req-1')
      const sessionId = created.sessionId as string
      expect(sessionId).toBeTruthy()
      // Asserted after the first protocol exchange so the child is provably past
      // appendLaunchLedger (unlike terminal fixtures, a sidecar prints no prompt
      // to wait on).
      expectLedgerRow(fixture, provider, [])

      const init = await readSidecarLine(fixture, (o) => o.type === 'sdk.session.init', 'sdk.session.init')
      // created must precede every sdk.* frame (claude.rs read_created discards
      // earlier lines) — verify wire order.
      const raw = fixture.stdout
      expect(raw.indexOf('"created"')).toBeLessThan(raw.indexOf('"sdk.session.init"'))
      expect(init.cliSessionId).toBe('66666666-6666-4666-8666-666666666666')
      const sessionEvent = await fixture.waitEvent('session')
      expect(sessionEvent.data.cliSessionId).toBe('66666666-6666-4666-8666-666666666666')

      fixture.proc.stdin?.write(
        `${JSON.stringify({ type: 'send', sessionId, text: 'please approve' })}\n`,
      )
      const waiting = await readSidecarLine(fixture, (o) => o.type === 'sdk.turn.waiting', 'sdk.turn.waiting')
      expect(typeof waiting.at).toBe('number')
      const perm = await readSidecarLine(fixture, (o) => o.type === 'sdk.permission.request', 'sdk.permission.request')
      expect(perm).toMatchObject({
        sessionId,
        requestId: 'perm-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
      })
      const question = await readSidecarLine(fixture, (o) => o.type === 'sdk.question.request', 'sdk.question.request')
      expect(question.requestId).toBe('q-1')
      expect(question.questions[0]).toMatchObject({ question: 'which file should I edit?', multiSelect: false })
      const complete = await readSidecarLine(fixture, (o) => o.type === 'sdk.turn.complete', 'sdk.turn.complete')
      // D1-F2: sdk.turn.complete now mirrors the REAL protocol shape
      // {sessionId, at} exactly (the fixture `subtype` extension is gone) —
      // per-turn success/error truth lives on the always-emitted sdk.result.
      expect(complete.subtype).toBeUndefined()
      expect(typeof complete.at).toBe('number')
      const result = await readSidecarLine(fixture, (o) => o.type === 'sdk.result', 'sdk.result')
      expect(result.result).toBe('success')
      expect((await readSidecarLine(fixture, (o) => o.type === 'sdk.status' && o.status === 'idle', 'idle')).sessionId).toBe(sessionId)

      // The ledger also carries `kind:'wire'` outbound-frame audit rows
      // (D1-F2); the program-emission assertions filter to program kinds.
      const kinds = fixture.readEvents().map((event) => event.kind).filter((kind) => kind !== 'wire')
      expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])

      fixture.proc.stdin?.write(`${JSON.stringify({ type: 'send', sessionId, text: 'explode' })}\n`)
      expect(await fixture.exited()).toBe(5)
      expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
    })

    test('resume: create with resumeSessionId keeps the durable id and snapshots', async () => {
      fixture = await launchProviderFixture({
        fixture: 'fake-claude-sdk-sidecar.mjs',
        program: { rules: [] },
        env: {
          ...PROBE_ENV,
          HARNESS03_PROBE: `probe-${provider}`,
          FRESHELL_FAKE_PROVIDER: provider,
        },
      })
      await sendSidecar(fixture, {
        type: 'create',
        requestId: 'req-resume',
        cwd: fixture.cwd,
        resumeSessionId: '77777777-7777-4777-8777-777777777777',
      })
      await readSidecarLine(fixture, (o) => o.type === 'sdk.session.init', 'init')
      const initRaw = fixture.stdout
      expect(initRaw).toContain('77777777-7777-4777-8777-777777777777')
      await readSidecarLine(fixture, (o) => o.type === 'sdk.session.snapshot', 'snapshot')
      const resume = await fixture.waitEvent('resume')
      expect(resume.data.id).toBe('77777777-7777-4777-8777-777777777777')

      // interrupt + shutdown are part of the real protocol surface.
      const created = await readSidecarLine(fixture, (o) => o.type === 'created', 'created')
      fixture.proc.stdin?.write(JSON.stringify({ type: 'interrupt', sessionId: created.sessionId }) + '\n')
      fixture.proc.stdin?.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      expect(await fixture.exited()).toBe(0)
    })
  })
}

// ── Codex app-server fixture ────────────────────────────────────────────────
// WebSocket JSON-RPC, mirroring test/fixtures/coding-cli/codex-app-server/'s
// wire surface: initialize-gated RPCs, thread/start + rollout session_meta,
// turn/started + turn/completed notifications. Approval/question are rendered
// as fixture-namespaced notifications — freshcodex advertises
// `approvals:false, questions:false` (codex.rs) so no real bridge exists to
// mirror; the controllable surface is the point.

class CodexRpcClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  readonly notifications: any[] = []
  readonly closed: Promise<void>

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.closed = new Promise((resolve) => this.ws.on('close', () => resolve()))
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = this.pending.get(Number(msg.id))
        if (entry) {
          this.pending.delete(Number(msg.id))
          if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
          else entry.resolve(msg.result)
        }
      } else if (msg.method) {
        this.notifications.push(msg)
      }
    })
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async waitNotification(method: string, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const match = this.notifications.find((n) => n.method === method)
      if (match) return match
      if (Date.now() > deadline) {
        throw new Error(`codex fixture: timed out waiting for notification ${method}; saw ${JSON.stringify(this.notifications.map((n) => n.method))}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  close(): void {
    this.ws.close()
  }
}

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

test.describe('codex app-server fixture', () => {
  let fixture: LaunchedFixture
  let client: CodexRpcClient | undefined
  test.afterEach(async () => {
    client?.close()
    await fixture?.stop()
  })

  test('records argv/env, gates on initialize, and turns emit approval/question/completion', async () => {
    const port = await freePort()
    const listen = `ws://127.0.0.1:${port}`
    fixture = await launchProviderFixture({
      fixture: 'fake-codex-app-server.mjs',
      args: ['--listen', listen],
      program: {
        rules: [
          {
            on: 'rpc:turn/start',
            emit: [
              { kind: 'approval', data: { id: 'ap-c1', tool: 'shell', input: 'make test' } },
              { kind: 'question', data: { id: 'q-c1', text: 'pick a target' } },
            ],
          },
        ],
      },
      env: {
        ...PROBE_ENV,
        HARNESS03_PROBE: 'probe-codex-app-server',
      },
    })
    await fixture.waitOutput('listening on')

    // Gating first: anything before initialize is rejected.
    client = new CodexRpcClient(listen)
    await client.ready()
    await expect(client.call('thread/start', {})).rejects.toThrow(/initialize must complete/)

    const init = await client.call('initialize', { clientInfo: { name: 'harness-03' } })
    expect(init.userAgent).toContain('freshell')

    const started = await client.call('thread/start', { cwd: fixture.cwd })
    const threadId = started.thread.id as string
    expect(threadId).toBeTruthy()
    expect(started.approvalPolicy).toBe('never')
    const sessionEvent = await fixture.waitEvent('session')
    expect(sessionEvent.data.id).toBe(threadId)
    expectLedgerRow(fixture, 'codex-app-server', ['--listen', listen])

    // Durable realism: the rollout file's first line is the session_meta
    // record the Rust indexer parses.
    const rolloutPath = started.thread.path as string
    expect(rolloutPath).toContain('rollout-')
    await expect
      .poll(async () => {
        try {
          const first = (await import('node:fs')).readFileSync(rolloutPath, 'utf8').split('\n')[0]
          return JSON.parse(first).payload?.id ?? null
        } catch {
          return null
        }
      })
      .toBe(threadId)

    const turn = await client.call('turn/start', { threadId })
    expect(turn.turn.id).toBeTruthy()
    await client.waitNotification('turn/started')
    const approval = await client.waitNotification('freshell.fixture/approval')
    expect(approval.params).toMatchObject({ id: 'ap-c1', tool: 'shell' })
    const question = await client.waitNotification('freshell.fixture/question')
    expect(question.params).toMatchObject({ id: 'q-c1' })
    const completed = await client.waitNotification('turn/completed')
    expect(completed.params.turn.status).toBe('completed')

    const kinds = fixture.readEvents().map((event) => event.kind)
    expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])
  })

  test('thread/resume yields a resume event and keeps the durable id', async () => {
    const port = await freePort()
    const listen = `ws://127.0.0.1:${port}`
    fixture = await launchProviderFixture({
      fixture: 'fake-codex-app-server.mjs',
      args: ['--listen', listen],
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-codex-app-server' },
    })
    await fixture.waitOutput('listening on')
    client = new CodexRpcClient(listen)
    await client.ready()
    await client.call('initialize', {})
    const resumed = await client.call('thread/resume', { threadId: 'thread-old-7' })
    expect(resumed.thread.id).toBe('thread-old-7')
    const resume = await fixture.waitEvent('resume')
    expect(resume.data.id).toBe('thread-old-7')
  })

  test('a scripted crash kills the process mid-RPC and is recorded first', async () => {
    const port = await freePort()
    const listen = `ws://127.0.0.1:${port}`
    fixture = await launchProviderFixture({
      fixture: 'fake-codex-app-server.mjs',
      args: ['--listen', listen],
      program: {
        rules: [{ on: 'rpc:turn/start', emit: [{ kind: 'crash', data: { code: 9 }, delayMs: 10 }] }],
      },
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-codex-app-server' },
    })
    await fixture.waitOutput('listening on')
    client = new CodexRpcClient(listen)
    await client.ready()
    await client.call('initialize', {})
    await client.call('thread/start', {})
    void client.call('turn/start', {}).catch(() => {})
    expect(await fixture.exited()).toBe(9)
    expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
  })
})

// ── OpenCode server fixture ─────────────────────────────────────────────────
// HTTP REST + SSE `serve --port N --hostname H`, mirroring the consumer
// contract in server/fresh-agent/adapters/opencode/serve-events.ts (flat
// `data: {"type","properties"}\n\n` frames; server.connected on connect;
// session.status busy/idle + session.idle) and the resume probe in
// opencode_ws.rs (GET /session/:id).

class SseClient {
  readonly events: any[] = []
  private buffer = ''
  readonly closed: Promise<void>
  private controller = new AbortController()

  constructor(private url: string) {
    this.closed = this.pump().catch(() => undefined)
  }

  private async pump() {
    const response = await fetch(this.url, { signal: this.controller.signal })
    if (!response.ok || !response.body) throw new Error(`SSE connect failed: ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      this.buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
        const frame = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) {
            try {
              this.events.push(JSON.parse(line.slice('data:'.length).trim()))
            } catch {
              // non-JSON frame; ignore
            }
          }
        }
      }
    }
  }

  async waitEvent(type: string, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const match = this.events.find((event) => event.type === type)
      if (match) return match
      if (Date.now() > deadline) {
        throw new Error(`opencode fixture: timed out waiting for SSE ${type}; saw ${JSON.stringify(this.events.map((e) => e.type))}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  close(): void {
    this.controller.abort()
  }
}

test.describe('opencode server fixture', () => {
  let fixture: LaunchedFixture
  let sse: SseClient | undefined
  let base = ''
  test.afterEach(async () => {
    sse?.close()
    await fixture?.stop()
  })

  async function boot(program?: unknown): Promise<void> {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    fixture = await launchProviderFixture({
      fixture: 'fake-opencode-server.mjs',
      args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      program,
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-opencode-server' },
    })
    await fixture.waitOutput('listening on')
  }

  test('records argv/env and flows session/activity/approval/question/completion over REST+SSE', async () => {
    await boot({
      rules: [
        {
          on: 'http:POST /session/[^/]+/message',
          emit: [
            { kind: 'approval', data: { id: 'perm-o1', permission: 'bash', patterns: ['rm *'] } },
            { kind: 'question', data: { id: 'q-o1', text: 'which directory?' } },
          ],
        },
      ],
    })
    sse = new SseClient(`${base}/event`)
    await sse.waitEvent('server.connected')

    const created = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: fixture.cwd }),
    }).then((r) => r.json())
    const sessionId = created.id as string
    expect(sessionId).toBeTruthy()
    const sessionEvent = await fixture.waitEvent('session')
    expect(sessionEvent.data.id).toBe(sessionId)
    expectLedgerRow(fixture, 'opencode-server', [
      'serve',
      '--port',
      base.split(':').at(-1) as string,
      '--hostname',
      '127.0.0.1',
    ])

    const reply = await fetch(`${base}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'do work' }] }),
    })
    expect(reply.ok).toBe(true)

    const busy = await sse.waitEvent('session.status')
    expect(busy.properties.status.type).toBe('busy')
    const approval = await sse.waitEvent('permission.asked')
    expect(approval.properties).toMatchObject({ id: 'perm-o1', sessionID: sessionId })
    const question = await sse.waitEvent('question.asked')
    expect(question.properties).toMatchObject({ id: 'q-o1', sessionID: sessionId })
    await sse.waitEvent('session.idle')

    const kinds = fixture.readEvents().map((event) => event.kind)
    expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])
  })

  test('GET /session/:id on an existing session is the resume probe', async () => {
    await boot()
    const created = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json())
    const found = await fetch(`${base}/session/${created.id}`)
    expect(found.status).toBe(200)
    expect((await found.json()).id).toBe(created.id)
    const resume = await fixture.waitEvent('resume')
    expect(resume.data.id).toBe(created.id)

    const missing = await fetch(`${base}/session/does-not-exist`)
    expect(missing.status).toBe(404)
  })

  test('a scripted crash drops the listener and records the event first', async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    fixture = await launchProviderFixture({
      fixture: 'fake-opencode-server.mjs',
      args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      program: {
        rules: [
          { on: 'http:POST /session/[^/]+/message', emit: [{ kind: 'crash', data: { code: 4 }, delayMs: 10 }] },
        ],
      },
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-opencode-server' },
    })
    await fixture.waitOutput('listening on')
    const created = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json())
    await fetch(`${base}/session/${created.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'explode' }] }),
    })
    expect(await fixture.exited()).toBe(4)
    expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
    await expect(fetch(`${base}/session/status`).then((r) => r.status)).rejects.toThrow()
  })
})

// ── Hermeticity ─────────────────────────────────────────────────────────────
// The dispatch hard rule: fake executables must be hermetic — they must not
// invoke the real claude/codex/opencode binaries. Scrub mode proves the
// whole contract works with PATH=/nonexistent (a real-binary fallback would
// be unresolvable) and the fixture spawns ZERO child processes; the
// decoy-secret control proves the ledger can never exfiltrate credentials.

test.describe('provider fixtures are hermetic', () => {
  for (const provider of ['claude', 'gemini', 'kimi', 'amplifier'] as const) {
    test(`${provider}: full turn contract with scrubbed PATH, no children`, async () => {
      const fixture = await launchProviderFixture({
        fixture: provider === 'amplifier' ? 'fake-amplifier.mjs' : `fake-${provider}.mjs`,
        args: [],
        program: TURN_PROGRAM,
        env: { ...PROBE_ENV, HARNESS03_PROBE: `probe-${provider}` },
        scrub: true,
      })
      try {
        await fixture.waitOutput(`${provider}> `)
        fixture.sendLine('do work')
        await fixture.waitEvent('completion')
        // No-child assertion runs while the fixture is ALIVE: after a dead
        // pid the answer is trivially [] and the assert proves nothing.
        expect(childPidsOf(fixture.pid)).toEqual([])
        fixture.sendLine('explode')
        expect(await fixture.exited()).toBe(3)
        expect(fixture.readEvents().map((event) => event.kind)).toEqual([
          'session',
          'activity',
          'approval',
          'question',
          'completion',
          'crash',
        ])
      } finally {
        await fixture.stop()
      }
    })
  }

  test('kilroy sidecar: create+turn with scrubbed PATH, no children', async () => {
    const fixture = await launchProviderFixture({
      fixture: 'fake-claude-sdk-sidecar.mjs',
      program: SIDECAR_PROGRAM,
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-kilroy', FRESHELL_FAKE_PROVIDER: 'kilroy' },
      scrub: true,
    })
    try {
      await sendSidecar(fixture, { type: 'create', requestId: 'scrub-req', cwd: fixture.cwd })
      const created = await readSidecarLine(fixture, (o) => o.type === 'created', 'created')
      fixture.proc.stdin?.write(
        `${JSON.stringify({ type: 'send', sessionId: created.sessionId, text: 'please approve' })}\n`,
      )
      await fixture.waitEvent('completion')
      expect(childPidsOf(fixture.pid)).toEqual([])
    } finally {
      await fixture.stop()
    }
  })

  test('codex app-server: RPC contract with scrubbed PATH, no children', async () => {
    const port = await freePort()
    const listen = `ws://127.0.0.1:${port}`
    const fixture = await launchProviderFixture({
      fixture: 'fake-codex-app-server.mjs',
      args: ['--listen', listen],
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-codex-app-server' },
      scrub: true,
    })
    // Connect only AFTER the fixture's listen marker — building the client
    // first races the bind (ECONNREFUSED on an un-listened port).
    await fixture.waitOutput('listening on')
    const client = new CodexRpcClient(listen)
    try {
      await client.ready()
      await client.call('initialize', {})
      const started = await client.call('thread/start', {})
      await client.call('turn/start', { threadId: started.thread.id })
      await client.waitNotification('turn/completed')
      expect(childPidsOf(fixture.pid)).toEqual([])
      client.close()
    } finally {
      await fixture.stop()
    }
  })

  test('opencode server: REST+SSE contract with scrubbed PATH, no children', async () => {
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const fixture = await launchProviderFixture({
      fixture: 'fake-opencode-server.mjs',
      args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-opencode-server' },
      scrub: true,
    })
    // Connect only AFTER the fixture's listen marker — the SSE pump does not
    // retry, so a pre-listen connect never recovers (server.connected never
    // arrives).
    await fixture.waitOutput('listening on')
    const sse = new SseClient(`${base}/event`)
    try {
      await sse.waitEvent('server.connected')
      const created = await fetch(`${base}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then((r) => r.json())
      await fetch(`${base}/session/${created.id}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      await sse.waitEvent('session.idle')
      expect(childPidsOf(fixture.pid)).toEqual([])
      sse.close()
    } finally {
      await fixture.stop()
    }
  })

  test('the launch ledger can never record secrets outside the allowlist', async () => {
    const fixture = await launchProviderFixture({
      fixture: 'fake-claude.mjs',
      args: [],
      env: {
        ...PROBE_ENV,
        HARNESS03_PROBE: 'probe-claude',
        ANTHROPIC_API_KEY: 'definitely-a-secret',
        OPENAI_API_KEY: 'also-secret',
      },
    })
    try {
      await fixture.waitOutput('claude> ')
      const [row] = fixture.readLedger()
      expect(row.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(row.env.OPENAI_API_KEY).toBeUndefined()
      expect(row.env.HARNESS03_PROBE).toBe('probe-claude')
    } finally {
      await fixture.stop()
    }
  })
})
