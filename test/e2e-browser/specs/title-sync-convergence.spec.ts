import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

/**
 * CROSS-SURFACE TITLE CONVERGENCE (Task 21, MATRIX -- both projects).
 *
 * Pins EDEV-09 (`port/oracle/DEVIATIONS.md`): the Task 19 client
 * title-convergence fixes -- sidebar/history/terminal-menu/Overview renames
 * now mirror into pane titles via `applySessionRenameCascade`
 * (`src/store/titleSync.ts`) and `updatePaneTitleBySessionRef`
 * (`src/store/panesSlice.ts`). The client is SHARED by both backends, so this
 * spec runs on `rust-chromium` AND `legacy-chromium`; the legacy run is the
 * regression control proving the client fixes didn't regress Node behavior.
 *
 * Each test drives a REAL UI journey (or the automation REST surface, where
 * the scenario is about automation) on its OWN dedicated seeded claude
 * session, then asserts BOTH surfaces (pane header + sidebar/tab) converge.
 * Sessions are resumed by a sidebar click, spawning the fake `claude` CLI
 * (`CLAUDE_CMD` override -- restore-matrix.spec.ts precedent, works on both
 * server kinds). `GOOGLE_GENERATIVE_AI_API_KEY` is force-blanked so neither
 * server's auto-name pass can reach a real Gemini: with no key, both servers'
 * sweeps settle sessions on the first-message heuristic, and every rename
 * below writes the finalized `user` ladder rung which the sweeps never
 * clobber.
 */

const SESSION_PANE_RENAME = '00000000-0000-4000-8000-00000000c101'
const SESSION_SIDEBAR_RENAME = '00000000-0000-4000-8000-00000000c202'
const SESSION_AUTOMATION_RENAME = '00000000-0000-4000-8000-00000000c303'
const SESSION_HISTORY_RENAME = '00000000-0000-4000-8000-00000000c404'
const SESSION_OVERVIEW_RENAME = '00000000-0000-4000-8000-00000000c505'

const SEEDED_SESSIONS: Array<{ id: string; dirName: string; firstMessage: string }> = [
  { id: SESSION_PANE_RENAME, dirName: 'convergence-alpha', firstMessage: 'convergence alpha pane rename journey' },
  { id: SESSION_SIDEBAR_RENAME, dirName: 'convergence-beta', firstMessage: 'convergence beta sidebar rename journey' },
  { id: SESSION_AUTOMATION_RENAME, dirName: 'convergence-gamma', firstMessage: 'convergence gamma automation rename journey' },
  { id: SESSION_HISTORY_RENAME, dirName: 'convergence-delta', firstMessage: 'convergence delta history rename journey' },
  { id: SESSION_OVERVIEW_RENAME, dirName: 'convergence-epsilon', firstMessage: 'convergence epsilon overview rename journey' },
]

/** Same trimmed real-reader JSONL shape as auto-title-rust.spec.ts: TWO
 * user/assistant turn pairs (a single-user-message session is flagged
 * `isNonInteractive` and hidden from the directory by default,
 * `parse/claude.rs:484-488` + `session_directory.rs:1086`), and NO `summary`
 * record (so the parsed title is not provider-generated). */
function buildClaudeSessionJsonl(input: {
  sessionId: string
  cwd: string
  firstMessage: string
}): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: input.sessionId,
      uuid: `${input.sessionId}-system`,
      timestamp: '2026-08-08T08:00:00.000Z',
      cwd: input.cwd,
      git: { branch: 'main', dirty: false },
    }),
  ]
  let previousUuid = `${input.sessionId}-system`
  const userMessages = [input.firstMessage, 'Any progress on that request?']
  for (const [turnIndex, userMessage] of userMessages.entries()) {
    const userUuid = `${input.sessionId}-user-${turnIndex + 1}`
    const assistantUuid = `${input.sessionId}-assistant-${turnIndex + 1}`
    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: userMessage },
      uuid: userUuid,
      timestamp: `2026-08-08T08:0${turnIndex}:01.000Z`,
    }))
    lines.push(JSON.stringify({
      parentUuid: userUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `Working on it (${turnIndex + 1}).` }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: assistantUuid,
      timestamp: `2026-08-08T08:0${turnIndex}:02.000Z`,
    }))
    previousUuid = assistantUuid
  }
  return `${lines.join('\n')}\n`
}

async function installFakeClaudeCli(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-claude-cli.mjs')
  const script = `#!/usr/bin/env node
process.stdout.write('title-sync-convergence fake claude resumed\\r\\n')
process.stdin.resume()
`
  await fs.writeFile(dest, script, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

// Worker-scoped server (session-directory-matrix.spec.ts pattern): the fake
// claude CLI is installed BEFORE the handle is constructed so `CLAUDE_CMD`
// can point at it; the isolated home is seeded with one session per test so
// no test's rename can poison another's assertions.
const test = base.extend<Record<never, never>, { sharedRootDir: string }>({
  sharedRootDir: [async ({}, use) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-title-sync-'))
    await use(root)
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }, { scope: 'worker' }],
  testServer: [async ({ e2eServerKind, sharedRootDir }, use) => {
    const fakeClaudePath = await installFakeClaudeCli(path.join(sharedRootDir, 'bin'))
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: {
          CLAUDE_CMD: fakeClaudePath,
          // Never let a host-environment key enable either server's AI
          // branch: this spec's convergence must be deterministic (and
          // live-Gemini-free) on both kinds.
          GOOGLE_GENERATIVE_AI_API_KEY: '',
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude'] },
            },
          }, null, 2))
          for (const session of SEEDED_SESSIONS) {
            const projectDir = path.join(homeDir, 'projects', session.dirName)
            await fs.mkdir(projectDir, { recursive: true })
            const sessionDir = path.join(homeDir, '.claude', 'projects', `convergence-${session.dirName}`)
            await fs.mkdir(sessionDir, { recursive: true })
            await fs.writeFile(
              path.join(sessionDir, `${session.id}.jsonl`),
              buildClaudeSessionJsonl({
                sessionId: session.id,
                cwd: projectDir,
                firstMessage: session.firstMessage,
              }),
            )
          }
        },
      },
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],
})

function sidebarRow(page: import('@playwright/test').Page, sessionId: string) {
  return page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
}

/** The active tab's pane header -- inactive tabs' panes are hidden, so the
 * `:visible` filter selects exactly the pane under test (single-pane tabs). */
function visiblePaneHeader(page: import('@playwright/test').Page) {
  return page.locator('.pane-header:visible').first()
}

/** Sidebar-click resume of a dedicated seeded session (the WS create path,
 * which registers the terminal's session identity on both server kinds). */
async function resumeSeededSession(
  page: import('@playwright/test').Page,
  harness: import('../helpers/test-harness.js').TestHarness,
  sessionId: string,
): Promise<{ tabId: string; paneId: string; terminalId: string }> {
  await expect(page.getByTestId('sidebar-session-list')).toBeVisible({ timeout: 15_000 })
  const row = sidebarRow(page, sessionId)
  await expect(row).toBeVisible({ timeout: 15_000 })

  const tabCountBefore = await harness.getTabCount()
  await row.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })

  const tabId = (await harness.getActiveTabId())!
  expect(tabId).toBeTruthy()
  await expect.poll(async () => {
    return (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
  }, { timeout: 20_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  return { tabId, paneId: layout.id as string, terminalId: layout.content.terminalId as string }
}

test.describe('Title sync convergence', () => {
  test.setTimeout(120_000)

  // Test 1: the pane-header inline rename (dblclick + type + Enter, the same
  // interaction tab-management.spec.ts uses for tabs) PATCHes
  // /api/panes/:id; the server's syncable-terminal cascade persists the
  // session override (titleSource:'user'), and the sidebar row converges via
  // the sessions.changed refetch -- no sidebar interaction at all.
  test('pane header rename converges the sidebar', async ({ freshellPage, page, harness }) => {
    const NEW_NAME = 'Pane Rename Target One'
    await resumeSeededSession(page, harness, SESSION_PANE_RENAME)

    const header = visiblePaneHeader(page)
    await expect(header).toBeVisible({ timeout: 10_000 })
    await header.dblclick()

    const renameInput = page.getByLabel('Rename pane')
    await expect(renameInput).toBeVisible({ timeout: 5_000 })
    await renameInput.fill(NEW_NAME)
    await renameInput.press('Enter')

    // The pane header itself shows the committed rename...
    await expect(visiblePaneHeader(page)).toContainText(NEW_NAME, { timeout: 10_000 })
    // ...and the SIDEBAR row converges (cascade + refetch), zero clicks.
    await expect(sidebarRow(page, SESSION_PANE_RENAME)).toContainText(NEW_NAME, { timeout: 15_000 })
  })

  // Test 2 (pins EDEV-09): the sidebar context-menu rename
  // (`ContextMenuProvider.renameSession` -> window.prompt -> PATCH
  // /api/sessions + `applySessionRenameCascade`) must mirror into the open
  // pane's header immediately -- pre-fix, the client dropped
  // `cascadedTerminalId` and the pane kept its stale name until a sidebar
  // click.
  test('sidebar context-menu rename converges the pane header', async ({ freshellPage, page, harness }) => {
    const NEW_NAME = 'Sidebar Rename Target Two'
    await resumeSeededSession(page, harness, SESSION_SIDEBAR_RENAME)

    // `renameSession` collects the new name via window.prompt -- accept the
    // dialog with the new name (handler registered BEFORE the menu click).
    page.once('dialog', (dialog) => { void dialog.accept(NEW_NAME) })

    await sidebarRow(page, SESSION_SIDEBAR_RENAME).click({ button: 'right' })
    const renameItem = page.getByRole('menuitem', { name: 'Rename', exact: true })
    await expect(renameItem).toBeVisible({ timeout: 5_000 })
    await renameItem.click()

    // The PANE header updates with NO sidebar click needed (the EDEV-09 pin).
    await expect(visiblePaneHeader(page)).toContainText(NEW_NAME, { timeout: 10_000 })
    // And the sidebar row itself reflects it after the refetch.
    await expect(sidebarRow(page, SESSION_SIDEBAR_RENAME)).toContainText(NEW_NAME, { timeout: 15_000 })
  })

  // Test 3: the automation REST surface. PATCH /api/panes/:id renames the
  // pane in the server-side layout store, broadcasts `ui.command{pane.rename}`
  // (pane header), mirrors to the tab title (single-pane tab), and cascades
  // to the session override for a syncable coding-CLI pane (sidebar row via
  // the changed-broadcast refetch). On legacy-chromium this already works
  // (Node behavior) -- the matrix run doubles as the regression control.
  test('automation PATCH /api/panes/:id converges pane header + tab + sidebar', async ({ freshellPage, page, harness, serverInfo }) => {
    const NEW_NAME = 'Automation Name Three'
    const { tabId, paneId } = await resumeSeededSession(page, harness, SESSION_AUTOMATION_RENAME)

    // The server-side layout mirror is client-pushed (`ui.layout.sync`,
    // 200 ms trailing debounce, layoutMirrorMiddleware.ts) — until it lands,
    // BOTH servers answer a rename of the not-yet-mirrored pane with the
    // Node-parity no-op 200 `{message:'pane not found'}` (router.ts:1411 /
    // rename_pane lib.rs:1516-1521) and skip the broadcast + cascade
    // entirely. That miss is a real automation-contract outcome, not a
    // convergence failure, so arrange like a real automation client: target
    // a pane the server actually lists (GET /api/panes on both kinds).
    await expect.poll(async () => {
      const listRes = await page.request.get(`${serverInfo.baseUrl}/api/panes?tabId=${encodeURIComponent(tabId)}`, {
        headers: { 'x-auth-token': serverInfo.token },
      })
      const body = await listRes.json().catch(() => null)
      const panes = body?.data?.panes
      return Array.isArray(panes) && panes.some((p: { id?: string }) => p?.id === paneId)
    }, { timeout: 15_000 }).toBe(true)

    const res = await page.request.patch(`${serverInfo.baseUrl}/api/panes/${encodeURIComponent(paneId)}`, {
      headers: { 'x-auth-token': serverInfo.token, 'content-type': 'application/json' },
      data: { name: NEW_NAME },
    })
    expect(res.ok()).toBe(true)
    // The rename must have actually APPLIED (`data.tabId` present) — a bare
    // `res.ok()` is also true for the `{message:'pane not found'}` no-op.
    const patchBody = await res.json()
    expect(patchBody?.data?.tabId, JSON.stringify(patchBody)).toBe(tabId)

    // Pane header (ui.command pane.rename fold-in).
    await expect(visiblePaneHeader(page)).toContainText(NEW_NAME, { timeout: 10_000 })
    // Tab title (single-pane mirror).
    await expect(
      page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).getByText(NEW_NAME),
    ).toBeVisible({ timeout: 10_000 })
    // Sidebar row (syncable coding-CLI cascade + refetch).
    await expect(sidebarRow(page, SESSION_AUTOMATION_RENAME)).toContainText(NEW_NAME, { timeout: 15_000 })
  })

  // Test 4: the History (Projects) view's inline rename
  // (`HistoryView.renameSession` -> PATCH /api/sessions +
  // `applySessionRenameCascade`) converges the open pane's header.
  test('history-view rename converges the pane', async ({ freshellPage, page, harness, serverInfo }) => {
    const NEW_NAME = 'History Rename Target Four'
    await resumeSeededSession(page, harness, SESSION_HISTORY_RENAME)

    // Open the History view (nav label "Projects").
    await page.getByTitle('Projects (Ctrl+B P)').click()

    // Project groups start collapsed (`expandedProjects: new Set()`); expand
    // the one holding this test's session, then reveal the row's actions.
    const projectDir = path.join(serverInfo.homeDir, 'projects', 'convergence-delta')
    const projectHeader = page.locator(`[data-context="history-project"][data-project-path="${projectDir}"]`)
    await expect(projectHeader).toBeVisible({ timeout: 15_000 })
    await projectHeader.click()

    const row = page.locator(`[data-context="history-session"][data-session-id="${SESSION_HISTORY_RENAME}"]`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.hover()
    await row.getByLabel('Edit session').click()

    const titleInput = page.getByLabel('Session title')
    await expect(titleInput).toBeVisible({ timeout: 5_000 })
    await titleInput.fill(NEW_NAME)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // Back to the terminal view; the pane header must have converged.
    await page.getByTitle('Coding Agents (Ctrl+B T)').click()
    await expect(visiblePaneHeader(page)).toContainText(NEW_NAME, { timeout: 10_000 })
  })

  // Test 5 (pins the OverviewView fix, validator-A5): the Overview page's
  // TerminalCard inline rename routes through the shared rename helper
  // (`renameOverviewTerminal`: PATCH /api/terminals/:id + pane mirror with
  // setByUser). Pre-fix, the PATCH left paneTitles stale and the sweep was
  // structurally blind post-PATCH (registry == override -> no mismatch -> no
  // terminal.title.updated push), so the pane never converged.
  test('Overview inline rename converges pane + sidebar', async ({ freshellPage, page, harness }) => {
    const NEW_NAME = 'Overview Rename Target Five'
    const { terminalId } = await resumeSeededSession(page, harness, SESSION_OVERVIEW_RENAME)

    // Open the Overview page (nav label "Panes").
    await page.getByTitle('Panes (Ctrl+B O)').click()

    const card = page.locator(`[data-terminal-id="${terminalId}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.hover()
    await card.getByLabel('Edit terminal').click()

    const titleInput = page.getByLabel('Terminal title')
    await expect(titleInput).toBeVisible({ timeout: 5_000 })
    await titleInput.fill(NEW_NAME)
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // Back to the terminal view: the PANE header AND the sidebar row must
    // BOTH converge (the validator-A5 double assertion).
    await page.getByTitle('Coding Agents (Ctrl+B T)').click()
    await expect(visiblePaneHeader(page)).toContainText(NEW_NAME, { timeout: 10_000 })
    await expect(sidebarRow(page, SESSION_OVERVIEW_RENAME)).toContainText(NEW_NAME, { timeout: 15_000 })
  })
})
