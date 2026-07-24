import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import WebSocket from 'ws'
import { RustServer } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'

/**
 * RECONCILE-HANDSHAKE (PW-RUST, design §9.2) — synthetic-client proof of the
 * reconciliation-on-connect handshake against the REAL Rust server.
 *
 * The synthetic client is a raw Node `WebSocket` inside the spec (no SPA
 * involvement), driving the real server + a real fixture home directory —
 * exactly the §9.2 posture. Scenarios:
 *
 *   1. Server restart (Incident 1/2 shape, also the WSL-restart equivalence
 *      and the refreshed-browser analogue: the re-present is built from
 *      persisted-shape pane claims only): shell pane → `fresh`, resumed-CLI
 *      pane with an on-disk fixture session → `respawn` with the correct
 *      `sessionRef`; completing the respawn converges the next reconcile to
 *      `attach` — exactly one live PTY per createRequestId.
 *   2. Dead session: a session the index HAS observed disappears from disk →
 *      explicit `dead_session`, and the session directory is untouched.
 *   3. Two concurrent reconciling connections (change #1 — the council's
 *      two-tab double-respawn blocker): both fire `terminal.create` for the
 *      SAME createRequestId after a restart; ≤1 live PTY afterwards and the
 *      second create took the adopt branch (same terminalId).
 *
 * Frozen-client inertness at e2e level (§9.2 scenario 6) is the EXISTING
 * PW-RUST suite passing unchanged against this server build — not a spec in
 * this file.
 */

const FIXTURE_SESSION_A = '5f0c2a1e-9b7d-4c3a-8e21-0d9f6b4a7c11'
const FIXTURE_SESSION_B = '7a1b3c5d-2e4f-4a6b-9c8d-1e2f3a4b5c6d'

/** Minimal claude transcript that the session index accepts (carries `cwd`). */
function claudeSessionLine(): string {
  return (
    JSON.stringify({
      type: 'user',
      message: 'hello from the reconcile fixture',
      uuid: 'msg-1',
      cwd: '/tmp/reconcile-proj',
      timestamp: '2026-07-22T10:00:00.000Z',
    }) + '\n'
  )
}

async function seedClaudeSessions(homeDir: string, sessionIds: string[]): Promise<void> {
  const projDir = path.join(homeDir, '.claude', 'projects', 'reconcile-proj')
  await fs.mkdir(projDir, { recursive: true })
  for (const id of sessionIds) {
    await fs.writeFile(path.join(projDir, `${id}.jsonl`), claudeSessionLine(), 'utf8')
  }
}

type Frame = Record<string, unknown> & { type: string }

/** Raw synthetic client: connect + hello (negotiating paneReconcileV1). */
class SyntheticClient {
  private ws: WebSocket
  private frames: Frame[] = []
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      let frame: Frame
      try {
        frame = JSON.parse(String(data)) as Frame
      } catch {
        return
      }
      this.frames.push(frame)
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(frame)) {
          const [waiter] = this.waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    })
  }

  static async connect(info: TestServerInfo): Promise<SyntheticClient> {
    const ws = new WebSocket(info.wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const client = new SyntheticClient(ws)
    client.send({
      type: 'hello',
      protocolVersion: 7,
      token: info.token,
      capabilities: { paneReconcileV1: true },
    })
    const ready = await client.waitFor((f) => f.type === 'ready')
    expect((ready as { capabilities?: { paneReconcileV1?: boolean } }).capabilities?.paneReconcileV1).toBe(true)
    return client
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const seen = this.frames.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for frame (have: ${this.frames.map((f) => f.type).join(', ')})`)),
        timeoutMs,
      )
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
      })
    })
  }

  /**
   * One reconcile round-trip. The retry verdict is part of the protocol
   * (cold index → `retry(index_warming)`); `reconcileUntilStable` below is
   * the client-side re-request loop the design prescribes.
   */
  async reconcile(panes: Array<Record<string, unknown>>): Promise<Frame[]> {
    const reconcileId = `rec-${Math.random().toString(36).slice(2)}`
    this.send({ type: 'pane.reconcile.request', reconcileId, panes })
    const result = await this.waitFor(
      (f) => f.type === 'pane.reconcile.result' && (f as { reconcileId?: string }).reconcileId === reconcileId,
    )
    return (result as { verdicts: Frame[] }).verdicts
  }

  /** Re-request while any verdict is `retry` (bounded), per §5.3 row 5. */
  async reconcileUntilStable(panes: Array<Record<string, unknown>>): Promise<Frame[]> {
    let verdicts: Frame[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      verdicts = await this.reconcile(panes)
      if (!verdicts.some((v) => (v as { verdict?: string }).verdict === 'retry')) return verdicts
      await new Promise((r) => setTimeout(r, 250))
    }
    return verdicts
  }

  async createTerminal(requestId: string): Promise<Frame> {
    this.send({ type: 'terminal.create', requestId, mode: 'shell', shell: 'system' })
    return this.waitFor(
      (f) =>
        (f.type === 'terminal.created' && (f as { requestId?: string }).requestId === requestId) ||
        (f.type === 'error' && (f as { requestId?: string }).requestId === requestId),
    )
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

async function listTerminals(info: TestServerInfo): Promise<Array<{ terminalId: string; status: string }>> {
  const res = await fetch(`${info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': info.token },
  })
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { terminals?: Array<{ terminalId: string; status: string }> }
  return body.terminals ?? (body as unknown as Array<{ terminalId: string; status: string }>)
}

test.describe('reconcile handshake (rust server, synthetic client)', () => {
  test('restart: shell → fresh, resumed CLI → respawn with correct sessionRef, then attach', async () => {
    const server = new RustServer({
      setupHome: async (home) => seedClaudeSessions(home, [FIXTURE_SESSION_A]),
    })
    const info = await server.start()
    try {
      // Pre-restart: a real shell PTY owned by pane cr-shell.
      const before = await SyntheticClient.connect(info)
      const created = await before.createTerminal('cr-shell')
      expect(created.type).toBe('terminal.created')
      before.close()

      // The restart: registry emptied, disk intact — the SAME shape as a
      // WSL restart (§9.2 scenario 3) and, because the re-present below is
      // built from persisted-shape claims only, the refreshed-browser
      // analogue (§9.2 scenario 4).
      await server.restart()

      const after = await SyntheticClient.connect(info)
      const verdicts = await after.reconcileUntilStable([
        // Persisted shell pane: stale terminalId, nothing to resume.
        {
          paneKey: 'tab1:shell',
          kind: 'terminal',
          mode: 'shell',
          createRequestId: 'cr-shell',
          terminalId: String(created.terminalId),
        },
        // Persisted CLI pane claiming the on-disk fixture session.
        {
          paneKey: 'tab1:cli',
          kind: 'terminal',
          mode: 'claude',
          createRequestId: 'cr-cli',
          sessionRef: { provider: 'claude', sessionId: FIXTURE_SESSION_A },
        },
      ])

      expect(verdicts[0].verdict).toBe('fresh')
      expect(verdicts[1].verdict).toBe('respawn')
      expect(verdicts[1].sessionRef).toEqual({ provider: 'claude', sessionId: FIXTURE_SESSION_A })

      // Complete the respawn (the create is keyed by the pane's
      // createRequestId; shell mode keeps the spec environment-independent —
      // identity naming is pinned at crate level).
      const respawned = await after.createTerminal('cr-cli')
      expect(respawned.type).toBe('terminal.created')

      // Convergence: the next reconcile hits row 1 → attach.
      const second = await after.reconcileUntilStable([
        { paneKey: 'tab1:cli', kind: 'terminal', mode: 'claude', createRequestId: 'cr-cli' },
      ])
      expect(second[0].verdict).toBe('attach')
      expect(second[0].terminalId).toBe(respawned.terminalId)
      after.close()
    } finally {
      await server.stop()
    }
  })

  test('dead session: an observed session gone from disk → explicit dead_session, disk untouched', async () => {
    const server = new RustServer({
      setupHome: async (home) => seedClaudeSessions(home, [FIXTURE_SESSION_A, FIXTURE_SESSION_B]),
    })
    const info = await server.start()
    try {
      const client = await SyntheticClient.connect(info)
      const pane = {
        paneKey: 'tab1:dead',
        kind: 'terminal',
        mode: 'claude',
        createRequestId: 'cr-dead',
        sessionRef: { provider: 'claude', sessionId: FIXTURE_SESSION_B },
      }
      // First reconcile observes the session on disk.
      const first = await client.reconcileUntilStable([pane])
      expect(first[0].verdict).toBe('respawn')

      // The session disappears from disk (external deletion).
      const projDir = path.join(info.homeDir, '.claude', 'projects', 'reconcile-proj')
      await fs.rm(path.join(projDir, `${FIXTURE_SESSION_B}.jsonl`))

      // Re-present until the index refresh lands: explicit dead_session,
      // never a silent grey pane and never a fresh that hides data loss.
      let verdicts: Frame[] = []
      await expect
        .poll(
          async () => {
            verdicts = await client.reconcileUntilStable([pane])
            return verdicts[0].verdict
          },
          { timeout: 30_000 },
        )
        .toBe('dead_session')
      expect(verdicts[0].reason).toBe('session_not_on_disk')
      expect(verdicts[0].sessionRef).toEqual({ provider: 'claude', sessionId: FIXTURE_SESSION_B })

      // Disk untouched: the sibling session file still exists, nothing was
      // recreated or deleted by the server.
      const remaining = await fs.readdir(projDir)
      expect(remaining).toEqual([`${FIXTURE_SESSION_A}.jsonl`])
      client.close()
    } finally {
      await server.stop()
    }
  })

  test('two concurrent reconciling connections converge to exactly one live PTY per key', async () => {
    const server = new RustServer()
    const info = await server.start()
    try {
      // Pre-restart terminal for the key, so the post-restart shape is the
      // real incident shape (both tabs re-present a pane that HAD a live
      // terminal before the restart).
      const before = await SyntheticClient.connect(info)
      await before.createTerminal('cr-two')
      before.close()
      await server.restart()

      // Two browser tabs, both reconciling.
      const [tab1, tab2] = await Promise.all([
        SyntheticClient.connect(info),
        SyntheticClient.connect(info),
      ])
      const pane = { paneKey: 'tab:two', kind: 'terminal', mode: 'shell', createRequestId: 'cr-two' }
      const [v1, v2] = await Promise.all([
        tab1.reconcileUntilStable([pane]),
        tab2.reconcileUntilStable([pane]),
      ])
      // Deterministic pure read: both tabs get the SAME verdict.
      expect(v1[0].verdict).toBe(v2[0].verdict)
      expect(v1[0].verdict).toBe('fresh') // shell: nothing to resume

      // Both fire terminal.create for the same key — the single-flight
      // dedupe must yield ONE PTY, the second create adopting the first.
      const [c1, c2] = await Promise.all([
        tab1.createTerminal('cr-two'),
        tab2.createTerminal('cr-two'),
      ])
      expect(c1.type).toBe('terminal.created')
      expect(c2.type).toBe('terminal.created')
      expect(c1.terminalId).toBe(c2.terminalId)

      // ≤1 live PTY for the key, asserted via the REST directory (§9.2.7).
      const terminals = await listTerminals(info)
      const running = terminals.filter((t) => t.status === 'running')
      expect(running).toHaveLength(1)
      expect(running[0].terminalId).toBe(c1.terminalId)
      tab1.close()
      tab2.close()
    } finally {
      await server.stop()
    }
  })
})
