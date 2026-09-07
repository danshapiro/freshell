import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * AGENT-13 (checklist docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:353;
 * plan docs/plans/2026-09-06-ekc6.md, Task 4): e2e parity proof for the TWO
 * fresh-agent extras routes ported onto the Rust server, using the retired
 * Node router (`server/fresh-agent-extras-router.ts`, frozen legacy oracle)
 * response shapes as the contract:
 *
 *   (1) REST contract — `GET /api/fresh-agent/diff` and `POST
 *       /api/fresh-agent/exec` driven directly over fetch with the fixture
 *       token, asserting the oracle's exact statuses and error envelopes
 *       (400 `cwd query parameter required` / `cwd does not exist: <cwd>` /
 *       400 `command is required`; 500 `git diff failed: Command failed: git
 *       diff --no-color...`; 200 `{diff}` with `-one`/`+two`; 200
 *       `{output, exitCode, truncated}` incl. the 200KB `seq 1 60000`
 *       truncation leg ending in "\n[output truncated]").
 *   (2) UI — the real `FreshAgentDiffPanel` (src/components/fresh-agent/
 *       FreshAgentDiffPanel.tsx) driven in the SPA against the SAME real
 *       server: the threads snapshot is page.route-stubbed (one `diffs` row,
 *       `path: 'a.txt'`, NO title so the row aria-label is exactly
 *       `Diff: a.txt`) while `/api/fresh-agent/diff` stays UN-stubbed, so
 *       expanding the row exercises the production route end-to-end — happy
 *       leg renders the real `-one`/`+two` diff of a dirty mkdtemp repo, and
 *       the error leg (a non-repo mkdtemp cwd) must surface the 500 inline
 *       (never a perpetual spinner) with the pinned prefix.
 *
 * Rust-only: registered in RUST_ONLY_SPECS + the rust-chromium project's
 * testMatch in playwright.config.ts.
 *
 * EPHEMERAL-ONLY SAFETY: each test constructs its server DIRECTLY via `new
 * RustServer(...)` -- throwaway binary, ephemeral loopback port, mkdtemp HOME
 * (mkdtemp git repos for the diff/exec fixtures). NEVER
 * `createE2eServerHandle(process.env, ...)`: with FRESHELL_E2E_TARGET_URL set
 * it silently retargets to an already-running (possibly LIVE, port 3001)
 * server.
 */

const run = promisify(execFile)

// ---------------------------------------------------------------------------
// Helpers copied verbatim per repo convention (specs copy helpers, they do
// not import them): enableClaudeAndCodex + suppressFreshAgentNetworkForActivePane
// from test/e2e-browser/specs/fresh-agent.spec.ts:4-44, openPanePicker from
// test/e2e-browser/helpers/pane-picker.ts.
// ---------------------------------------------------------------------------

async function enableClaudeAndCodex(page: any) {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: true },
    })
    const patchPayload = {
      codingCli: {
        enabledProviders: ['claude', 'codex'],
      },
      freshAgent: {
        enabled: true,
      },
    }
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: patchPayload,
    })
  })
}

async function suppressFreshAgentNetworkForActivePane(page: any) {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (paneId) {
      harness?.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    }
  })
}

async function openPanePicker(page: Page): Promise<Locator> {
  const existingPicker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (await existingPicker.isVisible().catch(() => false)) {
    return existingPicker
  }

  const termContainer = page.locator('.xterm').first()
  if (await termContainer.isVisible().catch(() => false)) {
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  } else {
    await page.getByRole('button', { name: /add pane/i }).click()
  }

  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect(picker).toBeVisible({ timeout: 10_000 })
  return picker
}

// ---------------------------------------------------------------------------
// Spec-local fixtures
// ---------------------------------------------------------------------------

/** REST auth headers for the throwaway server (x-auth-token gate). */
function restHeaders(info: { token: string }): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/**
 * git init; commit a.txt = "one\n"; dirty it to "two\n". The identity and
 * signing-off flags are MANDATORY everywhere — never rely on ~/.gitconfig
 * (identities) or global commit.gpgsign (hermetic across hosts; delta
 * review round 2 Minor finding).
 */
async function initDirtyGitRepo(dir: string): Promise<void> {
  await run('git', ['init', '-q'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: dir })
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n')
}

async function commitAll(dir: string, message: string): Promise<void> {
  await run('git', ['add', '.'], { cwd: dir })
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', message], { cwd: dir })
}

async function connect(page: Page, info: { baseUrl: string; token: string }): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/**
 * Point the freshcodex leaf at a stubbed thread snapshot AND a chosen cwd.
 * Modeled on the finder pattern at fresh-agent.spec.ts:800-830: locate the
 * leaf in Redux (`content.kind === 'fresh-agent' &&
 * content.sessionType === 'freshcodex'`), then dispatch
 * `panes/updatePaneContent` setting sessionId AND initialCwd in the same
 * update — load-bearing ordering: the diff panel no-ops when cwd is falsy,
 * so both must be in place before the row is clicked.
 */
async function pointFreshcodexLeafAt(page: Page, sessionId: string, initialCwd: string): Promise<void> {
  await expect.poll(async () => page.evaluate(({ sid, cwd }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const findFreshcodexLeaf = (node: any): any => {
      if (!node) return null
      if (
        node.type === 'leaf'
        && node.content?.kind === 'fresh-agent'
        && node.content.sessionType === 'freshcodex'
      ) {
        return node
      }
      if (node.type === 'split') {
        return findFreshcodexLeaf(node.children?.[0]) ?? findFreshcodexLeaf(node.children?.[1])
      }
      return null
    }
    let tabId: string | null = null
    let leaf: any = null
    for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
      const candidateLeaf = findFreshcodexLeaf(layout)
      if (candidateLeaf) {
        tabId = candidateTabId
        leaf = candidateLeaf
      }
    }
    if (!tabId || !leaf) return false
    harness?.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId: leaf.id,
        content: {
          ...leaf.content,
          sessionId: sid,
          sessionRef: { provider: 'codex', sessionId: sid },
          resumeSessionId: sid,
          initialCwd: cwd,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
    return true
  }, { sid: sessionId, cwd: initialCwd }), { timeout: 10_000 }).toBe(true)
}

/**
 * Minimal but contract-valid freshcodex snapshot (FreshAgentSnapshotSchema is
 * .strict()). Shape modeled on fresh-agent.spec.ts:731-769. The `diffs` row
 * carries NO `title` so FreshAgentFileDiff labels it by `path` and the row's
 * aria-label is exactly `Diff: a.txt`. `diffId` varies per thread: the panel
 * keys rows by diff.id, so the error leg's thread switch gets a FRESH row
 * mount (collapsed, no cached diff/error) instead of reusing the happy leg's
 * expanded+loaded component instance.
 */
function stubSnapshot(threadId: string, diffId: string) {
  return {
    sessionType: 'freshcodex',
    provider: 'codex',
    threadId,
    sessionId: threadId,
    revision: 1,
    latestTurnId: `turn-${threadId}`,
    status: 'idle',
    summary: '',
    capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
    settings: { model: 'gpt-5.4-flash', permissionMode: 'on-request', effort: 'high', plugins: [] },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [{ id: diffId, path: 'a.txt', status: 'modified' }],
    turns: [
      {
        id: `turn-${threadId}`,
        turnId: `turn-${threadId}`,
        role: 'user',
        summary: 'Show the diff',
        items: [{ id: `item-${threadId}`, kind: 'text', text: 'Show the diff.' }],
      },
    ],
  }
}

test.describe('AGENT-13 fresh-agent exec/diff parity (rust-chromium)', () => {
  test.setTimeout(180_000)

  test('REST contract: /api/fresh-agent/diff and /api/fresh-agent/exec match the Node oracle', async ({ e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (also in every match-all project's testIgnore)
    // EPHEMERAL-ONLY: new RustServer(...) directly (never createE2eServerHandle).
    const server = new RustServer({ verbose: false })
    const info = await server.start()
    try {
      const diffGet = async (query: string): Promise<{ status: number; body: any }> => {
        const res = await fetch(`${info.baseUrl}/api/fresh-agent/diff${query}`, {
          headers: { 'x-auth-token': info.token },
        })
        return { status: res.status, body: await res.json().catch(() => null) }
      }
      const execPost = async (payload: unknown): Promise<{ status: number; body: any }> => {
        const res = await fetch(`${info.baseUrl}/api/fresh-agent/exec`, {
          method: 'POST',
          headers: restHeaders(info),
          body: JSON.stringify(payload),
        })
        return { status: res.status, body: await res.json().catch(() => null) }
      }

      // --- /diff validation legs (Node oracle: fresh-agent-extras-router.ts:304-321) ---

      const missingCwd = await diffGet('')
      expect(missingCwd.status, JSON.stringify(missingCwd.body)).toBe(400)
      expect(missingCwd.body?.error).toBe('cwd query parameter required')

      const nonexistent = await diffGet('?cwd=/definitely/not/a/real/dir')
      expect(nonexistent.status, JSON.stringify(nonexistent.body)).toBe(400)
      expect(nonexistent.body?.error).toBe('cwd does not exist: /definitely/not/a/real/dir')

      // Existing directory that is NOT a git repo -> 500 with the synthesized
      // Node execFile error wrapper (prefix pinned; git stderr embeds the
      // version-portable fragment "ot a git repository").
      const nonRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ekc6-nonrepo-'))
      const nonRepo = await diffGet(`?cwd=${encodeURIComponent(nonRepoDir)}`)
      expect(nonRepo.status, JSON.stringify(nonRepo.body)).toBe(500)
      expect(typeof nonRepo.body?.error).toBe('string')
      expect((nonRepo.body.error as string).startsWith('git diff failed: Command failed: git diff --no-color')).toBe(true)
      expect(nonRepo.body.error).toContain('ot a git repository')

      // --- /diff happy legs against a real dirty repo ---

      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ekc6-repo-'))
      await initDirtyGitRepo(repoDir)

      const withPath = await diffGet(`?cwd=${encodeURIComponent(repoDir)}&path=a.txt`)
      expect(withPath.status, JSON.stringify(withPath.body)).toBe(200)
      expect(withPath.body?.diff).toContain('-one')
      expect(withPath.body?.diff).toContain('+two')

      // Same repo WITHOUT the path filter: identical assertions.
      const withoutPath = await diffGet(`?cwd=${encodeURIComponent(repoDir)}`)
      expect(withoutPath.status, JSON.stringify(withoutPath.body)).toBe(200)
      expect(withoutPath.body?.diff).toContain('-one')
      expect(withoutPath.body?.diff).toContain('+two')

      // Clean repo -> byte-exact empty diff.
      await commitAll(repoDir, 'two')
      const clean = await diffGet(`?cwd=${encodeURIComponent(repoDir)}`)
      expect(clean.status, JSON.stringify(clean.body)).toBe(200)
      expect(clean.body?.diff).toBe('')

      // --- /exec legs (Node oracle: fresh-agent-extras-router.ts:289-302) ---

      const echo = await execPost({ command: 'echo hello-exec', cwd: repoDir })
      expect(echo.status, JSON.stringify(echo.body)).toBe(200)
      expect(echo.body?.output).toContain('hello-exec')
      expect(echo.body?.exitCode).toBe(0)
      expect(echo.body?.truncated).toBe(false)

      const stderrExit = await execPost({ command: 'echo to-stderr >&2; exit 3', cwd: repoDir })
      expect(stderrExit.status, JSON.stringify(stderrExit.body)).toBe(200)
      expect(stderrExit.body?.output).toContain('to-stderr')
      expect(stderrExit.body?.exitCode).toBe(3)

      // Validation order: missing command beats an (otherwise valid) cwd.
      const noCommand = await execPost({ cwd: repoDir })
      expect(noCommand.status, JSON.stringify(noCommand.body)).toBe(400)
      expect(noCommand.body?.error).toBe('command is required')

      const badCwd = await execPost({ command: 'true', cwd: '/definitely/not/a/real/dir' })
      expect(badCwd.status, JSON.stringify(badCwd.body)).toBe(400)
      expect(badCwd.body?.error).toBe('cwd does not exist: /definitely/not/a/real/dir')

      // 200KB truncation: `seq 1 60000` emits ~389KB of ASCII. Node kills the
      // child at maxBuffer (signal-kill collapses to exitCode 1); the Rust port
      // drains-and-caps and maps to the SAME observable shape.
      const truncated = await execPost({ command: 'seq 1 60000', cwd: repoDir })
      expect(truncated.status, JSON.stringify(truncated.body?.exitCode)).toBe(200)
      expect(truncated.body?.truncated).toBe(true)
      expect(truncated.body?.exitCode).toBe(1)
      expect(typeof truncated.body?.output).toBe('string')
      expect((truncated.body.output as string).endsWith('\n[output truncated]')).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test('UI: FreshAgentDiffPanel renders the real-route diff and surfaces route errors inline', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (also in every match-all project's testIgnore)
    // EPHEMERAL-ONLY: new RustServer(...) directly (never createE2eServerHandle).
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ekc6-diff-repo-'))
    await initDirtyGitRepo(repoDir)
    const nonRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ekc6-diff-nonrepo-'))

    const server = new RustServer({ verbose: false })
    const info = await server.start()
    try {
      const harness = await connect(page, info)
      await enableClaudeAndCodex(page)

      // Ensure a terminal pane exists so the pane dance can split from it.
      // Fresh e2e boots usually land on the default tab's pane picker (no
      // .xterm); mint a shell tab via REST (cwd pinned to the repo) and make
      // it active in that case.
      const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
      if (!xtermVisible) {
        const res = await fetch(`${info.baseUrl}/api/tabs`, {
          method: 'POST',
          headers: restHeaders(info),
          body: JSON.stringify({ mode: 'shell', cwd: repoDir }),
        })
        const payload = await res.json().catch(() => null)
        expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
        const tabId = payload?.data?.tabId
        if (tabId) {
          await page.evaluate((id) => {
            window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
          }, tabId)
        }
        await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      }

      // Stub ONLY the thread-snapshot read (provider traffic is suppressed
      // below, so nothing else reaches the server from the pane). The
      // snapshot announces one changed file; `/api/fresh-agent/diff` stays
      // UN-stubbed so the expanded row exercises the REAL Rust route.
      await page.route('**/api/fresh-agent/threads/freshcodex/codex/*', async (route) => {
        const url = route.request().url()
        const tail = url.split('/api/fresh-agent/threads/freshcodex/codex/')[1] ?? ''
        const threadId = decodeURIComponent(tail.split(/[/?#]/)[0] ?? '')
        const isNonRepoThread = threadId === 'ekc6-thread-nonrepo'
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(stubSnapshot(threadId || 'ekc6-thread', isNonRepoThread ? 'd2' : 'd1')),
        })
      })

      // The pane dance, modeled on fresh-agent.spec.ts:700-704. Suppress the
      // fresh-agent WS effects BEFORE the provider click so the freshcodex
      // pane's freshAgent.create never hits the wire (the real session it
      // would spawn is never needed: the stubbed snapshot IS the transcript).
      const picker = await openPanePicker(page)
      await suppressFreshAgentNetworkForActivePane(page)
      await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
      await page.getByRole('option').first().click()

      // --- Happy leg: dirty repo cwd, /diff served by the REAL Rust route. ---

      await pointFreshcodexLeafAt(page, 'ekc6-thread', repoDir)
      const diffRow = page.getByRole('button', { name: 'Diff: a.txt' })
      await expect(diffRow).toBeVisible({ timeout: 15_000 })
      await expect(diffRow).toHaveAttribute('aria-expanded', 'false')
      await diffRow.click()
      const panel = page.locator('.fresh-agent-diff-panel').first()
      await expect(panel).toContainText('-one', { timeout: 15_000 })
      await expect(panel).toContainText('+two', { timeout: 15_000 })

      // --- Error leg: re-point the same pane at a NON-repo cwd. The new
      // diffId forces a fresh row mount (collapsed, uncached); the click
      // fetches /diff against the non-repo dir -> the pinned 500 error must
      // render INLINE in the panel (never a perpetual "Loading diff...").

      await pointFreshcodexLeafAt(page, 'ekc6-thread-nonrepo', nonRepoDir)
      // The happy-leg row stays expanded under the old snapshot; the error-leg
      // row (new diff.id) mounts collapsed once its snapshot lands.
      await expect(diffRow).toHaveAttribute('aria-expanded', 'false', { timeout: 15_000 })
      await diffRow.click()
      const inlineError = page.locator('.fresh-agent-diff-panel .text-destructive').first()
      await expect(inlineError).toBeVisible({ timeout: 15_000 })
      const errorText = (await inlineError.textContent()) ?? ''
      expect(
        errorText.startsWith('git diff failed: Command failed: git diff --no-color'),
        `inline diff error should start with the pinned Node-oracle prefix; got: ${JSON.stringify(errorText)}`,
      ).toBe(true)
    } finally {
      await server.stop()
    }
  })
})
