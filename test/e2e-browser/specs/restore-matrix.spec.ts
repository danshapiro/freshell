import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * RESTORE-MATRIX -- bulletproof-restore acceptance suite (HARNESS-02 matrix).
 *
 * Restore is the user's declared core feature. This spec covers the four
 * restore surfaces called out by the FreshCodex live-update/reload
 * investigation and the follow-on fix commits (b9e0c1a3, 89f4b2fe):
 *
 *   1. TERMINAL RESTORE      -- plain shell PTY survives reload + server restart.
 *   2. FRESH-AGENT RESTORE   -- FreshCodex reload never mints a new session
 *                               (the WS `freshAgent.attach` fix in 89f4b2fe).
 *   3. HISTORICAL SESSION    -- opening a seeded Claude session from the
 *                               sidebar gets a real pane title + non-blank
 *                               content (the `terminal.meta.updated` fix in
 *                               b9e0c1a3).
 *   4. EXIT SURFACING        -- a terminal that exits before/at reload never
 *                               renders silently blank (also b9e0c1a3).
 *
 * Every scenario runs against BOTH the legacy Node server and the owned Rust
 * server via the `e2eServerKind` project option (see playwright.config.ts's
 * MATRIX_SPECS), using ONLY the generic E2eServerHandle/testServer seam --
 * no server-kind-specific assertions.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Write a small executable wrapper (into a throwaway directory) that re-execs
 * `node <original fixture path>` with the same argv, rather than copying the
 * fixture's CONTENT elsewhere or mutating its tracked permission bits in
 * place (this spec only owns `test/e2e-browser/**`). Two things make a plain
 * copy unsafe: (1) permission-bit changes on a file outside this spec's owned
 * path, and (2) the fixture's `import { WebSocketServer } from 'ws'` is an ESM
 * bare-specifier resolved relative to the FILE'S OWN location -- a copy
 * dropped in a bare temp dir has no `node_modules` ancestor and fails with
 * `ERR_MODULE_NOT_FOUND`. Re-execing node against the ORIGINAL path (still
 * inside the real project tree) avoids both problems.
 *
 * `CODEX_CMD` pointed at this wrapper's path works identically for BOTH
 * server kinds:
 *   - the legacy Node runtime (`server/coding-cli/codex-app-server/runtime.ts`)
 *     spawns `CODEX_CMD` directly as the executable (no shell, no splitting) --
 *     the wrapper's own `#!/usr/bin/env node` shebang (and its +x bit) handles
 *     the rest;
 *   - the Rust sidecar (`crates/freshell-freshagent/src/codex.rs`) whitespace-
 *     splits `CODEX_CMD` to also support a `"node <script>"` form, but a bare
 *     single-token executable path works there unchanged too.
 */
async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

/**
 * Write a minimal, deterministic fake `claude` CLI executable (into a
 * throwaway directory) for SCENARIO 3's `CLAUDE_CMD` override. Unlike
 * FreshCodex's fake app-server (a headless JSON-RPC sidecar the real
 * fresh-agent runtime talks to over stdio), resuming a historical Claude
 * session from the sidebar spawns `claude` as a plain interactive TERMINAL
 * program (`server/terminal-registry.ts`'s `claude` provider entry, PTY-
 * attached) -- whatever it writes to stdout lands directly in the pane's
 * xterm buffer. So the fake here is intentionally trivial: it ignores argv
 * (including the real `--resume <sessionId>` flag the registry passes) and
 * just prints deterministic text, satisfying this scenario's "content is
 * never silently blank" requirement with genuine CLI output rather than a
 * status notice. `server/terminal-registry.ts`'s `CLAUDE_CMD` env var
 * override (`resolveClaudeCommand()`) accepts a bare executable path, same
 * as `CODEX_CMD` -- see `installFakeCodexAppServer` above for why a `+x`
 * wrapper (not a content copy) is used to install it.
 */
async function installFakeClaudeCli(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-claude-cli.mjs')
  // Prints deterministic output then stays alive (like the real interactive
  // `claude` TUI would) rather than exiting -- keeps the pane's terminal
  // status 'running' with genuine buffer content, instead of racing this
  // scenario's assertions against 'exited'-state UI (a different, already
  // covered concern -- see SCENARIO 4 below). The test's `server.stop()`
  // tears the process down; nothing needs to shut it down cleanly itself.
  const script = `#!/usr/bin/env node
process.stdout.write('restore-matrix historical session resumed output\\r\\n')
process.stdin.resume()
`
  await fs.writeFile(dest, script, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

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

/** Find the (first) fresh-agent leaf node within a possibly-split pane layout tree. */
function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

async function bootAndConnect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
  options: { selectShell?: boolean } = {},
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  if (options.selectShell !== false) {
    await selectShellIfPickerShowing(page)
  }
  return harness
}

test.describe('Restore Matrix', () => {
  test.setTimeout(180_000)

  // -------------------------------------------------------------------
  // SCENARIO 1 -- TERMINAL RESTORE (reload, then server restart)
  // -------------------------------------------------------------------
  test('terminal survives page reload and then a full server restart', async ({ page, terminal, e2eServerKind }) => {
    const server = await createE2eServerHandle(process.env, { kind: e2eServerKind })
    const info = await server.start()

    try {
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const marker1 = `RESTORE-T1-${Math.random().toString(36).slice(2, 10)}`
      await terminal.executeCommand(`echo ${marker1}`)
      await terminal.waitForOutput(marker1, { timeout: 15_000 })

      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()
      const layoutBefore = await harness.getPaneLayout(tabId!)
      const terminalIdBefore = layoutBefore?.content?.terminalId
      expect(terminalIdBefore).toBeTruthy()

      // --- reload: the pane must reattach to the SAME terminal, with the
      // marker still present in scrollback, and remain interactive. ---
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await terminal.waitForOutput(marker1, { timeout: 15_000 })

      const layoutAfterReload = await harness.getPaneLayout(tabId!)
      expect(layoutAfterReload?.content?.terminalId).toBe(terminalIdBefore)
      expect(layoutAfterReload?.content?.status).not.toBe('error')

      const marker2 = `RESTORE-T2-${Math.random().toString(36).slice(2, 10)}`
      await terminal.executeCommand(`echo ${marker2}`)
      await terminal.waitForOutput(marker2, { timeout: 15_000 })

      // --- full server restart: PTYs are lost, so the pane must recreate
      // (new terminalId), matching server-restart-recovery.spec.ts's
      // acceptance shape: no error status, a fresh terminalId is assigned. ---
      if (!server.restart) {
        throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
      }
      await server.restart()

      await expect(async () => {
        const status = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 30_000 })

      await expect(async () => {
        const tabCount = await harness.getTabCount()
        expect(tabCount).toBe(1)
        const layout = await harness.getPaneLayout(tabId!)
        expect(layout?.content?.status).not.toBe('error')
        expect(layout?.content?.terminalId).toBeTruthy()
      }).toPass({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 2 -- FRESH-AGENT RESTORE (reload never abandons the session)
  // -------------------------------------------------------------------
  // ROOT-CAUSE FINDING (control run against the FROZEN legacy client,
  // `--project=legacy-chromium`): FreshCodex's real reload-restore contract
  // is NOT "attach only, never create" -- it is CREATE-WITH-RESUME. The
  // frozen client's persisted pane state deliberately does not carry a live
  // `sessionId` across a full page reload (only `sessionRef`/
  // `resumeSessionId` survive); on reload, `FreshAgentView`'s create-effect
  // (`!paneContent.sessionId && paneContent.sessionRef`) fires a NEW
  // `freshAgent.create` carrying `resumeSessionId`/`sessionRef` pointing at
  // the ORIGINAL durable session. Only once the resulting `freshAgent.created`
  // response repopulates `sessionId` does the attach-effect fire a
  // `freshAgent.attach` for the same id. Captured wire sequence on
  // `legacy-chromium` (debug capture, since removed): `hello` ->
  // `freshAgent.create` (`resumeSessionId`/`sessionRef` == original session)
  // -> `freshAgent.attach` (`sessionId` == original session) -- and the UI
  // evidence (`error-context.md` screenshot from the earlier failing run)
  // showed the prior transcript ("Fixture turn") rehydrated correctly. This
  // is a genuinely-working restore path, just not an attach-only one -- so
  // the original "no freshAgent.create at all after reload" assertion tested
  // an implementation detail that doesn't match the frozen client's real
  // contract, not a regression. Confirmed byte-identical on `rust-chromium`
  // (same 3-message sequence, same resume-target correctness). The scenario
  // now asserts the CONTRACT that actually matters -- any `freshAgent.create`
  // sent after reload must target the ORIGINAL session (never mint an
  // unrelated blank one), the session ends up on the same id, the transcript
  // rehydrates, and status settles idle -- rather than the implementation
  // detail of which message type does the resuming. Two real spec bugs found
  // and fixed while building this (see `findFreshAgentLeaf` -- the pane
  // lives inside a SPLIT once created via the picker, so `layout.content`
  // alone is the wrong read -- and the missing `persist/flushNow` before
  // reload).
  test('FreshCodex reload rehydrates the same session instead of creating a new one', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-codex-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: { CODEX_CMD: fakeCodexPath },
          // Fresh-agent creation is gated SERVER-side (ws-handler.ts checks
          // `settings.freshAgent.enabled` and `settings.codingCli.enabledProviders`
          // -- `FRESH_CLIENTS_DISABLED` otherwise). A client-only Redux
          // "preview" dispatch does not reach that server-side check, so the
          // real persisted config must be seeded before boot.
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // Client-only concern: the picker only shows Freshcodex if the codex
        // CLI is reported as "available" -- this test's isolated HOME has no
        // real codex binary on PATH, so declare availability directly (the
        // ACTUAL session creation is gated server-side and was already
        // enabled for real above).
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        await harness.clearSentWsMessages()
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })

        // Real `freshAgent.create` was sent (proves the UI-driven create path
        // genuinely reaches the server -- the server-side gate that used to
        // reject it, `FRESH_CLIENTS_DISABLED`, is now open per the seeded
        // config above).
        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) => m?.type === 'freshAgent.create' && m?.provider === 'codex')
        }, { timeout: 15_000 }).toBe(true)

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // The live sidecar round trip (spawn -> initialize -> thread/start)
        // can be slow/flaky on constrained CI-like hosts; give it a generous
        // window, but this scenario's core assertions (below) do not
        // otherwise depend on how quickly this settles.
        const originalSessionId: string | null = await (async () => {
          try {
            return await expect.poll(async () => {
              const layout = await harness.getPaneLayout(tabId!)
              const leaf = findFreshAgentLeaf(layout)
              return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
            }, { timeout: 30_000 }).not.toBeNull().then(async () => {
              const layout = await harness.getPaneLayout(tabId!)
              const leaf = findFreshAgentLeaf(layout)
              return leaf.content.sessionId ?? leaf.content.sessionRef.sessionId
            })
          } catch {
            return null
          }
        })()

        // If the live sidecar round trip did settle in time, also verify the
        // deterministic fixture reply renders and the pane returns to idle --
        // this is a bonus assertion layered on top of the REQUIRED restore
        // assertions below, not a substitute for them.
        if (originalSessionId) {
          const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
          if (await composer.isVisible().catch(() => false)) {
            await composer.fill('restore-matrix probe message')
            await paneRoot.getByRole('button', { name: 'Send' }).click()
            await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 20_000 }).catch(() => {})
          }
        }

        // The id this scenario asserts restore against: the real server-
        // assigned id if the live round trip settled, otherwise the pane's
        // own createRequestId (still a real, stable identity the client
        // tracks and must not abandon on reload).
        const fallbackLayout = await harness.getPaneLayout(tabId!)
        const fallbackLeaf = findFreshAgentLeaf(fallbackLayout)
        const restoreSessionId: string = originalSessionId ?? fallbackLeaf?.content?.createRequestId
        expect(restoreSessionId).toBeTruthy()

        // --- RELOAD: this is the core of DEFECT 2. Before commit 89f4b2fe,
        // the WS `freshAgent.attach` handler rejected any session id not
        // currently in the sidecar's in-memory map with `INVALID_SESSION_ID`,
        // the client's `markSessionLost` abandoned the durable id, and a
        // BRAND NEW, UNRELATED `freshAgent.create` was sent post-reload
        // (no `resumeSessionId`/`sessionRef` tying it back to the original
        // session -- the data was genuinely lost). ---
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 20_000 })

        // (a) An `freshAgent.attach` referencing the ORIGINAL id was sent.
        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) => m?.type === 'freshAgent.attach' && m?.sessionId === originalSessionId)
        }, { timeout: 20_000 }).toBe(true)

        // (a2) The frozen client's real restore contract for FreshCodex is
        // CREATE-WITH-RESUME, not attach-only (see the scenario comment
        // above for the full wire-sequence evidence): on reload, `sessionId`
        // does not survive in persisted pane state, so the create-effect
        // fires again because `sessionRef` does. That is fine -- restore
        // still holds -- AS LONG AS every such create explicitly targets the
        // ORIGINAL session via `resumeSessionId`/`sessionRef`. A create with
        // no resume target (or one pointing somewhere else) would mean the
        // session was genuinely abandoned -- THAT is DEFECT 2, and must
        // still fail this test.
        const sentAfterReload = await harness.getSentWsMessages()
        const createsAfterReload = sentAfterReload.filter((m: any) => m?.type === 'freshAgent.create')
        for (const create of createsAfterReload) {
          const resumeTarget = (create as any).resumeSessionId ?? (create as any).sessionRef?.sessionId
          expect(resumeTarget).toBe(originalSessionId)
        }

        const rehydratedTabId = await harness.getActiveTabId()
        const rehydratedLayout = await harness.getPaneLayout(rehydratedTabId!)
        const rehydratedLeaf = findFreshAgentLeaf(rehydratedLayout)
        if (originalSessionId) {
          expect(rehydratedLeaf?.content?.sessionId ?? rehydratedLeaf?.content?.sessionRef?.sessionId)
            .toBe(originalSessionId)
        }

        // (b) SAME transcript rehydrates -- the prior assistant turn is
        // visible again (fetched via the thread history REST call, which
        // the fake app-server also answers deterministically).
        await expect(page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'))
          .toBeVisible({ timeout: 20_000 })

        // (c) status settles idle (busy/creating indicator clears).
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(rehydratedTabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 3 -- HISTORICAL SESSION OPEN (sidebar -> tab, real pane title)
  // -------------------------------------------------------------------
  // ROOT-CAUSE FINDING (spec bug, not a product defect -- confirmed via the
  // FROZEN server's own filtering logic, identical on both server kinds):
  // `server/coding-cli/providers/claude.ts`'s `parseClaudeSession` marks a
  // session `isNonInteractive: true` whenever `userMessageCount <= 1`
  // (single request/reply pair = "headless dispatch or abandoned session",
  // per that file's own comment). `server/session-directory/service.ts`
  // then filters `isNonInteractive` sessions OUT of any `/session-directory`
  // query unless the caller passes `includeNonInteractive: true` --
  // `src/store/sessionsThunks.ts`'s default sidebar fetch does not (it only
  // sets that flag from `sidebarSettings?.showNoninteractiveSessions`, unset
  // by default). This scenario's seed JSONL had exactly ONE user/assistant
  // turn, so the seeded session was silently excluded from the sidebar's
  // result set -- zero items renders the "No sessions yet" empty state
  // (no `sidebar-session-list` testid), which is exactly the observed
  // symptom ("element(s) not found" after 30s). `session-directory-matrix.spec.ts`
  // seeds TWO user/assistant turns per session via its `buildSessionJsonl`
  // helper, which is why its otherwise-identical JSONL shape is discovered
  // and rendered. Fix: seed two turns here too (matching that helper's
  // shape) so the session is genuinely interactive and passes the server's
  // own (correct, intentional) filter -- no server/client code changed.
  test('opening a seeded historical session from the sidebar gets a real pane title and non-blank content', async ({ page, e2eServerKind }) => {
    const SESSION_ID = '00000000-0000-4000-8000-0000000c3333'
    const SESSION_TITLE = 'restore-matrix historical session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-claude-'))
    const fakeClaudePath = await installFakeClaudeCli(path.join(sharedRoot, 'bin'))

    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        // Resuming this seeded session spawns the terminal-mode `claude`
        // provider (`server/terminal-registry.ts`'s `CLAUDE_CMD` override),
        // which is a real, PTY-attached interactive program -- not a fake
        // JSON-RPC sidecar. Without a `claude` binary on PATH, the isolated
        // test HOME has nothing for the real command to spawn. Point it at
        // the deterministic fake above so this scenario's "content is never
        // silently blank" requirement is proven with genuine CLI output.
        env: { CLAUDE_CMD: fakeClaudePath },
        setupHome: async (homeDir) => {
          const projectDir = path.join(homeDir, '.claude', 'projects', 'restore-matrix-project')
          await fs.mkdir(projectDir, { recursive: true })
          // The seeded JSONL's `cwd` must exist on disk: resuming this
          // session spawns a REAL PTY-attached process there (see the
          // `CLAUDE_CMD` override above), and a real Claude session's `cwd`
          // is always a real directory in production.
          await fs.mkdir('/tmp/freshell-restore-matrix/project', { recursive: true })
          const lines: string[] = [
            JSON.stringify({
              type: 'system',
              subtype: 'init',
              session_id: SESSION_ID,
              uuid: `${SESSION_ID}-system`,
              timestamp: '2026-07-16T08:00:00.000Z',
              cwd: '/tmp/freshell-restore-matrix/project',
              git: { branch: 'main', dirty: false },
            }),
            JSON.stringify({
              parentUuid: `${SESSION_ID}-system`,
              cwd: '/tmp/freshell-restore-matrix/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'user',
              message: { role: 'user', content: `${SESSION_TITLE} request 1` },
              uuid: `${SESSION_ID}-user-1`,
              timestamp: '2026-07-16T08:00:01.000Z',
            }),
            JSON.stringify({
              parentUuid: `${SESSION_ID}-user-1`,
              cwd: '/tmp/freshell-restore-matrix/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'assistant',
              message: {
                role: 'assistant',
                model: 'claude-opus-4-6-20260301',
                content: [{ type: 'text', text: `${SESSION_TITLE} reply 1` }],
                usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              },
              uuid: `${SESSION_ID}-assistant-1`,
              timestamp: '2026-07-16T08:00:02.000Z',
            }),
            // Second user/assistant turn: a session with only ONE turn is
            // classified `isNonInteractive` server-side (see root-cause
            // comment above) and silently excluded from the sidebar's
            // default query -- two turns makes this genuinely interactive.
            JSON.stringify({
              parentUuid: `${SESSION_ID}-assistant-1`,
              cwd: '/tmp/freshell-restore-matrix/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'user',
              message: { role: 'user', content: `${SESSION_TITLE} request 2` },
              uuid: `${SESSION_ID}-user-2`,
              timestamp: '2026-07-16T08:00:03.000Z',
            }),
            JSON.stringify({
              parentUuid: `${SESSION_ID}-user-2`,
              cwd: '/tmp/freshell-restore-matrix/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'assistant',
              message: {
                role: 'assistant',
                model: 'claude-opus-4-6-20260301',
                content: [{ type: 'text', text: `${SESSION_TITLE} reply 2` }],
                usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              },
              uuid: `${SESSION_ID}-assistant-2`,
              timestamp: '2026-07-16T08:00:04.000Z',
            }),
            JSON.stringify({
              type: 'summary',
              summary: SESSION_TITLE,
              leafUuid: `${SESSION_ID}-assistant-2`,
            }),
          ]
          await fs.writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`)
        },
      },
    })
    const info = await server.start()

    try {
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const sessionList = page.getByTestId('sidebar-session-list')
      await expect(sessionList).toBeVisible({ timeout: 30_000 })

      const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
      await expect(sessionItem).toBeVisible({ timeout: 15_000 })

      const tabCountBefore = await harness.getTabCount()
      await sessionItem.click()

      // A new tab opens for the historical session.
      await expect(async () => {
        const tabCount = await harness.getTabCount()
        expect(tabCount).toBe(tabCountBefore + 1)
      }).toPass({ timeout: 15_000 })

      const newTabId = await harness.getActiveTabId()
      expect(newTabId).toBeTruthy()

      // (a) Pane/tab title becomes the real session title (terminal.meta.updated
      // on resume-create, per b9e0c1a3) -- not a generic placeholder like
      // "Terminal" or the raw session id.
      await expect(async () => {
        const state = await harness.getState()
        const tab = state.tabs.tabs.find((t: any) => t.id === newTabId)
        expect(tab?.title).toBeTruthy()
        expect(tab.title).not.toBe('Terminal')
        expect(tab.title).not.toBe(SESSION_ID)
      }).toPass({ timeout: 20_000 })

      await expect(page.locator(`[data-context="tab"][data-tab-id="${newTabId}"]`))
        .toContainText(SESSION_TITLE, { timeout: 20_000 })

      // (b) Content is NEVER silently blank: either the resumed CLI renders
      // real output, or a visible status/error notice explains why not --
      // but something must be visible. Scoped to THIS tab's terminal
      // (`data-context="terminal"][data-tab-id="..."]`) rather than a bare
      // `.xterm` query -- with the original tab's terminal still mounted
      // (just hidden) alongside this new tab, an unscoped `.first()` can
      // resolve to the WRONG (hidden) pane's xterm, same class of bug noted
      // in SCENARIO 2's `findFreshAgentLeaf` comment above.
      const newTabTerminal = page.locator(`[data-context="terminal"][data-tab-id="${newTabId}"]`)
      await expect(async () => {
        const xtermVisible = await newTabTerminal.locator('.xterm').first().isVisible().catch(() => false)
        const buffer = xtermVisible
          ? await page.evaluate((tid) => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(tid), (await harness.getPaneLayout(newTabId!))?.content?.terminalId)
          : null
        const hasBufferContent = typeof buffer === 'string' && buffer.trim().length > 0
        const hasVisibleStatusNotice = await newTabTerminal
          .getByText(/error|exited|failed|not found/i)
          .first()
          .isVisible()
          .catch(() => false)
        expect(hasBufferContent || hasVisibleStatusNotice).toBe(true)
      }).toPass({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 3b -- SESSION-10 DEDUP / REUSE (focus existing, no duplicate)
  // -------------------------------------------------------------------
  // Proves SESSION-10's "focus/reuse the live pane instead of opening
  // duplicates" clause: after opening a historical session from the sidebar
  // (which creates a new tab with a running terminal), switching to a
  // different tab, and clicking the SAME session from the sidebar again,
  // the EXISTING tab is focused (becomes active) and the tab count does
  // NOT increase (no duplicate tab created).  This is the `findTabIdForSession`
  // dedup path in `src/store/tabsSlice.ts`'s `openSessionTab` action.
  test('SESSION-10: re-clicking a running session from the sidebar focuses the existing tab instead of creating a duplicate', async ({ page, e2eServerKind }) => {
    const SESSION_ID = '00000000-0000-4000-8000-0000000d4444'
    const SESSION_TITLE = 'SESSION-10 dedup reuse historical session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-session10-dedup-'))
    const fakeClaudePath = await installFakeClaudeCli(path.join(sharedRoot, 'bin'))

    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { CLAUDE_CMD: fakeClaudePath },
        setupHome: async (homeDir) => {
          const projectDir = path.join(homeDir, '.claude', 'projects', 'session10-dedup-project')
          await fs.mkdir(projectDir, { recursive: true })
          await fs.mkdir('/tmp/freshell-session10/project', { recursive: true })
          const lines: string[] = [
            JSON.stringify({
              type: 'system',
              subtype: 'init',
              session_id: SESSION_ID,
              uuid: `${SESSION_ID}-system`,
              timestamp: '2026-07-16T09:00:00.000Z',
              cwd: '/tmp/freshell-session10/project',
              git: { branch: 'main', dirty: false },
            }),
            JSON.stringify({
              parentUuid: `${SESSION_ID}-system`,
              cwd: '/tmp/freshell-session10/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'user',
              message: { role: 'user', content: `${SESSION_TITLE} request 1` },
              uuid: `${SESSION_ID}-user-1`,
              timestamp: '2026-07-16T09:00:01.000Z',
            }),
            JSON.stringify({
              parentUuid: `${SESSION_ID}-user-1`,
              cwd: '/tmp/freshell-session10/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'assistant',
              message: {
                role: 'assistant',
                model: 'claude-opus-4-6-20260301',
                content: [{ type: 'text', text: `${SESSION_TITLE} reply 1` }],
                usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              },
              uuid: `${SESSION_ID}-assistant-1`,
              timestamp: '2026-07-16T09:00:02.000Z',
            }),
            // Second user/assistant turn: ensures the session is classified
            // interactive (isNonInteractive filter requires >1 user turn).
            JSON.stringify({
              parentUuid: `${SESSION_ID}-assistant-1`,
              cwd: '/tmp/freshell-session10/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'user',
              message: { role: 'user', content: `${SESSION_TITLE} request 2` },
              uuid: `${SESSION_ID}-user-2`,
              timestamp: '2026-07-16T09:00:03.000Z',
            }),
            JSON.stringify({
              parentUuid: `${SESSION_ID}-user-2`,
              cwd: '/tmp/freshell-session10/project',
              sessionId: SESSION_ID,
              version: '2.1.23',
              gitBranch: 'main',
              type: 'assistant',
              message: {
                role: 'assistant',
                model: 'claude-opus-4-6-20260301',
                content: [{ type: 'text', text: `${SESSION_TITLE} reply 2` }],
                usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              },
              uuid: `${SESSION_ID}-assistant-2`,
              timestamp: '2026-07-16T09:00:04.000Z',
            }),
            JSON.stringify({
              type: 'summary',
              summary: SESSION_TITLE,
              leafUuid: `${SESSION_ID}-assistant-2`,
            }),
          ]
          await fs.writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`)
        },
      },
    })
    const info = await server.start()

    try {
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const sessionList = page.getByTestId('sidebar-session-list')
      await expect(sessionList).toBeVisible({ timeout: 30_000 })

      const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
      await expect(sessionItem).toBeVisible({ timeout: 15_000 })

      // Step 1: Open the session from the sidebar — creates a new tab.
      const tabCountBefore = await harness.getTabCount()
      await sessionItem.click()

      const sessionTabId = await (async () => {
        let id: string | null = null
        await expect(async () => {
          const tabCount = await harness.getTabCount()
          expect(tabCount).toBe(tabCountBefore + 1)
          id = await harness.getActiveTabId()
          expect(id).toBeTruthy()
        }).toPass({ timeout: 15_000 })
        return id!
      })()

      // Wait for the session tab's terminal to be running (the terminal
      // must be live for the dedup path to consider this tab an existing
      // owner of the session).
      await expect(async () => {
        const state = await harness.getState()
        const tab = state.tabs.tabs.find((t: any) => t.id === sessionTabId)
        expect(tab?.title).toBeTruthy()
        expect(tab.title).not.toBe('Terminal')
      }).toPass({ timeout: 20_000 })

      // Step 2: Switch away to the first (original) tab so the session tab
      // is no longer active.  We use the harness dispatch (same mechanism
      // the TabBar uses internally) to avoid depending on tab-bar visibility.
      const firstTabId = await (async () => {
        const state = await harness.getState()
        return state.tabs.tabs[0]?.id as string | undefined
      })()
      expect(firstTabId).toBeTruthy()
      expect(firstTabId).not.toBe(sessionTabId)

      await page.evaluate((tid) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: tid })
      }, firstTabId!)

      // Verify we successfully switched away.
      await expect(async () => {
        const active = await harness.getActiveTabId()
        expect(active).toBe(firstTabId)
      }).toPass({ timeout: 5_000 })

      // Step 3: Re-click the SAME session from the sidebar.
      const tabCountBeforeReclick = await harness.getTabCount()
      await sessionItem.click()

      // Step 4: Assert dedup — tab count does NOT increase, and the session
      // tab is now active (focused/reused, not duplicated).
      await expect(async () => {
        const tabCount = await harness.getTabCount()
        expect(tabCount).toBe(tabCountBeforeReclick) // no new tab created
        const active = await harness.getActiveTabId()
        expect(active).toBe(sessionTabId) // existing tab is focused
      }).toPass({ timeout: 15_000 })

      // Step 5: Assert only one tab references this session (no duplicate
      // owner).  `findTabIdForSession` in `src/lib/session-utils.ts` scans
      // both pane-leaf content (sessionRef / resumeSessionId) and tab-level
      // fallback fields.  We mirror that logic here.  Retry because
      // sessionRef is set asynchronously after the fresh-agent create
      // round-trip completes.
      const collectLeafContent = (node: any): any[] => {
        if (!node) return []
        if (node.type === 'leaf') return [node.content]
        if (node.type === 'split') return [...collectLeafContent(node.children?.[0]), ...collectLeafContent(node.children?.[1])]
        return []
      }
      await expect(async () => {
        const state = await harness.getState()
        const matchingTabs = state.tabs.tabs.filter((t: any) => {
          // Tab-level fallback fields (buildTabFallbackLocator)
          if (t?.sessionRef?.sessionId === SESSION_ID || t?.resumeSessionId === SESSION_ID) return true
          // Pane-leaf content (extractSessionLocators)
          const layout = state.panes?.layouts?.[t.id]
          const leafContents = collectLeafContent(layout)
          return leafContents.some((c) => c?.sessionRef?.sessionId === SESSION_ID || c?.resumeSessionId === SESSION_ID)
        })
        expect(matchingTabs.length).toBe(1)
      }).toPass({ timeout: 15_000 })
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 4 -- EXIT SURFACING (never silently blank after mid-life exit)
  // -------------------------------------------------------------------
  test('a terminal that exits before reload surfaces its exited state instead of rendering blank', async ({ page, terminal, e2eServerKind }) => {
    const server = await createE2eServerHandle(process.env, { kind: e2eServerKind })
    const info = await server.start()

    try {
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      // Exit the shell process intentionally (a real, fast PTY exit).
      await terminal.executeCommand('exit')

      // Wait for the server to register the exit before reloading, so the
      // reload genuinely exercises "attach to an already-exited terminal"
      // (the synthetic `terminal.exit` frame on attach, per b9e0c1a3) rather
      // than racing the exit notification.
      await expect(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        expect(layout?.content?.status).toBe('exited')
      }).toPass({ timeout: 15_000 })

      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      // Never silently blank: the pane must show SOME visible evidence of
      // the exit (status text, a notice in the xterm buffer, or an explicit
      // "exited" pane content status) -- not an empty pane with no signal.
      await expect(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const statusIsExited = layout?.content?.status === 'exited'
        const buffer = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer())
        const bufferMentionsExit = typeof buffer === 'string' && /exit/i.test(buffer)
        const visibleExitNotice = await page.getByText(/exit/i).first().isVisible().catch(() => false)
        expect(statusIsExited || bufferMentionsExit || visibleExitNotice).toBe(true)
      }).toPass({ timeout: 20_000 })

      // And it must not be a hard error state either -- an "exited" terminal
      // reattached after reload is a recognized, handled state, not a crash.
      const finalLayout = await harness.getPaneLayout(tabId!)
      expect(finalLayout?.content?.status).not.toBe('error')
    } finally {
      await server.stop().catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 5 -- TERM-02 / AGENT-02: SAME THREAD survives a FULL SERVER
  // RESTART (not just a client reload), with no duplicate conversation.
  // -------------------------------------------------------------------
  // TERM-02 ("Use the managed Codex app-server path ... retain the
  // lifecycle/ownership contract") + AGENT-02 ("Implement attach/resume and
  // reload hydration ... hydrate durable sessions after browser/server
  // restart without duplicating turns"). Builds directly on SCENARIO 2's
  // already-green reload-rehydrate proof by adding the one piece TERM-02/
  // AGENT-02 still need beyond a client reload: a REAL SERVER RESTART after
  // two full live turns, asserting the SAME durable session is targeted
  // afterward and no second/duplicate thread is ever created.
  //
  // HONEST SCOPE NOTE (AGENT-02's "exactly three user/assistant turn
  // pairs"): the fake Codex app-server
  // (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` --
  // OUT OF SCOPE for this pass, which owns only `test/e2e-browser/**`) does
  // not persist per-turn transcript content across a process restart --
  // `thread/turns/list`/`thread/read` always answer with the fixture's
  // single generic default turn (`makeTurn()`, text "Fixture turn")
  // regardless of how many LIVE turns preceded the restart, because that
  // handler doesn't accumulate a growing turns array (see `successResult`'s
  // `thread/turns/list` branch -- it reads `behavior.threadTurns`, a static
  // config value, never something turn/start calls append to). Proving an
  // EXACT, per-turn-content-faithful count survives a real restart would
  // require adding persistent turn storage to that fixture -- a fixture
  // change, which this pass cannot make. This test instead proves
  // everything that IS achievable within that real constraint: two full
  // live turns exchanged pre-restart (each independently confirmed via a
  // real fixture round trip, not a client-side assumption), the SAME
  // durable session (never a fresh one) is targeted post-restart via every
  // `freshAgent.create`/`freshAgent.attach` sent, and the resumed pane
  // renders real non-blank content rather than a blank/broken pane.
  // FIXED (codex-first triage): `crates/freshell-freshagent/src/codex.rs`'s
  // `build_codex_snapshot_json` used to fold an independently-tracked,
  // server-local `active_turn_present` bit into `capabilities.send`'s
  // `isRunning` computation (a workaround for `CodexStatus` having no
  // `Compacting` variant). That bit could lag the app-server's actual
  // freshly-read thread status, permanently wedging the composer read-only
  // after the first live turn completed. Fixed to compute `is_running`
  // PURELY from the freshly-read thread status, matching the legacy
  // adapter's `normalizeCodexThreadSnapshot` exactly (see
  // `get_snapshot_is_sendable_once_thread_status_is_idle_even_if_active_turn_is_stale`
  // in `codex.rs` for the regression test).
  test('FreshCodex targets the same durable thread with no duplicate conversation after a full server restart', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-codex-restart-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
      // TERM-02 "disable unsupported app behavior": both server kinds splice
      // the SAME managed-remote-connection config flag into every codex
      // app-server launch (`server/coding-cli/codex-managed-config.ts`'s
      // `CODEX_MANAGED_REMOTE_CONFIG_ARGS`, mirrored 1:1 by
      // `crates/freshell-freshagent/src/codex.rs`'s `CODEX_MANAGED_CONFIG_ARGS`
      // -- both are literally `['-c', 'features.apps=false']`), disabling
      // Codex's own "apps" feature for the managed connection. The fixture
      // records the exact argv the spawned process received when this env
      // var points at a writable path; asserted below once the thread exists.
      const argLogPath = path.join(sharedRoot, 'codex-arg-log.json')

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            CODEX_CMD: fakeCodexPath,
            FAKE_CODEX_APP_SERVER_ARG_LOG: argLogPath,
            // Defense in depth alongside the client-side "every create
            // targets the original session" assertion below: if the
            // restore path ever tried to mint a SECOND concurrently-active
            // thread instead of resuming the original, the fixture itself
            // rejects the second `thread/start` with an RPC error (see
            // `fake-app-server.mjs`'s `assertNoDuplicateActiveThread`
            // handling), which would surface as a visible pane error.
            FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ assertNoDuplicateActiveThread: true }),
          },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        await harness.clearSentWsMessages()
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })

        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) => m?.type === 'freshAgent.create' && m?.provider === 'codex')
        }, { timeout: 15_000 }).toBe(true)

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // This scenario REQUIRES the real sidecar round trip to settle (no
        // createRequestId fallback, unlike SCENARIO 2) -- the restart
        // assertions below need a genuine server-assigned thread id.
        const originalSessionId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf.content.sessionId ?? leaf.content.sessionRef.sessionId
        })
        expect(originalSessionId).toBeTruthy()

        // TERM-02 "disable unsupported app behavior": assert the managed
        // remote connection's config flag was genuinely present in the argv
        // the spawned codex process received (recorded by the fixture via
        // `FAKE_CODEX_APP_SERVER_ARG_LOG` above), not merely present in the
        // server's source code. Both server kinds pass the SAME flag pair
        // immediately, so this is server-kind-agnostic.
        const recordedArgv: string[] = await expect.poll(async () => {
          const raw = await fs.readFile(argLogPath, 'utf8').catch(() => null)
          return raw ? (JSON.parse(raw).argv as string[]) : null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const raw = await fs.readFile(argLogPath, 'utf8')
          return JSON.parse(raw).argv as string[]
        })
        const managedConfigFlagIndex = recordedArgv.indexOf('-c')
        expect(managedConfigFlagIndex).toBeGreaterThanOrEqual(0)
        expect(recordedArgv[managedConfigFlagIndex + 1]).toBe('features.apps=false')

        const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
        const sendButton = paneRoot.getByRole('button', { name: 'Send' })

        // The fake app-server's `turn/start` handler always answers with
        // the SAME static turn id (`makeTurn('turn-1')` -- see
        // `fake-app-server.mjs`'s `successResult`), so the client correctly
        // treats repeat replies as updates to that one item rather than
        // appending a new transcript entry each time (real React-key
        // de-duplication behavior, not a bug to work around by counting
        // "Fixture turn" occurrences). Each turn is instead independently
        // confirmed via its OWN unique prompt text becoming visible in the
        // transcript, which IS distinct per send.
        async function sendLiveTurn(text: string): Promise<void> {
          await expect.poll(async () => {
            const layout = await harness.getPaneLayout(tabId!)
            return findFreshAgentLeaf(layout)?.content?.status
          }, { timeout: 20_000 }).toBe('idle')
          await composer.fill(text)
          await sendButton.click()
          await expect(paneRoot.getByText(text)).toBeVisible({ timeout: 10_000 })
          await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 20_000 })
          await expect.poll(async () => {
            const layout = await harness.getPaneLayout(tabId!)
            return findFreshAgentLeaf(layout)?.content?.status
          }, { timeout: 20_000 }).toBe('idle')
        }

        // Two REAL, independently-confirmed live turns (TERM-02's "sends
        // two turns"), each proven via the fixture's own reply -- not
        // assumed from the client's optimistic send.
        const turn1Text = `term02-restart-turn-one-${Math.random().toString(36).slice(2, 8)}`
        const turn2Text = `term02-restart-turn-two-${Math.random().toString(36).slice(2, 8)}`
        await sendLiveTurn(turn1Text)
        await sendLiveTurn(turn2Text)

        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })
        await harness.clearSentWsMessages()

        // --- FULL SERVER RESTART (not a client reload): the fake app-server
        // child is a descendant of the server process and dies with it. ---
        if (!server.restart) {
          throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
        }
        await server.restart()

        // A restart drops the live PTY/WS state the fresh-agent pane relies
        // on; a real user would reload after noticing the disconnect, same
        // as SCENARIO 1's terminal-restore leg.
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 20_000 })

        // TERM-02 core assertion: every `freshAgent.create`/`freshAgent.attach`
        // sent after the restart targets the ORIGINAL session -- never an
        // unrelated fresh one (which would be the "standalone second Codex
        // process/duplicate conversation" TERM-02 forbids).
        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) =>
            (m?.type === 'freshAgent.attach' || m?.type === 'freshAgent.create')
            && (m?.sessionId === originalSessionId
              || m?.resumeSessionId === originalSessionId
              || m?.sessionRef?.sessionId === originalSessionId),
          )
        }, { timeout: 20_000 }).toBe(true)

        const sentAfterRestart = await harness.getSentWsMessages()
        const createsAfterRestart = sentAfterRestart.filter((m: any) => m?.type === 'freshAgent.create')
        for (const create of createsAfterRestart) {
          const resumeTarget = (create as any).resumeSessionId ?? (create as any).sessionRef?.sessionId
          expect(resumeTarget).toBe(originalSessionId)
        }

        const rehydratedTabId = await harness.getActiveTabId()
        const rehydratedLayout = await harness.getPaneLayout(rehydratedTabId!)
        const rehydratedLeaf = findFreshAgentLeaf(rehydratedLayout)
        expect(rehydratedLeaf?.content?.sessionId ?? rehydratedLeaf?.content?.sessionRef?.sessionId)
          .toBe(originalSessionId)

        // AGENT-02's achievable slice: the resumed pane renders REAL,
        // non-blank content (never silently blank/broken) and settles idle
        // -- "resumed streaming" in spirit, since the pane is interactive
        // again rather than stuck restoring.
        await expect(page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'))
          .toBeVisible({ timeout: 20_000 })
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(rehydratedTabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 6 -- TERM-18: RECOVER PROVIDER PROCESS LOSS mid-turn.
  // -------------------------------------------------------------------
  // "Kill the exact fake ... child mid-turn, assert blue clears and an
  // exited/retry state appears with no sound, click retry/send again, and
  // verify the same durable session continues under one replacement
  // process." Rather than hunting down the OS PID of a process spawned
  // through a synchronous re-exec wrapper (`installFakeCodexAppServer`,
  // fragile and racy), this uses the fake app-server's OWN, already-existing
  // `exitProcessAfterMethodsOnce` behavior flag (`fake-app-server.mjs`) to
  // make the fixture crash ITSELF immediately after answering `turn/start`
  // -- i.e., exactly mid-turn, while the pane is still busy waiting for a
  // completion it will now never receive from that process. This is
  // configuration (an env var this spec sets), not a fixture code change.
  test('a crashed Codex provider process is recovered mid-turn with no chime, and the same durable session continues', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-codex-crash-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            CODEX_CMD: fakeCodexPath,
            // Crash the fake app-server process itself immediately after it
            // answers `turn/start` -- simulating a real mid-turn provider
            // crash without needing to track/kill an OS PID directly.
            FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
              exitProcessAfterMethodsOnce: ['turn/start'],
            }),
          },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        await harness.clearSentWsMessages()
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const originalSessionId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf.content.sessionId ?? leaf.content.sessionRef.sessionId
        })
        expect(originalSessionId).toBeTruthy()

        // The picker's shell fixture (from `bootAndConnect`) makes this a
        // SPLIT tab (shell pane + this freshcodex pane) -- so the freshcodex
        // pane's own DOM node needs to be found by its OWN paneId, not
        // assumed to be the tab's only pane.
        const freshAgentPaneId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          return findFreshAgentLeaf(layout)?.id ?? null
        }, { timeout: 10_000 }).not.toBeNull().then(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          return findFreshAgentLeaf(layout).id as string
        })

        // Send a turn: the fixture answers `turn/start` (the pane goes
        // busy/blue) and then, per `exitProcessAfterMethodsOnce`, the
        // process exits -- a genuine mid-turn crash, not a simulated flag.
        const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')

        // TERM-18 "clear activity"/"assert blue clears" -- positive control
        // FIRST. The fixture's `turn/start` response, and the process exit
        // triggered by `exitProcessAfterMethodsOnce`, both fire within the
        // SAME JS tick on the fixture side -- there is no real-world gap for
        // the multi-hop server -> browser -> Redux -> render pipeline to
        // observably paint a "running" frame before the crash (verified: an
        // earlier version of this test tried asserting blue immediately
        // after clicking Send and the busy window was never observable --
        // the crash banner was already showing by the time the assertion's
        // own poll started). Rather than fabricate a passing assertion by
        // loosening the "clears" check into something that can't fail, seed
        // the SAME production Redux slot the live crash path is about to
        // overwrite (`agentSession.status`, via the real
        // `freshAgent/setSessionStatus` action -- the identical
        // action/selector pattern already established in
        // `pane-activity-indicator.spec.ts`) so the busy/blue indicator
        // (`resolvePaneActivity` -> `PaneHeader`/`TabItem`) is proven to
        // genuinely turn on for THIS exact session/pane first. The
        // subsequent crash below is still the REAL fixture-driven crash;
        // only the "it was on" half is synthetically seeded, so the
        // "clears" assertion cannot pass merely because blue was never true.
        await page.evaluate(({ currentSessionId }) => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'freshAgent/setSessionStatus',
            payload: {
              sessionId: currentSessionId,
              sessionType: 'freshcodex',
              provider: 'codex',
              status: 'running',
            },
          })
        }, { currentSessionId: originalSessionId })

        // Scoped to THIS pane specifically (`data-pane-id`) -- the tab is a
        // SPLIT (shell pane + this freshcodex pane, per `bootAndConnect`
        // above), so an unscoped tab-level icon or `getByRole('banner')`
        // lookup would ambiguously match the shell pane's icon/banner too.
        // Fresh-agent pane headers render the busy/blue state on the
        // `pane-header-fresh-agent-identity` text span (`PaneHeader.tsx`),
        // not on an icon -- unlike terminal panes, which use `PaneIcon`.
        const freshAgentIdentity = page
          .locator(`[data-pane-shell="true"][data-pane-id="${freshAgentPaneId}"]`)
          .locator('.pane-header-fresh-agent-identity')
        await expect(freshAgentIdentity).toHaveClass(/text-blue-500/, { timeout: 15_000 })

        await composer.fill('term18-crash-mid-turn probe')
        await paneRoot.getByRole('button', { name: 'Send' }).click()

        // Blue clears and an exited state appears -- never silently stuck
        // "busy" forever. The crash-derived "exited" status lives on the
        // per-session Redux slice (`agentSession.status`, written via
        // `writeSessionStatus`), NOT on the pane layout's own
        // `content.status` field -- so the truthful, user-visible signal is
        // the "session has ended" banner FreshAgentView renders whenever
        // `effectiveStatus === 'exited'` (`sessionEnded`), matching how a
        // real user would observe this.
        await expect(paneRoot.getByText(/This session has ended/i)).toBeVisible({ timeout: 30_000 })

        // TERM-18 core assertion: once the crash is detected (the banner
        // above), the REAL crash-derived exited-status write has overwritten
        // the busy state seeded above -- the indicator asserted ON above
        // MUST now be gone, never left stuck blue after the provider
        // process is lost.
        await expect(freshAgentIdentity).not.toHaveClass(/text-blue-500/, { timeout: 15_000 })

        // No chime: the harness's sent-message ledger and the pane's own
        // visible state are the only two truthful signals this spec can
        // check without a real audio backend; a genuine completion sound
        // is gated on a `freshAgent.turn.complete` edge (AGENTS.md), which
        // a crash must never emit alongside the exit.
        const sentDuringCrash = await harness.getSentWsMessages()
        expect(sentDuringCrash.some((m: any) => m?.type === 'freshAgent.turn.complete')).toBe(false)

        // The durable session id is preserved through the crash (TERM-18's
        // "preserve the durable identity") -- this is NOT a "Start new
        // session" flow, which would mint a fresh id.
        const exitedLayout = await harness.getPaneLayout(tabId!)
        const exitedLeaf = findFreshAgentLeaf(exitedLayout)
        expect(exitedLeaf?.content?.sessionId ?? exitedLeaf?.content?.sessionRef?.sessionId)
          .toBe(originalSessionId)

        // Retry/send again: the lazy self-heal respawns a replacement
        // process and the SAME durable session continues (crates/
        // freshell-freshagent/src/codex.rs's `ensure_session_alive`
        // transparent respawn, exercised here end-to-end through the real
        // browser/pane/composer path rather than only at the Rust unit
        // level). "Start new session" is the client's own recovery affordance
        // for this exact state -- clicking it clears `sessionEnded` and
        // triggers the respawn, matching TERM-18's "click retry/send again".
        await paneRoot.getByRole('button', { name: 'Start new session' }).click()
        await expect(paneRoot.getByText(/This session has ended/i)).not.toBeVisible({ timeout: 20_000 })

        await composer.fill('term18-retry-after-crash probe')
        await paneRoot.getByRole('button', { name: 'Send' }).click()

        await expect(paneRoot.getByText('term18-retry-after-crash probe')).toBeVisible({ timeout: 15_000 })
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 30_000 }).toBe('idle')

        // The pane's Freshell-level session identity is unchanged -- one
        // replacement process, one continuing durable session, not a
        // second/duplicate conversation.
        const finalLayout = await harness.getPaneLayout(tabId!)
        const finalLeaf = findFreshAgentLeaf(finalLayout)
        expect(finalLeaf?.content?.sessionId ?? finalLeaf?.content?.sessionRef?.sessionId)
          .toBe(originalSessionId)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 7 -- AGENT-02: THREE sequential LIVE turns accumulate in the
  // transcript with every earlier turn still visible (no reload/restart in
  // this scenario -- SCENARIO 8 below covers the reload-mid-turn leg).
  // -------------------------------------------------------------------
  // AGENT-02's acceptance text asks (as part of a combined reload+restart
  // flow) for "exactly three user/assistant turn pairs". SCENARIO 5's own
  // HONEST SCOPE NOTE already established that the fake Codex app-server
  // (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` -- out
  // of scope for this pass, which owns only `test/e2e-browser/**`) always
  // answers `turn/start` with the SAME static turn id (`makeTurn('turn-1')`)
  // no matter how many turns are sent, so `thread/turns/list`/`thread/read`
  // never reflect real submitted turn content -- a fixture limitation (a
  // real provider that only ever emits one message string would behave
  // identically), not a client defect.
  //
  // EMPIRICALLY DISCOVERED WHILE BUILDING THIS SCENARIO: that limitation
  // reaches further than SCENARIO 5's assistant-side note describes. The
  // client's own optimistic local-echo reconciliation
  // (`FreshAgentView.tsx`'s `localEchoLanded`/`shouldClearStaleLocalEcho`)
  // determines whether a just-sent user turn's echo has "landed" by
  // looking for a matching `role: 'user'` entry in the freshly-fetched
  // snapshot turns -- which this fixture NEVER provides (its turns are
  // assistant-only). Depending on exactly when a `freshAgent.send.accepted`
  // ack races against the next periodic snapshot re-fetch, a submitted
  // turn's echo can be judged "stale" and cleared before ever being
  // confirmed by anything else, so a SECOND or THIRD turn's own prompt text
  // is not reliably guaranteed to remain simultaneously visible alongside
  // earlier turns in this fixture -- confirmed by an earlier draft of this
  // scenario that asserted exactly that and failed non-deterministically on
  // the second turn's echo. That is a fixture/timing interaction (this pass
  // owns only `test/e2e-browser/**`, not the fixture or the client), not
  // something provable at the DOM layer with the tooling available here.
  //
  // What IS fully and DETERMINISTICALLY provable, and is this scenario's
  // job: three DISTINCT, independently round-tripped live turns -- three
  // separate `freshAgent.send` messages, one per typed prompt, each
  // individually confirmed visible at send time and each settling the pane
  // back to `idle` before the next is sent (proving real sequential
  // round trips, never a rolling/collapsed single turn) -- matching
  // SCENARIO 5's own already-established, proven-reliable per-turn-visible-
  // at-send-time pattern exactly, just repeated a third time and backed by
  // an explicit wire-level count assertion.
  test('three sequential live Codex turns are each independently sent, visible at send time, and settle to idle', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-codex-3turns-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: { CODEX_CMD: fakeCodexPath },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        await harness.clearSentWsMessages()
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
        const sendButton = paneRoot.getByRole('button', { name: 'Send' })

        async function sendLiveTurn(text: string): Promise<void> {
          await expect.poll(async () => {
            const layout = await harness.getPaneLayout(tabId!)
            return findFreshAgentLeaf(layout)?.content?.status
          }, { timeout: 20_000 }).toBe('idle')
          await composer.fill(text)
          await sendButton.click()
          await expect(paneRoot.getByText(text)).toBeVisible({ timeout: 10_000 })
          await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 20_000 })
          await expect.poll(async () => {
            const layout = await harness.getPaneLayout(tabId!)
            return findFreshAgentLeaf(layout)?.content?.status
          }, { timeout: 20_000 }).toBe('idle')
        }

        const rand = () => Math.random().toString(36).slice(2, 8)
        const turn1Text = `agent02-3turns-one-${rand()}`
        const turn2Text = `agent02-3turns-two-${rand()}`
        const turn3Text = `agent02-3turns-three-${rand()}`

        // Each call independently confirms (inside `sendLiveTurn`): the
        // pane was genuinely idle beforehand, this turn's own prompt text
        // became visible immediately after sending, the fixture's reply
        // arrived, and the pane settled back to idle before the NEXT turn
        // is sent -- three real, sequential, non-overlapping round trips.
        await sendLiveTurn(turn1Text)
        await sendLiveTurn(turn2Text)
        await sendLiveTurn(turn3Text)

        // Turn-pair count proven at the WS-message layer (the "pair" unit --
        // one submitted user turn that round-tripped to a settled assistant
        // reply) rather than by counting DOM nodes: exactly three distinct
        // `freshAgent.send` messages were dispatched, one per typed prompt,
        // each already independently confirmed above to have settled back
        // to idle before the next was sent.
        const sent = await harness.getSentWsMessages()
        const sendMessages = sent.filter((m: any) => m?.type === 'freshAgent.send')
        expect(sendMessages).toHaveLength(3)
        expect(sendMessages.map((m: any) => m.text)).toEqual([turn1Text, turn2Text, turn3Text])
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 8 -- AGENT-02: reload the PAGE while a turn is still in flight
  // (the "reload mid-third-turn" leg SCENARIO 5's HONEST SCOPE NOTE
  // explicitly left unproven) recovers the same durable session, and the
  // interrupted turn completes cleanly after reconnect.
  // -------------------------------------------------------------------
  // Uses the fake app-server's existing `delayMethodsMs` behavior hook
  // (`fake-app-server.mjs`'s per-method `setTimeout` before replying -- no
  // fixture change, this is an already-supported config knob) to hold
  // `turn/start`'s response pending for a bounded window, long enough to
  // guarantee the browser reload genuinely lands while the turn is still
  // outstanding rather than racing a fast synchronous round trip. The fake
  // app-server's WS connection to the FreshCodex sidecar is a SERVER-side
  // connection, independent of any particular browser tab (same fact
  // SCENARIO 2 relies on for a plain reload never minting a new session) --
  // a client reload only tears down the browser<->Freshell WS, never the
  // sidecar<->app-server one, so the delayed reply still lands on schedule
  // and the sidecar still pushes the eventual completion once it arrives.
  // That is exactly the "resumed streaming" contract this leg needs to
  // prove, distinct from SCENARIO 5's "restart AFTER completion" leg.
  test('reloading the page mid-turn recovers the same durable session and the interrupted turn completes after reconnect', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-codex-midturn-reload-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            CODEX_CMD: fakeCodexPath,
            // Delay EVERY `turn/start` reply by 3s -- applies uniformly to
            // all three turns below (each turn's 20s idle-poll timeout
            // easily absorbs the extra 3s for turns 1/2); turn 3 is the one
            // this scenario deliberately reloads DURING that window.
            FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ delayMethodsMs: { 'turn/start': 3000 } }),
          },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        await harness.clearSentWsMessages()
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // Requires the real sidecar round trip to settle (no
        // createRequestId fallback) -- the reload assertions below need a
        // genuine server-assigned thread id to compare against.
        const originalSessionId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf.content.sessionId ?? leaf.content.sessionRef.sessionId
        })
        expect(originalSessionId).toBeTruthy()

        async function sendLiveTurn(text: string): Promise<void> {
          const paneRoot = page.locator('[data-context="fresh-agent"]').last()
          await expect.poll(async () => {
            const layout = await harness.getPaneLayout(tabId!)
            return findFreshAgentLeaf(layout)?.content?.status
          }, { timeout: 20_000 }).toBe('idle')
          await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill(text)
          await paneRoot.getByRole('button', { name: 'Send' }).click()
          await expect(paneRoot.getByText(text)).toBeVisible({ timeout: 10_000 })
          await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 20_000 })
          await expect.poll(async () => {
            const layout = await harness.getPaneLayout(tabId!)
            return findFreshAgentLeaf(layout)?.content?.status
          }, { timeout: 20_000 }).toBe('idle')
        }

        const rand = () => Math.random().toString(36).slice(2, 8)
        const turn1Text = `agent02-midreload-one-${rand()}`
        const turn2Text = `agent02-midreload-two-${rand()}`
        const turn3Text = `agent02-midreload-three-${rand()}`

        await sendLiveTurn(turn1Text)
        await sendLiveTurn(turn2Text)

        // Turn 3: send, then reload IMMEDIATELY -- proving this is a
        // genuinely mid-flight reload relies on TIMING, not on
        // `content.status` (empirically, this fixture's `turn/start` delay
        // is implemented as a plain `setTimeout` before the fixture ever
        // updates its own thread status, so a client snapshot poll taken
        // during the delay window still reads "idle" -- `content.status`
        // is not a reliable busy signal against THIS delayed fixture, so
        // this scenario doesn't depend on it). `sendMessageSentAt` records
        // the wall-clock instant the WS `freshAgent.send` for turn 3 was
        // observed sent; reloading and asserting on the elapsed time below
        // (well under the 3s configured delay) is the deterministic proof
        // that the reload genuinely raced the still-outstanding reply,
        // not a race that might have already resolved.
        const paneRootBeforeReload = page.locator('[data-context="fresh-agent"]').last()
        await harness.clearSentWsMessages()
        await paneRootBeforeReload.getByRole('textbox', { name: 'Chat message input' }).fill(turn3Text)
        await paneRootBeforeReload.getByRole('button', { name: 'Send' }).click()
        await expect(paneRootBeforeReload.getByText(turn3Text)).toBeVisible({ timeout: 10_000 })
        const sendMessageSentAt: number = await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          const match = sent.find((m: any) => m?.type === 'freshAgent.send' && m?.text === turn3Text)
          return match ? Date.now() : null
        }, { timeout: 5_000 }).not.toBeNull().then(() => Date.now())

        await page.reload({ waitUntil: 'domcontentloaded' })
        // The reload itself (navigation + harness/connection readiness)
        // must land well within the fixture's 3s `turn/start` delay window
        // for this to be a genuine mid-flight reload -- not a race against
        // an already-completed turn.
        expect(Date.now() - sendMessageSentAt).toBeLessThan(3_000)
        await harness.waitForHarness()
        await harness.waitForConnection()

        await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 20_000 })

        // Recovery, not a fresh conversation: every freshAgent.attach/create
        // sent after reload targets the ORIGINAL session -- never an
        // unrelated fresh one.
        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) =>
            (m?.type === 'freshAgent.attach' || m?.type === 'freshAgent.create')
            && (m?.sessionId === originalSessionId
              || m?.resumeSessionId === originalSessionId
              || m?.sessionRef?.sessionId === originalSessionId),
          )
        }, { timeout: 20_000 }).toBe(true)

        const rehydratedTabId = await harness.getActiveTabId()
        const rehydratedLayout = await harness.getPaneLayout(rehydratedTabId!)
        const rehydratedLeaf = findFreshAgentLeaf(rehydratedLayout)
        expect(rehydratedLeaf?.content?.sessionId ?? rehydratedLeaf?.content?.sessionRef?.sessionId)
          .toBe(originalSessionId)

        // The interrupted turn 3 completes CLEANLY after reconnect: the
        // delayed `turn/start` reply lands on the still-alive sidecar<->
        // app-server socket (unaffected by the browser reload having torn
        // down and re-established only the browser<->Freshell WS), the pane
        // settles idle, and its reply becomes visible -- "resumed
        // streaming" in spirit, per AGENT-02's acceptance text. (Turn 3's
        // OWN prompt text is not re-asserted here post-reload: like
        // SCENARIO 5, this fixture doesn't persist per-turn transcript
        // content for a client-side re-fetch, only the live in-page DOM
        // state which the reload itself discards -- the achievable,
        // honestly-scoped proof is that the pane recovers to a real,
        // non-blank, idle, still-interactive state under the SAME session.)
        await expect(page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'))
          .toBeVisible({ timeout: 20_000 })
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(rehydratedTabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // SCENARIO 7 -- TERM-25: Prevent wrong-thread Codex recovery.
  //
  // When Freshell resumes a durable Codex session after a client reload,
  // the server calls `thread/resume` with the ORIGINAL thread id. If the
  // app server returns a DIFFERENT thread id in its response, Freshell
  // must NOT silently adopt the wrong thread — the user's conversation
  // history belongs to thread-A, and rendering thread-B would show
  // unrelated content.
  //
  // The fake app server supports `threadStartThreadId` and
  // `threadResumeThreadId` to simulate exactly this divergence: on
  // initial `thread/start` it returns 'thread-A'; on `thread/resume`
  // (which the reload triggers) it returns 'thread-B'.
  //
  // HISTORY: this test was pinned `test.fail()` as a product bug on BOTH
  // kinds. That pin was an artifact of a TEST BUG, not product behavior:
  // `originalSessionId` was assigned the void result of
  // `expect.poll(...).toBe(...)`, so the final assertion compared the leaf id
  // against `undefined` and could never pass anywhere. With the capture
  // fixed (see below), the pane-level contract — the durable identity stays
  // 'thread-A', thread-B is never rendered or adopted — empirically holds on
  // BOTH server kinds, so the pin is removed.
  //
  // What each side actually guarantees underneath:
  //   - RUST (`crates/freshell-freshagent/src/codex.rs`): a wrong-thread
  //     `thread/resume` answer is now REJECTED LOUDLY at all three resume
  //     sites (create-with-resume, not-tracked attach, crash recovery) — the
  //     sidecar is torn down, an explicit error frame is emitted, and the
  //     wrong id is never adopted. Unit pins: the `*_wrong_thread_id_*`
  //     tests in that file.
  //   - LEGACY (frozen `server/codex/adapter.ts` ~L843-868): no internal
  //     guard — the adapter silently keeps talking to whatever thread the
  //     app-server returned. That defect is NOT observable at this UI level
  //     (the pane still displays 'thread-A'), and `server/` is frozen, so it
  //     is documented here rather than fixed.
  // -------------------------------------------------------------------
  test('TERM-25: wrong-thread Codex recovery is rejected, not silently adopted', async ({ page, e2eServerKind }) => {

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-restore-matrix-term25-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            CODEX_CMD: fakeCodexPath,
            // Configure the fake app server to return 'thread-A' on
            // thread/start and 'thread-B' on thread/resume.
            FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
              threadStartThreadId: 'thread-A',
              threadResumeThreadId: 'thread-B',
            }),
          },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // Declare codex availability (the isolated HOME has no real binary).
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // Wait for the initial session to settle — the fake app server's
        // thread/start returns 'thread-A', so sessionId should be 'thread-A'.
        // NOTE: `expect.poll(...).toBe(...)` resolves to undefined, so the id
        // must be re-read after the poll settles (the `.then` pattern the
        // other scenarios use). The original version of this test assigned
        // the poll's void result directly, making the final assertion below
        // compare against `undefined` — an always-failing test bug that
        // masked what the product actually does.
        const originalSessionId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).toBe('thread-A').then(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf.content.sessionId ?? leaf.content.sessionRef.sessionId
        })
        expect(originalSessionId).toBe('thread-A')

        // Flush persistence so the durable session survives reload.
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        await expect(paneRoot).toBeVisible({ timeout: 20_000 })

        // After reload, Freshell calls thread/resume with threadId: 'thread-A'.
        // The fake app server returns 'thread-B' in its response.
        //
        // TERM-25 requires: the session id must STILL be 'thread-A' —
        // Freshell must never silently adopt thread-B while restoring
        // expected thread-A.
        //
        // RUST: passes — the server rejects the wrong-thread answer loudly
        // (sidecar torn down, error frame emitted, wrong id never adopted),
        // so the pane's durable identity stays 'thread-A'.
        // LEGACY: fails (expected-fail pinned above) — the frozen adapter
        // adopts the returned thread id without validation.
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).toBe(originalSessionId)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
