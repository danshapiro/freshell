import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * CONTINUITY SMOKE (pre-deploy gate) -- CONTINUITY TRIO deliverable 2
 * (docs/plans/2026-07-22-continuity-safety-trio.md).
 *
 * ONE scenario against the REAL `freshell-server` binary and the REAL
 * installed `codex`/`amplifier`/`claude` CLIs from PATH (NO fake CLIs for the
 * resume legs). Seeded real session files (each with a unique MARKER
 * sentence) in the throwaway HOME; one tab per kind opened via real user
 * paths (sidebar click for codex; REST create for amplifier + claude);
 * disruption 1 = server restart WITHOUT a page reload -> wait for WS
 * reconnect + respawn -> outcome assertions; disruption 2 = a page reload ->
 * same assertions. Outcome assertions per phase: same tab count, each pane's
 * claimed session id unchanged (Redux `content.sessionRef.sessionId`), and
 * the seeded MARKER text visible in each resumed pane's terminal (asserted
 * through GET /api/terminals/{id}/search -- the server-side scrollback
 * mirror, the strongest offline proof a real CLI rendered text).
 *
 * The codex leg's discriminator is BEHAVIORAL (MARKER render + Redux
 * same-session), NEVER the `resume_applied` log field -- so Task 8's
 * historical-binary proof run (FRESHELL_E2E_RUST_SERVER_BIN pointed at a
 * pre-fix binary) isolates the `136b9e94` resume regression from that
 * commit's concurrent `terminal.created` logging change.
 *
 * Outside the default matrix by design: registered ONLY under the
 * `continuity-smoke` project (npm run smoke:continuity) and listed in
 * playwright.config.ts's RUST_ONLY_SPECS testIgnore for every match-all
 * project.
 *
 * ## Probe findings (Task 6, sdd/task-6-report.md)
 * - codex resume offline render: RENDERS (grep count 2; needs event_msg
 *   records + full session_meta, trust config.toml entry, one Enter at the
 *   resume-cwd picker); auth file needed: YES (~/.codex/auth.json, read-only
 *   copy into the throwaway HOME -- nothing is ever written back)
 * - amplifier resume offline render: RENDERS (grep count 2; real layout
 *   projects/<cwd `/`->`-`>/sessions/<uuid>/{metadata.json,transcript.jsonl});
 *   downgrade applied: none; auth file needed: NO
 * - claude --resume offline render: RENDERS (grep count 2; project dir munges
 *   BOTH `/` and `.` to `-`; user content as string; .claude.json
 *   onboarding+trust bypass; ANTHROPIC_API_KEY must be absent from the pane
 *   env); downgrade applied: none; auth file needed: NO
 * - No leg needed the log+id downgrade -- all three assert the MARKER render.
 *
 * EPHEMERAL-ONLY SAFETY: the server is constructed DIRECTLY via `new
 * RustServer(...)` -- throwaway binary, ephemeral loopback port, mkdtemp
 * HOME. NEVER `createE2eServerHandle(process.env, ...)`: with
 * FRESHELL_E2E_TARGET_URL set it silently retargets to an already-running
 * (possibly LIVE) server. The real CLIs run with HOME/CODEX_HOME/CLAUDE_HOME
 * pointed at the throwaway server HOME (applyIsolatedHomeEnvironment), never
 * the user's real stores.
 */

const MARKERS = {
  codex: 'MARKER-CODEX-7f3a the aubergine protocol',
  amplifier: 'MARKER-AMP-9c1e the cerulean ledger',
  claude: 'MARKER-CLAUDE-4b8d the vermilion archive',
} as const

// codex id = the exact UUID the Task 6 probe proved; amplifier/claude ids are
// UUIDv4 (the probe found amplifier's real store uses UUIDs, not slugs).
const IDS = {
  codex: '71e0bd02-cd52-42f7-8284-2624c9b7e288',
  amplifier: '5a7c9e1b-3d5f-4a8c-8e2d-6f4b0a9c7e21',
  claude: '9d2f4c6e-8a1b-4e3d-9c5f-7b2a8d4e6f10',
} as const

const PROVIDERS = ['codex', 'amplifier', 'claude'] as const
type Provider = (typeof PROVIDERS)[number]

// mirror of codex-terminal-bounce-rust.spec.ts:169-174 (no bootAndConnect helper exists)
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

// Mirror of sidebar-click-resume.spec.ts's picker handling: a fresh client's
// default tab may open on the shell picker; settle it so the sidebar and tab
// count are stable before the legs start.
async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

// Find a provider pane's Redux content by scanning every tab's pane layout
// (uniform same-session evidence -- GET /api/terminals DELIBERATELY omits
// `sessionRef` for codex/shell items, see terminals.rs). Same shape as
// snapshot-restore-rust.spec.ts's codexPane, parameterized by mode.
async function paneByMode(harness: TestHarness, mode: Provider): Promise<any | null> {
  const state = await harness.getState()
  for (const tab of state?.tabs?.tabs ?? []) {
    const layout = state?.panes?.layouts?.[tab.id]
    if (layout?.type === 'leaf' && layout.content?.kind === 'terminal' && layout.content?.mode === mode) {
      return layout.content
    }
  }
  return null
}

test.describe('continuity smoke (REAL CLIs) -- pre-deploy gate', () => {
  test('three real panes survive server restart + page reload with the same sessions', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (spec is also in every match-all project's testIgnore)
    test.setTimeout(300_000) // hard cap 5 min; target wall clock <= 5 min (single scenario, polling waits only)

    // EPHEMERAL-ONLY: construct RustServer directly (throwaway port + mkdtemp
    // HOME) so this can never touch an external/live target.
    const server = new RustServer({
      // NO fake-CLI env: real codex/amplifier/claude from PATH on purpose.
      // ANTHROPIC_API_KEY -> undefined: Node's spawn DROPS undefined env
      // values, so the key is genuinely ABSENT in the server (and thus every
      // PTY child) -- probe finding 3c: if present, claude blocks on a
      // "use this API key?" confirmation before anything renders.
      env: { ANTHROPIC_API_KEY: undefined } as unknown as Record<string, string>,
      setupHome: async (homeDir) => {
        // NOTE: setupHome re-runs on every boot (start AND restart) --
        // everything below is idempotent overwrites of the same seeds.
        const cwd = path.join(homeDir, 'proj')
        await fs.mkdir(cwd, { recursive: true })

        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            codingCli: { enabledProviders: ['claude', 'codex', 'opencode', 'amplifier'] },
          },
        }, null, 2))

        // ---- codex (probe 3a): dated rollout with FULL session_meta +
        // event_msg records (codex 0.145's TUI replays history from
        // event_msg, not response_item; the id lookup needs a fully
        // parseable session_meta). The freshell indexer walks
        // <codex_home>/sessions/**/*.jsonl recursively (directory_index.rs
        // CodexSource), so ONE dated file serves both the sidebar and the
        // real CLI. Title (= sidebar label) comes from the first user
        // message: the MARKER sentence itself. ----
        const codexDir = path.join(homeDir, '.codex')
        const rolloutDir = path.join(codexDir, 'sessions', '2026', '07', '22')
        await fs.mkdir(rolloutDir, { recursive: true })
        const codexLines = [
          JSON.stringify({
            timestamp: '2026-07-22T08:00:00.000Z',
            type: 'session_meta',
            payload: {
              session_id: IDS.codex,
              id: IDS.codex,
              timestamp: '2026-07-22T08:00:00.000Z',
              cwd,
              originator: 'codex_cli_rs',
              cli_version: '0.145.0',
              source: 'cli',
              thread_source: 'user',
              model_provider: 'openai',
              history_mode: 'legacy',
            },
          }),
          JSON.stringify({
            timestamp: '2026-07-22T08:00:01.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: MARKERS.codex }] },
          }),
          JSON.stringify({
            timestamp: '2026-07-22T08:00:01.500Z',
            type: 'event_msg',
            payload: { type: 'user_message', message: MARKERS.codex, kind: 'plain' },
          }),
          JSON.stringify({
            timestamp: '2026-07-22T08:00:02.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ack MARKER-CODEX-7f3a' }] },
          }),
          JSON.stringify({
            timestamp: '2026-07-22T08:00:02.500Z',
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'ack MARKER-CODEX-7f3a' },
          }),
        ]
        await fs.writeFile(
          path.join(rolloutDir, `rollout-2026-07-22T08-00-00-${IDS.codex}.jsonl`),
          `${codexLines.join('\n')}\n`,
        )
        // Auth file REQUIRED (probe 3a): read-only COPY of the user's real
        // auth.json into the throwaway HOME; without it codex shows the
        // ChatGPT sign-in screen and never reaches resume. Nothing in the
        // user's real ~/.codex is ever modified.
        const realCodexAuth = path.join(os.homedir(), '.codex', 'auth.json')
        await fs.copyFile(realCodexAuth, path.join(codexDir, 'auth.json')).catch((error) => {
          throw new Error(
            `continuity smoke codex leg requires a readable ${realCodexAuth} (read-only copy into the throwaway HOME): ${error}`,
          )
        })
        // Trust-prompt bypass (probe 3a).
        await fs.writeFile(
          path.join(codexDir, 'config.toml'),
          `[projects."${cwd}"]\ntrust_level = "trusted"\n`,
        )

        // ---- amplifier (probe 3b): real layout
        // projects/<cwd `/`->`-`>/sessions/<uuid>/ (dots NOT munged). ----
        const ampSlug = cwd.replace(/\//g, '-')
        const ampSessionDir = path.join(homeDir, '.amplifier', 'projects', ampSlug, 'sessions', IDS.amplifier)
        await fs.mkdir(ampSessionDir, { recursive: true })
        await fs.writeFile(path.join(ampSessionDir, 'metadata.json'), JSON.stringify({
          session_id: IDS.amplifier,
          created: '2026-07-22T08:00:00.000000+00:00',
          bundle: 'bundle:anchors',
          model: 'anthropic/claude-fable-5',
          turn_count: 1,
          working_dir: cwd,
        }))
        await fs.writeFile(path.join(ampSessionDir, 'transcript.jsonl'), [
          JSON.stringify({ role: 'user', content: MARKERS.amplifier }),
          JSON.stringify({ role: 'assistant', content: 'ack MARKER-AMP-9c1e' }),
        ].join('\n') + '\n')

        // ---- claude (probe 3c): project dir munges BOTH `/` AND `.` to
        // `-` (the trap: `/`-only munging -> "No conversation found"); user
        // content as a plain STRING (array shape renders only the assistant
        // MARKER); assistant content stays an array of text blocks. ----
        const claudeSlug = cwd.replace(/[/.]/g, '-')
        const claudeProjectDir = path.join(homeDir, '.claude', 'projects', claudeSlug)
        await fs.mkdir(claudeProjectDir, { recursive: true })
        const claudeUserUuid = 'c1a2b3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
        const claudeLines = [
          JSON.stringify({
            parentUuid: null,
            isSidechain: false,
            type: 'user',
            uuid: claudeUserUuid,
            sessionId: IDS.claude,
            timestamp: '2026-07-22T08:00:01.000Z',
            cwd,
            userType: 'external',
            version: '2.1.218',
            message: { role: 'user', content: MARKERS.claude },
          }),
          JSON.stringify({
            parentUuid: claudeUserUuid,
            isSidechain: false,
            type: 'assistant',
            uuid: 'd2b3c4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
            sessionId: IDS.claude,
            timestamp: '2026-07-22T08:00:02.000Z',
            cwd,
            userType: 'external',
            version: '2.1.218',
            message: { role: 'assistant', content: [{ type: 'text', text: 'ack MARKER-CLAUDE-4b8d' }] },
          }),
        ]
        await fs.writeFile(path.join(claudeProjectDir, `${IDS.claude}.jsonl`), `${claudeLines.join('\n')}\n`)
        // Onboarding (theme picker) + trust-dialog bypass (probe 3c).
        await fs.writeFile(path.join(homeDir, '.claude.json'), JSON.stringify({
          hasCompletedOnboarding: true,
          theme: 'dark',
          projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } },
        }))
      },
    })
    const info = await server.start()

    try {
      let harness = await connect(page, info)
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
      const cwd = path.join(info.homeDir, 'proj')
      const baseline = await harness.getTabCount()

      // Find the live (non-exited) terminal for a mode from the RAW
      // /api/terminals array (no envelope; codex/shell items deliberately
      // omit sessionRef -- identity is asserted via paneByMode instead).
      const termByMode = async (mode: Provider) => {
        const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
        return (terms as any[]).find((t) => t.mode === mode && t.status !== 'exited') ?? null
      }
      // Server-side scrollback-mirror search: the strongest offline proof a
      // real CLI rendered text into a pane. Param name MUST be `query`
      // (terminals.rs:176 -- `?q=` is a 400); response is {matches:[...]}
      // (terminals.rs:392).
      const searchTerminal = async (terminalId: string, text: string): Promise<number> => {
        const res = await fetch(
          `${info.baseUrl}/api/terminals/${terminalId}/search?query=${encodeURIComponent(text)}`,
          { headers: auth },
        )
        if (!res.ok) throw new Error(`terminal search failed: HTTP ${res.status}`)
        const body = await res.json()
        return (body.matches ?? []).length
      }

      // Probe 3a: codex's resume-cwd picker ("Choose working directory to
      // resume this session") appears before history renders -- even when
      // cwd == the session's recorded cwd (100% of probes). Poll the codex
      // pane's scrollback mirror: done when the MARKER is rendered; while
      // the picker is showing (and the MARKER is not), send one Enter via
      // the page's authed WS (terminal.input). Extra Enters after the picker
      // are no-ops on the empty composer. Applies to every fresh codex
      // spawn: the initial sidebar open AND the post-restart respawn (a page
      // reload reattaches the existing terminal, so no new picker).
      const settleCodexResumePicker = async (): Promise<void> => {
        const deadline = Date.now() + 60_000
        let lastSeen = '(no live codex terminal yet)'
        while (Date.now() < deadline) {
          const t = await termByMode('codex')
          if (t) {
            lastSeen = `terminal ${t.terminalId}`
            if (await searchTerminal(t.terminalId, MARKERS.codex.slice(0, 20)) > 0) return
            if (await searchTerminal(t.terminalId, 'Choose working directory') > 0) {
              await page.evaluate((terminalId) => {
                (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({
                  type: 'terminal.input',
                  terminalId,
                  data: '\r',
                })
              }, t.terminalId)
            }
          }
          await page.waitForTimeout(1_000)
        }
        throw new Error(`codex history never rendered (picker never settled?): ${lastSeen}`)
      }

      // Outcome assertions, identical after each phase: (1) same tab count,
      // (2) each pane's claimed session id unchanged, (3) the seeded MARKER
      // visible in each resumed pane's terminal (server scrollback mirror).
      const expectContinuity = async (h: TestHarness, phase: string): Promise<void> => {
        await expect(async () => {
          expect(await h.getTabCount(), `${phase}: tab count`).toBe(baseline + 3)
        }).toPass({ timeout: 30_000 })
        await expect(async () => {
          for (const p of PROVIDERS) {
            // (2) same session id (Redux pane content -- uniform across
            // providers; /api/terminals omits sessionRef for codex).
            const content = await paneByMode(h, p)
            expect(content?.sessionRef?.sessionId, `${phase}: ${p} same session`).toBe(IDS[p])
            // (3) MARKER rendered by the REAL CLI into the pane's
            // server-side scrollback mirror (probe verdict: all three CLIs
            // render offline; no leg downgraded to identity-only).
            const t = await termByMode(p)
            expect(t, `${phase}: ${p} terminal live`).toBeTruthy()
            const matches = await searchTerminal(t.terminalId, MARKERS[p].slice(0, 20))
            expect(matches, `${phase}: ${p} MARKER rendered by real CLI`).toBeGreaterThan(0)
          }
        }).toPass({ timeout: 60_000 })
      }

      // ----------------------------------------------------------------
      // LEG 1 (user path: sidebar click) -- codex. The seeded session's
      // sidebar title IS the MARKER sentence (title = first user message).
      // The client's gold path (openSessionTab) stamps the sessionRef; the
      // server re-derives resume args from it on restart -- exactly the
      // `136b9e94` surface Task 8's proof run exercises.
      // ----------------------------------------------------------------
      const sessionList = page.getByTestId('sidebar-session-list')
      await expect(sessionList).toBeVisible({ timeout: 15_000 })
      const sessionItem = page.getByText('MARKER-CODEX', { exact: false }).first()
      await expect(sessionItem).toBeVisible({ timeout: 15_000 })
      await sessionItem.click()
      await expect(async () => {
        expect(await harness.getTabCount()).toBe(baseline + 1)
      }).toPass({ timeout: 15_000 })

      // ----------------------------------------------------------------
      // LEGS 2+3 (agent/API path: REST create with sessionRef) --
      // amplifier + claude. POST /api/tabs returns the {status,data}
      // envelope; unwrap .data.
      // ----------------------------------------------------------------
      for (const p of ['amplifier', 'claude'] as const) {
        const r = await fetch(`${info.baseUrl}/api/tabs`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            mode: p,
            cwd,
            name: `smoke ${p}`,
            sessionRef: { provider: p, sessionId: IDS[p] },
          }),
        })
        const body = await r.json()
        expect(r.ok, `POST /api/tabs (${p}): ${JSON.stringify(body)}`).toBe(true)
        expect(body?.data?.tabId, `POST /api/tabs (${p}) envelope data`).toBeTruthy()
      }

      await settleCodexResumePicker()
      await expectContinuity(harness, 'initial open')

      // ----------------------------------------------------------------
      // DISRUPTION 1: server restart WITHOUT a page reload -- the live
      // client auto-reconnects (same port/token) and re-creates each
      // pane's terminal from its persisted sessionRef. Reconnect wait
      // copied from codex-terminal-bounce-rust.spec.ts:236-239.
      // ----------------------------------------------------------------
      await server.restart()
      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })
      await settleCodexResumePicker() // fresh codex respawn -> picker again
      await expectContinuity(harness, 'after restart (no reload)')

      // ----------------------------------------------------------------
      // DISRUPTION 2: page reload -- terminals stay alive server-side; the
      // reloaded client reattaches every pane (no respawn, so the mirror
      // still holds each MARKER and no new codex picker appears).
      // ----------------------------------------------------------------
      await page.reload()
      harness = await connect(page, info)
      await expectContinuity(harness, 'after reload')
    } finally {
      await server.stop()
    }
  })
})
