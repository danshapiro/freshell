import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * CONTINUITY TRIO deliverable 1 acceptance
 * (docs/plans/2026-07-22-continuity-safety-trio.md): the full
 * snapshot -> wipe -> one-command restore round-trip.
 *
 * Scenario:
 *   1. A browser client populates mixed tabs (shell terminal, browser pane,
 *      and a codex terminal carrying session identity in `sessionRef`).
 *   2. The client's tabs.sync push persists a snapshot generation server-side
 *      (Task 1), readable via GET /api/tabs-sync/snapshots[/{deviceId}] (Task 2).
 *   3. The client's state is WIPED (fresh browser context = empty tab set).
 *   4. `scripts/restore-tabs.sh` (Task 4) drives POST /api/tabs-sync/restore
 *      (Task 3): exactly-one-browser gate (proven with a bystander -> 409),
 *      then a real restore into the single wiped client.
 *   5. The restored tabs point at the SAME sessions: the codex pane carries
 *      the identical `sessionRef` on a NEW terminal, AND the recorded fake-CLI
 *      argv proves the server re-spawned `codex resume <sessionId>` (a Redux
 *      sessionRef echo alone would not prove the server passed resume args).
 *   6. A second restore of the same generation is a no-op (marker idempotency).
 *
 * Rust-only: legacy has no persisted snapshot generations or restore endpoint.
 * This spec is registered ONLY under `rust-chromium` and testIgnore'd on every
 * match-all project (see playwright.config.ts's RUST_ONLY_SPECS).
 *
 * EPHEMERAL-ONLY SAFETY: the server is constructed DIRECTLY via `new
 * RustServer(...)` -- throwaway binary, ephemeral loopback port, mkdtemp HOME.
 * NEVER `createE2eServerHandle(process.env, ...)`: with FRESHELL_E2E_TARGET_URL
 * set it silently retargets to an already-running (possibly LIVE) server.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')
const RESTORE_SCRIPT = path.resolve(__dirname, '../../../scripts/restore-tabs.sh')

const run = promisify(execFile)
const CODEX_SESSION_ID = '11111111-2222-4333-8444-555555555555'
const SESSION_TITLE = 'snapshot-restore seeded codex session'

async function installFakeCodexCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  await fs.copyFile(FAKE_CODEX_CLI_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
}

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** True when the argv tokens contain the adjacent pair `resume <sessionId>`. */
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

// Boot a page against an already-started server (mirror of the inline sequence
// in codex-terminal-bounce-rust.spec.ts; there is NO bootAndConnect helper).
async function connect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

// Find the codex pane's Redux content by scanning every tab's pane layout
// (uniform same-session evidence for codex, which GET /api/terminals
// DELIBERATELY omits `sessionRef` for -- terminals.rs).
async function codexPane(harness: TestHarness): Promise<any | null> {
  const state = await harness.getState()
  for (const tab of state?.tabs?.tabs ?? []) {
    const layout = state?.panes?.layouts?.[tab.id]
    if (layout?.type === 'leaf' && layout.content?.kind === 'terminal' && layout.content?.mode === 'codex') {
      return layout.content
    }
  }
  return null
}

test.describe('tabs-sync snapshot -> wipe -> one-command restore (rust only)', () => {
  test('restored tabs point at the SAME sessions', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (spec is also in every match-all project's testIgnore)
    test.setTimeout(240_000)

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-snapshot-restore-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeCodexPath = await installFakeCodexCli(path.join(sharedRoot, 'bin'))

      // EPHEMERAL-ONLY: construct RustServer directly (throwaway port +
      // mkdtemp HOME). NEVER createE2eServerHandle -- see file doc comment.
      const server = new RustServer({
        env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
            },
          }, null, 2))

          // Same real-reader seed shape as `codex-terminal-bounce-rust.spec.ts` /
          // `sidebar-click-resume.spec.ts`: a `session_meta` record carrying
          // `payload.id`/`cwd` plus message records for a title.
          const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
          await fs.mkdir(codexSessionsDir, { recursive: true })
          const lines = [
            JSON.stringify({
              timestamp: '2026-07-21T08:00:00.000Z',
              type: 'session_meta',
              payload: { id: CODEX_SESSION_ID, cwd: projectDir },
            }),
            JSON.stringify({
              timestamp: '2026-07-21T08:00:01.000Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `${SESSION_TITLE} request 1` }],
              },
            }),
            JSON.stringify({
              timestamp: '2026-07-21T08:00:02.000Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: `${SESSION_TITLE} reply 1` }],
              },
            }),
          ]
          await fs.writeFile(
            path.join(codexSessionsDir, `${CODEX_SESSION_ID}.jsonl`),
            `${lines.join('\n')}\n`,
          )
        },
      })
      const info = await server.start()

      try {
        // -- populate: one page = one deviceId/clientInstanceId --
        const ctx1 = await browser.newContext()
        const page1 = await ctx1.newPage()
        const harness1 = await connect(page1, info)
        const baseline = await harness1.getTabCount()

        const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
        const mk = async (body: unknown) => {
          const r = await fetch(`${info.baseUrl}/api/tabs`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify(body),
          })
          expect(r.ok).toBe(true)
          return (await r.json()).data // unwrap the {status,data,message} envelope
        }
        await mk({ mode: 'shell', name: 'plain shell' })
        await mk({ browser: 'https://example.com', name: 'docs' })
        const codex = await mk({
          mode: 'codex',
          name: 'codex work',
          sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
        })
        expect(codex.terminalId).toBeTruthy()
        const codexTerminalIdBefore = codex.terminalId

        // -- wait for the client's tabs.sync push to persist a generation with
        //    all three tabs (incl. the codex sessionRef) --
        let deviceId = ''
        await expect(async () => {
          const data = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
          const dev = (data.devices ?? []).find((d: any) => d.recordCount >= baseline + 3)
          expect(dev).toBeTruthy()
          deviceId = dev.deviceId
          const snap = await (await fetch(
            `${info.baseUrl}/api/tabs-sync/snapshots/${encodeURIComponent(deviceId)}`,
            { headers: auth },
          )).json()
          const codexPaneSnap = (snap.records ?? []).flatMap((rec: any) => rec.panes ?? [])
            .find((p: any) => p.payload?.sessionRef?.provider === 'codex')
          expect(codexPaneSnap?.payload?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
        }).toPass({ timeout: 30_000 })

        // -- BYSTANDER: a SECOND connected browser context stays open. Restore
        //    drives the create pipeline, which broadcasts tab.create to ALL
        //    clients; with the wiped client also connected there would be 2
        //    clients, so restore's connected-client gate must 409. We (a) prove
        //    the gate with 2 clients, then (b) close the bystander and restore
        //    into the single wiped client. --
        const bystanderCtx = await browser.newContext()
        await connect(await bystanderCtx.newPage(), info)

        // -- wipe: close the populated context (that client's state is gone) --
        await ctx1.close()

        // -- fresh browser context = the wiped client (empty tab set) --
        const ctx2 = await browser.newContext()
        const page2 = await ctx2.newPage()
        const harness2 = await connect(page2, info)
        const freshCount = await harness2.getTabCount()

        // (a) GATE: with the wiped client + the bystander connected (>1),
        // restore is refused (409 -> curl -f fails -> script exits 1).
        const gated = await run(
          'bash',
          [RESTORE_SCRIPT, '--url', info.baseUrl, '--token', info.token, '--device', deviceId],
        ).catch((e: any) => e)
        expect(String(gated.stderr ?? gated.stdout ?? '')).toMatch(/refused|409/i)

        // The restore leg's RESUME PROOF is a DELTA beyond this point: the
        // initial REST create above already spawned `codex resume <id>` once.
        const argvCountBeforeRestore = (await readArgvLog(argLogPath)).length

        // Close the bystander so exactly ONE client remains, then restore for
        // real. Retry until the server's connected-client count settles to 1
        // (a 409 creates nothing + writes no marker, so retrying is safe).
        await bystanderCtx.close()
        await expect(async () => {
          const { stdout } = await run(
            'bash',
            [RESTORE_SCRIPT, '--url', info.baseUrl, '--token', info.token, '--device', deviceId],
          )
          expect(stdout).toContain('failed=0')
        }).toPass({ timeout: 20_000 })

        // -- the wiped client received the restored tabs live --
        await expect(async () => {
          expect(await harness2.getTabCount()).toBe(freshCount + 3)
        }).toPass({ timeout: 20_000 })

        // -- SAME session: the restored codex pane carries the identical
        //    sessionRef (Redux, from the ui.command tab.create payload) on a
        //    NEW terminal --
        await expect(async () => {
          const content = await codexPane(harness2)
          expect(content?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
          expect(content?.terminalId).toBeTruthy()
          expect(content?.terminalId).not.toBe(codexTerminalIdBefore)
        }).toPass({ timeout: 20_000 })

        // -- RESUME PROOF (not identity-echo only): the restore RE-spawned
        //    codex with `resume <sessionId>` argv (delta beyond the
        //    pre-restore log, like codex-terminal-bounce-rust.spec.ts's
        //    bounce leg). A Redux sessionRef could survive even if the server
        //    ignored it, so assert the RECORDED argv. --
        await expect(async () => {
          const entries = await readArgvLog(argLogPath)
          expect(
            entries.slice(argvCountBeforeRestore).some((e) => hasResumePair(e.argv, CODEX_SESSION_ID)),
            'restore must exec `codex resume <sessionId>`',
          ).toBe(true)
        }).toPass({ timeout: 20_000 })

        // -- a live codex terminal exists server-side (RAW JSON array; codex
        //    items deliberately have no sessionRef here) --
        const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
        expect(Array.isArray(terms)).toBe(true)
        expect(terms.some((t: any) => t.mode === 'codex')).toBe(true)

        // -- IDEMPOTENCY: a second restore of the same generation is a no-op
        //    (marker skips every pane; nothing new is created) --
        const { stdout: rerun } = await run(
          'bash',
          [RESTORE_SCRIPT, '--url', info.baseUrl, '--token', info.token, '--device', deviceId],
        )
        expect(rerun).toMatch(/restored=0/)
        expect(rerun).toContain('failed=0')
        await expect(async () => {
          expect(await harness2.getTabCount()).toBe(freshCount + 3) // unchanged
        }).toPass({ timeout: 10_000 })

        await ctx2.close()
      } finally {
        await server.stop()
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
