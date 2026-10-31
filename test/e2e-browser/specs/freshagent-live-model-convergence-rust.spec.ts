// FRESHAGENT LIVE MODEL CONVERGENCE — end-to-end proof that a model change
// committed on a LIVE session converges immediately through the server:
//
//   1. opencode: `freshAgent.configure` records the pair on the live session
//      and broadcasts `freshAgent.session.metadata` with the effective model +
//      effort; the NEXT turn's prompt_async body carries the configured pair
//      (`{providerID, modelID}` object + the `variant` string field). An
//      idempotent configure stays silent on the bus.
//   2. claude: `freshAgent.configure` applies for real through the sidecar's
//      configure lane (the fake's sdk.configured receipt) and broadcasts the
//      metadata frame; the simulator ledger records the SDK settings call.
//
// Codex uses the same real Rust configure and metadata path, with only its
// native executable replaced by the current app-server fixture.
//
// Rust-only: raw-WS + owned RustServer per test (the rust-chromium project).
// The client-side UI halves (dialog commit → configure frame; metadata fold →
// the lower-left chip flips over a stale snapshot) are pinned in the legacy
// project's freshopencode-model-picker.spec.ts.
//
// Donors: boot/env plumbing + WsCapture + seedWallConfig from
// freshagent-settings-resume-rust.spec.ts (copied per this suite's
// per-spec-ownership convention).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-version.js'
import { claudeSimulatorServerEnv, readClaudeSimLedger } from '../helpers/claude-sim-lane.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const OPENCODE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

/** Raw node-side WS client with a real hello handshake and a frame buffer
 * (donor: freshagent-settings-resume-rust.spec.ts's WsCapture). */
class WsCapture {
  private ws: WebSocket
  readonly frames: any[] = []
  private opened: Promise<void>

  constructor(baseUrl: string, token: string) {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`
    this.ws = new WebSocket(wsUrl)
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token }))
        resolve()
      })
      this.ws.on('error', reject)
    })
    this.ws.on('message', (data) => {
      try {
        this.frames.push(JSON.parse(String(data)))
      } catch {
        // non-JSON frames are not part of this protocol; ignore
      }
    })
  }

  async ready(): Promise<void> {
    await this.opened
    await this.waitFor((f) => f.type === 'ready', 10_000, 'ready')
  }

  async waitFor(pred: (frame: any) => boolean, timeoutMs: number, label: string): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`WsCapture: timed out waiting for ${label}`)
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame))
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

/** `PATCH /api/settings` — flip the shared `settings.freshAgent.enabled` gate
 * the fresh-agent WS dispatch requires. */
async function enableFreshAgent(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ freshAgent: { enabled: true } }),
  })
  if (!res.ok) {
    throw new Error(`PATCH /api/settings failed: ${res.status} ${await res.text()}`)
  }
}

/** Parse a JSONL file, tolerating absence (returns []). */
function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot). */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: input.providers },
            ...(input.freshAgent ? { freshAgent: { enabled: true } } : {}),
          },
        },
        null,
        2,
      ),
    )
  }
}

test.describe('fresh-agent live model convergence (rust)', () => {
  test('codex: two connections converge settings and the next native turn carries the exact pair', async () => {
    test.setTimeout(120_000)
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-conv-codex-'))
    const wrapper = path.join(root, 'codex.mjs')
    const log = path.join(root, 'requests.jsonl')
    const fixture = path.resolve(__dirname, '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')
    await fsp.writeFile(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(fixture)}\n`)
    await fsp.chmod(wrapper, 0o755)
    const server = new RustServer({ env: { CODEX_CMD: wrapper, FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ recordTurns: true, echoRequestedModel: true, appendRequestLogPath: log }) },
    setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }) })
    const wires: WsCapture[] = []
    try {
      const info = await server.start()
      const first = new WsCapture(info.baseUrl, info.token)
      const second = new WsCapture(info.baseUrl, info.token)
      wires.push(first, second)
      await Promise.all(wires.map(wire => wire.ready()))
      first.send({ type: 'freshAgent.create', provider: 'codex', sessionType: 'freshcodex', requestId: 'codex-converge-create', cwd: root,
        model: 'initial-native-model', effort: 'low' })
      const created = await first.waitFor(frame => frame.requestId === 'codex-converge-create'
        && ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type), 30_000, 'Codex creation')
      expect(created.type, JSON.stringify(created)).toBe('freshAgent.created')
      const sessionId = created.sessionId
      first.send({ type: 'freshAgent.configure', provider: 'codex', sessionType: 'freshcodex', sessionId, requestId: 'codex-converge-configure',
        settings: { model: 'catalog-native-model', effort: 'ultra', collaborationMode: 'plan' } })
      for (const wire of wires) {
        const metadata = await wire.waitFor(frame => frame.type === 'freshAgent.event' && frame.sessionId === sessionId
          && frame.event?.type === 'freshAgent.session.metadata' && frame.event.model === 'catalog-native-model', 30_000, 'shared Codex metadata')
        expect(metadata.event).toMatchObject({ model: 'catalog-native-model', effort: 'ultra', collaborationMode: 'plan' })
      }
      second.send({ type: 'freshAgent.send', provider: 'codex', sessionType: 'freshcodex', sessionId, requestId: 'codex-converge-send', text: 'Use the configured native model' })
      await expect.poll(() => readJsonl(log).filter(row => row.method === 'turn/start').length).toBe(1)
      expect(readJsonl(log).find(row => row.method === 'turn/start').params).toMatchObject({ threadId: sessionId,
        model: 'catalog-native-model', effort: 'ultra', collaborationMode: { mode: 'plan', settings: { model: 'catalog-native-model', reasoning_effort: 'ultra' } } })
      await second.waitFor(frame => frame.type === 'freshAgent.event' && frame.sessionId === sessionId
        && frame.event?.type === 'freshAgent.turn.complete', 30_000, 'Codex native completion')
      const response = await fetch(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${sessionId}`, { headers: { 'x-auth-token': info.token } })
      expect(response.ok).toBe(true)
      expect((await response.json()).settings).toMatchObject({ model: 'catalog-native-model', effort: 'ultra', collaborationMode: 'plan' })
      expect(readJsonl(log).filter(row => row.method === 'thread/start')).toHaveLength(1)
    } finally {
      wires.forEach(wire => wire.close())
      await server.stop()
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  test('opencode: configure broadcasts session metadata and the next turn carries the pair', async () => {
    test.setTimeout(180_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-conv-opencode-'))
    const binDir = path.join(sharedRoot, 'bin')
    const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    // Install the fake as an executable named `opencode` and point
    // OPENCODE_CMD at it (serve.rs ServeConfig) — donor:
    // freshagent-settings-resume-rust.spec.ts.
    await fsp.mkdir(binDir, { recursive: true })
    const fakeOpencode = path.join(binDir, 'opencode')
    await fsp.copyFile(OPENCODE_FIXTURE, fakeOpencode)
    await fsp.chmod(fakeOpencode, 0o755)
    const server = new RustServer({
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        OPENCODE_CMD: fakeOpencode,
        FAKE_OPENCODE_AUDIT_LOG: auditLogPath,
      },
      setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
    })
    let ws: WsCapture | null = null
    try {
      const info = await server.start()
      await enableFreshAgent(info.baseUrl, info.token)
      ws = new WsCapture(info.baseUrl, info.token)
      await ws.ready()

      // Create + materialize with the INITIAL pair.
      ws.send({
        type: 'freshAgent.create',
        requestId: 'req-conv-open-1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        model: 'fakeprov/model-a',
        effort: 'high',
        cwd: projectDir,
      })
      const created = await ws.waitFor(
        (f) => f.type === 'freshAgent.created' && f.requestId === 'req-conv-open-1',
        30_000,
        'freshAgent.created (opencode)',
      )
      const placeholderId = created.sessionId as string
      ws.send({
        type: 'freshAgent.send',
        requestId: 'send-conv-1',
        sessionId: placeholderId,
        sessionType: 'freshopencode',
        provider: 'opencode',
        text: 'convergence first turn',
      })
      const materialized = await ws.waitFor(
        (f) => f.type === 'freshAgent.session.materialized' && f.previousSessionId === placeholderId,
        30_000,
        'freshAgent.session.materialized',
      )
      const sesId = materialized.sessionId as string

      // ── the live-settings convergence lane ──────────────────────────────
      ws.send({
        type: 'freshAgent.configure',
        requestId: 'cfg-conv-1',
        sessionId: sesId,
        sessionType: 'freshopencode',
        provider: 'opencode',
        settings: { model: 'fakeprov/model-b', effort: 'low' },
      })
      const metadata = await ws.waitFor(
        (f) =>
          f.type === 'freshAgent.event'
          && f.sessionId === sesId
          && f.event?.type === 'freshAgent.session.metadata',
        30_000,
        'freshAgent.session.metadata',
      )
      expect(metadata.sessionType).toBe('freshopencode')
      expect(metadata.provider).toBe('opencode')
      expect(metadata.event.sessionId).toBe(sesId)
      expect(metadata.event.model).toBe('fakeprov/model-b')
      expect(metadata.event.effort).toBe('low')

      // The NEXT turn's prompt body carries the configured pair.
      ws.send({
        type: 'freshAgent.send',
        requestId: 'send-conv-2',
        sessionId: sesId,
        sessionType: 'freshopencode',
        provider: 'opencode',
        text: 'convergence second turn',
      })
      await expect
        .poll(
          () => readJsonl(auditLogPath).filter((e) => e.event === 'prompt_async').length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(1)
      const prompts = readJsonl(auditLogPath).filter((e) => e.event === 'prompt_async')
      const last = prompts[prompts.length - 1]
      expect(last.sessionId).toBe(sesId)
      expect(last.body?.model, 'the configured model rides the next turn').toEqual({ providerID: 'fakeprov', modelID: 'model-b' })
      expect(last.body?.variant, 'the configured effort rides the next turn (wire field: variant)').toBe('low')

      // An idempotent configure converges nothing: no second metadata frame.
      const metadataFramesBefore = ws.frames.filter(
        (f) => f.type === 'freshAgent.event' && f.event?.type === 'freshAgent.session.metadata',
      ).length
      ws.send({
        type: 'freshAgent.configure',
        requestId: 'cfg-conv-2',
        sessionId: sesId,
        sessionType: 'freshopencode',
        provider: 'opencode',
        settings: { model: 'fakeprov/model-b', effort: 'low' },
      })
      await new Promise((r) => setTimeout(r, 2_000))
      const metadataFramesAfter = ws.frames.filter(
        (f) => f.type === 'freshAgent.event' && f.event?.type === 'freshAgent.session.metadata',
      ).length
      expect(metadataFramesAfter).toBe(metadataFramesBefore)
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('claude: configure applies through the sidecar lane and broadcasts session metadata', async () => {
    test.setTimeout(180_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-conv-claude-'))
    const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    const server = new RustServer({
      env: claudeSimulatorServerEnv({ ledgerPath: simLedger }),
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    let ws: WsCapture | null = null
    try {
      const info = await server.start()
      await enableFreshAgent(info.baseUrl, info.token)
      ws = new WsCapture(info.baseUrl, info.token)
      await ws.ready()

      ws.send({
        type: 'freshAgent.create',
        requestId: 'req-conv-claude-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        model: 'opus-x',
        cwd: projectDir,
      })
      const created = await ws.waitFor(
        (f) => f.type === 'freshAgent.created' && f.requestId === 'req-conv-claude-1',
        30_000,
        'freshAgent.created (claude)',
      )
      const sessionId = created.sessionId as string

      // The live-settings convergence lane: the production sidecar applies
      // the configure through the simulator's SDK controls…
      ws.send({
        type: 'freshAgent.configure',
        requestId: 'cfg-conv-claude-1',
        sessionId,
        sessionType: 'freshclaude',
        provider: 'claude',
        settings: { model: 'sonnet', effort: 'low' },
      })
      const metadata = await ws.waitFor(
        (f) =>
          f.type === 'freshAgent.event'
          && f.sessionId === sessionId
          && f.event?.type === 'freshAgent.session.metadata',
        30_000,
        'freshAgent.session.metadata',
      )
      expect(metadata.sessionType).toBe('freshclaude')
      expect(metadata.event.model).toBe('sonnet')
      expect(metadata.event.effort).toBe('low')

      // …and the simulator ledger proves the SDK controls received the update.
      await expect
        .poll(
          () => readClaudeSimLedger(simLedger).filter((row) => row.kind === 'control').length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0)
      const controls = readClaudeSimLedger(simLedger).filter((row) => row.kind === 'control')
      expect(controls).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'setModel', args: ['sonnet'] }),
        expect.objectContaining({ name: 'applyFlagSettings' }),
      ]))
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
