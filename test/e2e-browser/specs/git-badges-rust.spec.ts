import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { TestServerInfo } from '../helpers/test-server.js'

/**
 * GIT BRANCH/DIRTY BADGES (Task 23, rust-only) -- e2e proof of the Rust
 * server's TerminalMetaRegistry + git enrichment (Tasks 17-18):
 *
 *  - the create-time async enrichment (`crates/freshell-ws/src/terminal.rs:1354-1369`
 *    -> `terminal_meta::enrich_from_cwd`, real `git` probes via
 *    `freshell_platform::git_meta`) fills `checkoutRoot`/`branch`/`isDirty`
 *    for a shell terminal created with a git cwd;
 *  - the `terminal.meta.updated` broadcast reaches the live SPA, whose pane
 *    header renders `basename (branch*)` (`formatPaneRuntimeLabel`,
 *    `src/lib/format-terminal-title-meta.ts:26-35`; rendered by
 *    `PaneHeader.tsx:177-184` via `PaneContainer.tsx:510-513`);
 *  - reload persistence: the WS handshake ships
 *    `terminal_meta: state.terminal_meta.list()` (`freshell-ws/src/lib.rs:413`),
 *    so a freshly-reloaded client shows the badge again without any live
 *    `terminal.meta.updated` frame.
 *
 * TWO CREATE PATHS, BOTH SEEDED (Fix round 1 closed the Task 23 gap
 * documented in `sdd/task-23-report.md`): Test 1 drives the tab through the
 * CLIENT create path (Redux `addTab` with `initialCwd` -> `TerminalView`
 * sends `terminal.create{cwd}`, `TerminalView.tsx:2783-2787` -- the WS
 * `terminal.create` handler's create-time seed, `terminal.rs`). Test 2
 * drives the brief's exact REST flow (`POST /api/tabs {cwd}`): the
 * `freshell-freshagent` spawn pipeline now fires the terminal-created hook
 * `main.rs` wires to `freshell_ws::terminal_meta::seed_from_terminal`
 * (Node `seedFromTerminal` parity, `server/index.ts:647-655` -- legacy
 * seeds off the registry's 'terminal.created' event for EVERY terminal,
 * REST creates included). Test 2 was a `test.fail()` KNOWN-GAP pin until
 * the hook landed; its flip instruction has been executed.
 *
 * PER-TEST OWNED SERVERS (auto-title-rust.spec.ts / Task 21 precedent), with
 * the badge repo seeded INSIDE each server's isolated home by `setupHome`
 * (host `git` binary, isolated dir -- never a real checkout).
 */

const BADGE_LABEL = 'badgerepo (main*)'

interface BootedServer {
  server: E2eServerHandle
  info: TestServerInfo
  repoDir: string
}

/**
 * `git init -b main` + one commit + a dirty edit inside
 * `<home>/projects/badgerepo`. Identity/signing come from `-c` flags so the
 * isolated HOME (no global gitconfig) and any host signing config are both
 * irrelevant.
 */
async function seedBadgeRepo(homeDir: string): Promise<string> {
  const repoDir = path.join(homeDir, 'projects', 'badgerepo')
  await fs.mkdir(repoDir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir })
  git('init', '-b', 'main')
  await fs.writeFile(path.join(repoDir, 'file.txt'), 'clean contents\n', 'utf8')
  git('add', '.')
  git(
    '-c', 'user.name=Freshell E2E',
    '-c', 'user.email=e2e@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'initial commit',
  )
  // Dirty it: the badge must carry the `*` suffix.
  await fs.writeFile(path.join(repoDir, 'file.txt'), 'dirty contents\n', 'utf8')
  return repoDir
}

async function bootBadgeServer(): Promise<BootedServer> {
  let repoDir = ''
  const server = await createE2eServerHandle(process.env, {
    kind: 'rust',
    construct: {
      setupHome: async (homeDir: string) => {
        repoDir = await seedBadgeRepo(homeDir)
      },
    },
  })
  const info = await server.start()
  expect(repoDir, 'setupHome must have seeded the badge repo').toBeTruthy()
  return { server, info, repoDir }
}

async function connect(page: Page, info: TestServerInfo): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

test.describe('Git branch/dirty badges (Rust only)', () => {
  test.setTimeout(150_000)

  test('pane badge shows branch + dirty star for a git cwd and survives reload', async ({ page }) => {
    const { server, info, repoDir } = await bootBadgeServer()
    try {
      const harness = await connect(page, info)

      // Create a shell tab with cwd=<home>/projects/badgerepo through the
      // client create path: Redux `addTab` + `initLayout` with a fresh
      // terminal content -- the SAME two-dispatch sequence `openSessionTab`
      // uses for a cwd-carrying terminal tab (tabsSlice.ts:787-800).
      // `normalizePaneContent` mints the `createRequestId`
      // (panesSlice.ts:78-80), so the mounted TerminalView sends
      // `terminal.create{cwd}` (TerminalView.tsx:2728,2783-2787) -> the
      // create-time meta seed + async git enrichment (Task 18).
      const tabId = 'git-badge-e2e-tab'
      await page.evaluate((args) => {
        const harnessApi = (window as any).__FRESHELL_TEST_HARNESS__
        harnessApi.dispatch({
          type: 'tabs/addTab',
          payload: { id: args.tabId, mode: 'shell', title: 'badge-tab', initialCwd: args.repo },
        })
        harnessApi.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: args.tabId,
            content: { kind: 'terminal', mode: 'shell', initialCwd: args.repo },
          },
        })
      }, { tabId, repo: repoDir })
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
      const paneShell = page.locator(`[data-context="pane"][data-tab-id="${tabId}"]`)
      await expect(paneShell.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // The pane header meta label: `basename(checkoutRoot) (branch*)` --
      // "badgerepo (main*)" (format-terminal-title-meta.ts:26-35; the dirty
      // edit in setupHome produces the `*`).
      await expect(paneShell.getByText(BADGE_LABEL, { exact: true })).toBeVisible({ timeout: 30_000 })

      // Reload: the badge must come back WITHOUT any live meta broadcast --
      // the pane rehydrates from localStorage and the meta record arrives on
      // the WS handshake's `terminal_meta` list. Flush the persist debounce
      // first (rest-tab-persistence.spec.ts pattern) so the tab itself
      // survives the reload deterministically.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      await expect(paneShell.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await expect(paneShell.getByText(BADGE_LABEL, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })

  // ---------------------------------------------------------------------
  // Fix round 1 (flip executed): the brief's exact flow -- a REST-created
  // shell tab (`POST /api/tabs {cwd}`) -- now gets a git badge. The
  // `freshell-freshagent` spawn pipeline (`spawn_terminal_pane`) fires an
  // injected terminal-created hook after every successful REST create;
  // `crates/freshell-server/src/main.rs` wires it to
  // `freshell_ws::terminal_meta::seed_from_terminal` -- the SAME seed ->
  // async git enrich -> `commit_if_changed` -> `terminal.meta.updated`
  // pipeline the WS `terminal.create` handler runs. Node parity:
  // legacy seeds off the registry's 'terminal.created' EVENT for EVERY
  // terminal (`server/index.ts:647-655` -> `seedFromTerminal`), REST
  // creates included. This leg was a `test.fail()` KNOWN-GAP pin until the
  // hook landed (rest-tab-persistence.spec.ts flip regime).
  // ---------------------------------------------------------------------
  test('a REST-created shell tab (POST /api/tabs {cwd}) shows a git badge (seedFromTerminal parity)', async ({ page }) => {
    const { server, info, repoDir } = await bootBadgeServer()
    try {
      // Connect the browser FIRST: the `ui.command{tab.create}` broadcast is
      // the ONLY way a REST-created tab materializes in the SPA (no
      // list-current-tabs fetch backs this path --
      // rest-tab-persistence.spec.ts:146-155).
      await connect(page, info)

      const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
        headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        data: { cwd: repoDir, name: 'badge-rest-tab' },
      })
      expect(res.status()).toBe(200)
      const body = await res.json()
      const tabId: string = body?.data?.tabId
      expect(tabId).toBeTruthy()
      expect(body?.data?.terminalId).toBeTruthy()

      // The tab materializes (this part works)...
      const tabStrip = page.locator('[data-testid="tab-strip"]')
      await expect(tabStrip.getByText('badge-rest-tab', { exact: true })).toBeVisible({ timeout: 15_000 })
      const paneShell = page.locator(`[data-context="pane"][data-tab-id="${tabId}"]`)
      await expect(paneShell.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // REST-created terminals are now seeded via the FreshAgentState
      // post-create hook (Task 23 fix). This assertion pins that parity:
      // badges must appear for REST-created terminals just as they do
      // for terminal-create sessions.
      await expect(paneShell.getByText(BADGE_LABEL, { exact: true })).toBeVisible({ timeout: 20_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
