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
//      metadata frame; the sidecar request log records the configure.
//
// The codex lane's wire contract is pinned in-crate
// (crates/freshell-freshagent/src/codex.rs configure tests against the real
// fake app-server) — the e2e app-server fixture path used by sibling specs
// is stale, so no codex leg here.
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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLAUDE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')
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
  test('opencode: configure broadcasts session metadata and the next turn carries the pair', async ({ e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
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

  test('claude: configure applies through the sidecar lane and broadcasts session metadata', async ({ e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-conv-claude-'))
    const sidecarLogPath = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    const server = new RustServer({
      env: {
        FRESHELL_CLAUDE_SIDECAR: CLAUDE_FIXTURE,
        FAKE_CLAUDE_SIDECAR_LOG: sidecarLogPath,
      },
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

      // The live-settings convergence lane: the sidecar applies the configure
      // for real (setModel + applyFlagSettings through the fake's receipt)…
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

      // …and the sidecar request log proves the configure reached the runtime.
      await expect
        .poll(
          () => readJsonl(sidecarLogPath).filter((e) => e.msg?.type === 'configure').length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0)
      const configureRequest = readJsonl(sidecarLogPath).find((e) => e.msg?.type === 'configure')
      expect(configureRequest.msg.sessionId).toBe(sessionId)
      expect(configureRequest.msg.settings.model).toBe('sonnet')
      expect(configureRequest.msg.settings.effort).toBe('low')
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
