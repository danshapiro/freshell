/**
 * LANE E (create protection): blast-radius isolation + e2e restore-bypass
 * proof. Two concurrent RustServer instances (first such spec — each has its
 * own ephemeral port, HOME, token, process group). Storm server A with
 * restore:true creates over raw WS from TWO connections (15 each — creates
 * are serialized per connection server-side, so multiple connections are
 * what puts parallel spawn pressure on the gate; the concurrency BOUND
 * itself is pinned by Task 2/4 tests). 15 restore creates per connection
 * inside one 10s window exceeds the 10/10s limit — every one succeeding IS
 * the e2e restore-bypass proof. Meanwhile server B serves a browser session;
 * B's health latency and terminal interactivity must be unaffected.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'

const STORM_CLIENTS = 2
const CREATES_PER_CLIENT = 15 // > the 10/10s limit: succeeding proves restore bypass

type Frame = Record<string, unknown> & { type: string }

/** Raw synthetic client (copied per per-spec-ownership from
 *  reconcile-handshake-rust.spec.ts; reconcile-specific pieces dropped —
 *  this spec needs only connect/send/waitFor/close). */
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
      protocolVersion: 8,
      token: info.token,
    })
    await client.waitFor((f) => f.type === 'ready')
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

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

test.describe('Create protection: cross-server isolation (Rust only)', () => {
  test.setTimeout(240_000)

  test('storming server A does not degrade server B', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const serverA = new RustServer({})
    const serverB = new RustServer({})
    const infoA: TestServerInfo = await serverA.start()
    const infoB: TestServerInfo = await serverB.start()
    expect(infoA.port).not.toBe(infoB.port)
    try {
      // Browser session on B with one live terminal.
      await page.goto(`${infoB.baseUrl}/?token=${infoB.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
        const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        if (await button.isVisible().catch(() => false)) { await button.click(); break }
      }
      const terminal = new TerminalHelper(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await terminal.waitForPrompt({ timeout: 30_000 })

      // Storm A over raw WS from TWO connections (creates are serialized
      // per connection server-side, so cross-connection is what exercises
      // the gate in parallel): restore:true shell creates. 15 per
      // connection inside one 10s window exceeds the 10/10s limit — every
      // one succeeding proves the restore bypass e2e (30 real PTY spawns
      // drain through the gate, default N=4).
      const clients = await Promise.all(
        Array.from({ length: STORM_CLIENTS }, () => SyntheticClient.connect(infoA)),
      )
      const healthSamplesMs: number[] = []
      const storm = (async () => {
        for (const [c, client] of clients.entries()) {
          for (let i = 0; i < CREATES_PER_CLIENT; i++) {
            client.send({
              type: 'terminal.create', requestId: `storm-${c}-${i}`,
              mode: 'shell', shell: 'system', restore: true,
            })
          }
        }
        for (const [c, client] of clients.entries()) {
          for (let i = 0; i < CREATES_PER_CLIENT; i++) {
            const reply = await client.waitFor(
              (f) => (f.type === 'terminal.created' || f.type === 'error')
                && f.requestId === `storm-${c}-${i}`,
              60_000,
            )
            // Restore bypass, proven e2e: no RATE_LIMITED, every spawn lands.
            expect(reply.type, `restore create storm-${c}-${i} bypasses the limiter`)
              .toBe('terminal.created')
          }
        }
      })()
      // Meanwhile sample B's health latency.
      const sampler = (async () => {
        for (let i = 0; i < 10; i++) {
          const t0 = Date.now()
          const res = await fetch(`${infoB.baseUrl}/api/health`, {
            headers: { 'x-auth-token': infoB.token },
          })
          healthSamplesMs.push(Date.now() - t0)
          expect(res.ok).toBe(true)
          await new Promise((r) => setTimeout(r, 300))
        }
      })()
      await Promise.all([storm, sampler])

      // B stayed healthy and interactive during the storm.
      expect(Math.max(...healthSamplesMs)).toBeLessThan(2_000)
      const marker = `ISOLATION-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker}`)
      await terminal.waitForOutput(marker, { timeout: 10_000 })

      for (const client of clients) client.close()
    } finally {
      await serverA.stop().catch(() => {})
      await serverB.stop().catch(() => {})
    }
  })
})
