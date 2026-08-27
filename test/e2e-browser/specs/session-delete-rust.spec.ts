/**
 * SESSION-02/03 rust-server contract wall, at the REAL binary boundary.
 *
 *  leg 1: DELETE /api/sessions/:id is a soft delete — the session drops out
 *         of the session-directory read model, the override tombstone lands
 *         in ~/.freshell/config.json, and the provider .jsonl is untouched.
 *  leg 2: an unmatched /api/* path answers 404 JSON (never 200 SPA HTML),
 *         and an unauthenticated DELETE answers 401 — the "silent success"
 *         failure class cannot re-emerge at the server boundary.
 *
 * Owns a RustServer directly (ephemeral loopback port — NEVER 3001/3002),
 */
import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RustServer, ensureRustServerBuilt, type E2eServerInfo } from '../helpers/rust-server.js'

const SESSION_ID = randomUUID()
const SESSION_KEY = `claude:${SESSION_ID}`
const PROJECT_DIR = '/tmp/session-delete-e2e-proj'

// Flat Claude transcript shape — the exact shape sessions_tests.rs's overlay
// round-trip proves end-to-end through ClaudeSource + the directory route.
// NOTE: the `system/init + uuid/parentUuid` nested shape used by some older
// specs is NOT indexed by the current Rust ClaudeSource (verified empirically
// while authoring this spec: a nested seed never appeared in
// /api/session-directory on either the pre- or post-fix binary; the flat
// shape appeared on the first poll of both).
function buildSessionJsonl(sessionId: string, cwd: string): string {
  return [
    JSON.stringify({ cwd, sessionId, type: 'user', message: { role: 'user', content: 'session-delete e2e seed' }, timestamp: '2025-01-30T10:00:00.000Z' }),
    JSON.stringify({ cwd, sessionId, type: 'assistant', message: { role: 'assistant', content: 'ack' }, timestamp: '2025-01-30T10:00:01.000Z' }),
    JSON.stringify({ cwd, sessionId, type: 'user', message: { role: 'user', content: 'second prompt' }, timestamp: '2025-01-30T10:00:02.000Z' }),
  ].join('\n') + '\n'
}

function authed(info: E2eServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token }
}

async function directorySessionIds(info: E2eServerInfo): Promise<string[]> {
  const resp = await fetch(`${info.baseUrl}/api/session-directory?priority=visible`, {
    headers: authed(info),
  })
  if (!resp.ok) throw new Error(`session-directory answered ${resp.status}`)
  const body = (await resp.json()) as { items?: Array<{ sessionId?: string }> }
  return (body.items ?? []).map((i) => i.sessionId ?? '')
}

// NOT serial: the two legs are independent (leg 2 never mutates state), and
// serial's skip-on-failure would hide leg 2's verdict when a red run (base
// binary) fails leg 1 — the point of the red run is the full 405 picture.
test.describe('session delete (rust server)', () => {
  test.setTimeout(240_000)
  let server: RustServer
  let info: E2eServerInfo

  test.beforeAll(async () => {
    // Same pattern as sidebar-registry-sync-rust.spec.ts:171-176: the first
    // release build can take minutes, and the default 60s hook timeout would
    // kill server.start() mid-build.
    test.setTimeout(600_000)
    // RustServer.boot resolves FRESHELL_E2E_RUST_SERVER_BIN fail-closed
    // (rust-server.ts:455) — when a caller pins a binary (e.g. a base-binary
    // red run), don't ALSO spend a head release build in this hook.
    if (!process.env.FRESHELL_E2E_RUST_SERVER_BIN) ensureRustServerBuilt()
    server = new RustServer({
      setupHome: async (homeDir: string) => {
        await fs.mkdir(PROJECT_DIR, { recursive: true })
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude'] } },
        }, null, 2))
        const slug = PROJECT_DIR.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${SESSION_ID}.jsonl`),
          buildSessionJsonl(SESSION_ID, PROJECT_DIR),
        )
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop()
    await fs.rm(PROJECT_DIR, { recursive: true, force: true })
  })

  test('soft delete hides the session, keeps the transcript, and persists the override', async () => {
    // The isolated provider home is indexed on the server's sweep cadence —
    // poll the directory until discovery, not a fixed sleep.
    await expect.poll(() => directorySessionIds(info), { timeout: 60_000 }).toContain(SESSION_ID)

    const seededJsonl = path.join(
      info.homeDir,
      '.claude', 'projects', PROJECT_DIR.replace(/\//g, '-'),
      `${SESSION_ID}.jsonl`,
    )

    const del = await fetch(
      `${info.baseUrl}/api/sessions/${encodeURIComponent(SESSION_KEY)}`,
      { method: 'DELETE', headers: authed(info) },
    )
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })

    await expect.poll(() => directorySessionIds(info), { timeout: 60_000 }).not.toContain(SESSION_ID)

    // Soft delete: the provider transcript is untouched, and the override is
    // exactly the single-key {deleted:true} tombstone.
    await expect(fs.access(seededJsonl)).resolves.toBeUndefined()
    const cfg = JSON.parse(
      await fs.readFile(path.join(info.homeDir, '.freshell', 'config.json'), 'utf8'),
    )
    expect(cfg.sessionOverrides?.[SESSION_KEY]?.deleted).toBe(true)
  })

  test('unmatched /api/* is 404 JSON (never SPA HTML 200), and unauthenticated DELETE is 401', async () => {
    const miss = await fetch(`${info.baseUrl}/api/definitely-not-a-route`, {
      headers: authed(info),
    })
    expect(miss.status).toBe(404)
    expect(miss.headers.get('content-type') ?? '').toContain('application/json')

    const unauth = await fetch(
      `${info.baseUrl}/api/sessions/${encodeURIComponent(SESSION_KEY)}`,
      { method: 'DELETE' },
    )
    expect(unauth.status).toBe(401)
  })
})
