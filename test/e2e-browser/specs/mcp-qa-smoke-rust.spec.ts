import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { McpStdioClient, ensureMcpServerBuilt, REPO_ROOT } from '../helpers/mcp-stdio-client.js'

/**
 * MCP QA SMOKE -- the full-mode-matrix payoff of the QA lever (Slice 2 of
 * `docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a76/\u00a78.3, which
 * `mcp-bridge-rust.spec.ts` pins for `mode:"shell"` only). This spec drives
 * the SAME unmodified legacy Node MCP stdio binary (`dist/server/mcp/server.js`,
 * built from the FROZEN `server/mcp/` -- never edited) against ONE owned,
 * ephemeral Rust `freshell-server`, but exercises EVERY pane mode the Rust
 * Slice-1/3a/3b REST surface now supports: shell, amplifier (fresh + resume),
 * opencode (fresh), codex (fresh + resume-via-sessionRef), browser, editor,
 * and the Slice-3b-2 pane-lifecycle routes (split/resize/swap/respawn/select/
 * has-tab/kill-pane/kill-tab). One server boot, sequential actions, ONE
 * `server.restart()` at the very end -- see that section's comment for why
 * the post-restart assertions are deliberately negative (documenting a real
 * gap, not fabricating persistence that does not exist).
 *
 * Rust-only (gated via `playwright.config.ts`'s `rust-chromium`-only
 * `testMatch`, same as `mcp-bridge-rust.spec.ts`): the legacy MCP<->legacy-REST
 * path is legacy's own already-tested path. This pins RUST-SERVER REST
 * compatibility with the unmodified MCP client across the full mode matrix.
 *
 * No browser `page` needed -- like `mcp-bridge-rust.spec.ts`, this drives pure
 * REST (over MCP-over-stdio); it reuses only the process-supervision half of
 * `RustServer` (HARNESS-01).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')
const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')

/**
 * Install a fake CLI fixture as an executable named `execName` in a
 * throwaway bin dir -- the same copy-then-chmod pattern
 * `amplifier-restore-rust.spec.ts`'s `installFakeAmplifierCli` /
 * `opencode-terminal-restore-rust.spec.ts`'s `installFakeOpencodeTerminal` /
 * `sidebar-click-resume.spec.ts`'s codex install use, generalized to one
 * helper since this spec needs all three.
 */
async function installFakeCli(binDir: string, source: string, execName: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, execName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/** Read and JSON-parse every line of an argv log file (one JSON object per invocation). */
async function readArgvLines(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw.trim()) return []
  return raw.trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] })
}

test.describe('MCP QA smoke -- Rust full mode-matrix (QA-lever payoff)', () => {
  test.setTimeout(170_000)

  test('the unmodified legacy MCP stdio binary drives an ephemeral Rust server across every pane mode', async () => {
    const { path: mcpBinPath, buildMs } = ensureMcpServerBuilt(REPO_ROOT)
    // eslint-disable-next-line no-console
    console.error(`[mcp-qa-smoke-rust] npm run build:server completed in ${buildMs}ms (dist/server/mcp/server.js)`)

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mcp-qa-smoke-'))
    const binDir = path.join(sharedRoot, 'bin')
    const amplifierArgLog = path.join(sharedRoot, 'fake-amplifier-argv.jsonl')
    const opencodeArgLog = path.join(sharedRoot, 'fake-opencode-argv.jsonl')
    const codexArgLog = path.join(sharedRoot, 'fake-codex-argv.jsonl')

    const [fakeAmplifierPath, fakeOpencodePath, fakeCodexPath] = await Promise.all([
      installFakeCli(binDir, FAKE_AMPLIFIER_CLI_SOURCE, 'amplifier'),
      installFakeCli(binDir, FAKE_OPENCODE_TERMINAL_SOURCE, 'opencode'),
      installFakeCli(binDir, FAKE_CODEX_CLI_SOURCE, 'codex'),
    ])

    const server = new RustServer({
      verbose: false,
      env: {
        AMPLIFIER_CMD: fakeAmplifierPath,
        FAKE_AMPLIFIER_ARGV_LOG: amplifierArgLog,
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: opencodeArgLog,
        CODEX_CMD: fakeCodexPath,
        FAKE_CODEX_ARGV_LOG: codexArgLog,
      },
    })
    const info = await server.start()

    // The fixture must never bind the user's live ports.
    expect(info.port).not.toBe(3001)
    expect(info.port).not.toBe(3002)

    const mcp = new McpStdioClient({
      command: process.execPath,
      args: [mcpBinPath],
      env: {
        ...process.env,
        FRESHELL_URL: info.baseUrl,
        FRESHELL_TOKEN: info.token,
      },
    })

    // Tab ids created before the final restart -- checked for non-persistence
    // (see the "restart" section at the bottom).
    const preRestartTabIds: string[] = []

    try {
      await mcp.initialize()

      // -----------------------------------------------------------------
      // 1. SHELL (control) -- already pinned end-to-end by
      //    `mcp-bridge-rust.spec.ts`; one quick assertion here just proves
      //    this suite's OWN server/mcp wiring is sound before moving to the
      //    modes that suite doesn't cover.
      // -----------------------------------------------------------------
      const shellTab = await mcp.callFreshellAction('new-tab', { mode: 'shell', cwd: sharedRoot })
      expect(shellTab.status).toBe('ok')
      const shellTabId: string = shellTab.data.tabId
      const shellPaneId: string = shellTab.data.paneId
      preRestartTabIds.push(shellTabId)

      const shellMarker = `MCP-QA-SMOKE-SHELL-${randomUUID()}`
      const shellSend = await mcp.callFreshellAction('send-keys', {
        target: shellPaneId,
        keys: `echo ${shellMarker}\r`,
        literal: true,
      })
      expect(shellSend.status).toBe('ok')
      const shellWait = await mcp.callFreshellAction('wait-for', { target: shellPaneId, pattern: shellMarker, timeout: 20 })
      expect(shellWait.status).toBe('ok')
      expect(shellWait.data.matched).toBe(true)
      const shellCapture = await mcp.callFreshellAction('capture-pane', { target: shellPaneId, S: -200 })
      expect(shellCapture).toContain(shellMarker)

      // -----------------------------------------------------------------
      // 2. AMPLIFIER -- fresh launch, submit, then a SEPARATE fresh
      //    `new-tab` call carrying `resume:<sessionId>` (MCP's `new-tab`
      //    derives `sessionRef:{provider:'amplifier',sessionId}`
      //    automatically for any non-codex mode -- `freshell-tool.ts`'s
      //    `new-tab` case). This is a DIFFERENT code path than
      //    `amplifier-restore-rust.spec.ts` (which proves resume across a
      //    browser-driven server RESTART); this proves resume works when an
      //    external MCP agent asks for it directly on a brand-new pane.
      // -----------------------------------------------------------------
      const amplifierFresh = await mcp.callFreshellAction('new-tab', { mode: 'amplifier', cwd: sharedRoot })
      expect(amplifierFresh.status).toBe('ok')
      const amplifierFreshPaneId: string = amplifierFresh.data.paneId
      preRestartTabIds.push(amplifierFresh.data.tabId)

      const amplifierFreshWait = await mcp.callFreshellAction('wait-for', {
        target: amplifierFreshPaneId, pattern: 'amplifier> ', timeout: 20,
      })
      expect(amplifierFreshWait.data.matched).toBe(true)

      await mcp.callFreshellAction('send-keys', { target: amplifierFreshPaneId, keys: 'hello amplifier\r', literal: true })
      const amplifierSessionWait = await mcp.callFreshellAction('wait-for', {
        target: amplifierFreshPaneId, pattern: 'amplifier: session', timeout: 20,
      })
      expect(amplifierSessionWait.data.matched).toBe(true)

      const amplifierFreshCapture: string = await mcp.callFreshellAction('capture-pane', { target: amplifierFreshPaneId, S: -200 })
      const amplifierSessionMatch = amplifierFreshCapture.match(/amplifier: session (fake-amp-\S+) started/)
      expect(amplifierSessionMatch).toBeTruthy()
      const amplifierSessionId = amplifierSessionMatch![1]

      const amplifierResume = await mcp.callFreshellAction('new-tab', {
        mode: 'amplifier', cwd: sharedRoot, resume: amplifierSessionId,
      })
      expect(amplifierResume.status).toBe('ok')
      const amplifierResumePaneId: string = amplifierResume.data.paneId
      preRestartTabIds.push(amplifierResume.data.tabId)

      const amplifierResumeWait = await mcp.callFreshellAction('wait-for', {
        target: amplifierResumePaneId, pattern: 'amplifier: resumed session', timeout: 20,
      })
      expect(amplifierResumeWait.data.matched).toBe(true)
      const amplifierResumeCapture: string = await mcp.callFreshellAction('capture-pane', { target: amplifierResumePaneId, S: -200 })
      expect(amplifierResumeCapture).toContain(`amplifier: resumed session ${amplifierSessionId}`)

      // Independent, non-DOM/non-buffer proof: the fixture's own argv log.
      const amplifierArgvLines = await readArgvLines(amplifierArgLog)
      const amplifierResumeInvocations = amplifierArgvLines.filter((e) => e.argv[0] === 'resume' && e.argv[1] === amplifierSessionId)
      expect(amplifierResumeInvocations.length).toBeGreaterThan(0)

      // -----------------------------------------------------------------
      // 3. OPENCODE -- fresh launch + submit only (per this suite's scope;
      //    resume-via-MCP for opencode terminal panes follows the identical
      //    shape amplifier just proved, so is not re-proven here).
      // -----------------------------------------------------------------
      const opencodeFresh = await mcp.callFreshellAction('new-tab', { mode: 'opencode', cwd: sharedRoot })
      expect(opencodeFresh.status).toBe('ok')
      const opencodeFreshPaneId: string = opencodeFresh.data.paneId
      const opencodeTabId: string = opencodeFresh.data.tabId
      preRestartTabIds.push(opencodeTabId)

      const opencodeFreshWait = await mcp.callFreshellAction('wait-for', {
        target: opencodeFreshPaneId, pattern: 'opencode> ', timeout: 20,
      })
      expect(opencodeFreshWait.data.matched).toBe(true)

      await mcp.callFreshellAction('send-keys', { target: opencodeFreshPaneId, keys: 'hello opencode\r', literal: true })
      const opencodeSessionWait = await mcp.callFreshellAction('wait-for', {
        target: opencodeFreshPaneId, pattern: 'opencode: session', timeout: 20,
      })
      expect(opencodeSessionWait.data.matched).toBe(true)
      const opencodeCapture: string = await mcp.callFreshellAction('capture-pane', { target: opencodeFreshPaneId, S: -200 })
      expect(opencodeCapture).toMatch(/opencode: session ses_e2e_\S+ started/)

      // -----------------------------------------------------------------
      // 4. CODEX -- fresh launch, THEN resume via the `sessionRef` param
      //    directly (NOT the raw `resume` string -- `rejectRawCodexResume`
      //    in `server/mcp/freshell-tool.ts` rejects a raw codex
      //    `resume`/`resumeSessionId` with no matching `sessionRef` outright,
      //    mirrored by the Rust `requested_resume_session_id_for_mode`).
      //    The current dist MCP binary's `new-tab` DOES accept an explicit
      //    `sessionRef:{provider,sessionId}` object (`ACTION_PARAMS['new-tab']`
      //    optional list), so this is exercised for real, not skipped.
      // -----------------------------------------------------------------
      const codexFresh = await mcp.callFreshellAction('new-tab', { mode: 'codex', cwd: sharedRoot })
      expect(codexFresh.status).toBe('ok')
      const codexFreshPaneId: string = codexFresh.data.paneId
      preRestartTabIds.push(codexFresh.data.tabId)
      const codexFreshWait = await mcp.callFreshellAction('wait-for', { target: codexFreshPaneId, pattern: 'codex> ', timeout: 20 })
      expect(codexFreshWait.data.matched).toBe(true)

      const codexSessionId = `codex-thread-${randomUUID()}`
      const codexResume = await mcp.callFreshellAction('new-tab', {
        mode: 'codex', cwd: sharedRoot, sessionRef: { provider: 'codex', sessionId: codexSessionId },
      })
      expect(codexResume.status).toBe('ok')
      const codexResumePaneId: string = codexResume.data.paneId
      preRestartTabIds.push(codexResume.data.tabId)

      const codexResumeWait = await mcp.callFreshellAction('wait-for', {
        target: codexResumePaneId, pattern: 'codex: resumed session', timeout: 20,
      })
      expect(codexResumeWait.data.matched).toBe(true)
      const codexResumeCapture: string = await mcp.callFreshellAction('capture-pane', { target: codexResumePaneId, S: -200 })
      expect(codexResumeCapture).toContain(`codex: resumed session ${codexSessionId}`)

      const codexArgvLines = await readArgvLines(codexArgLog)
      const codexResumeInvocations = codexArgvLines.filter((e) => {
        const idx = e.argv.indexOf('resume')
        return idx >= 0 && e.argv[idx + 1] === codexSessionId
      })
      expect(codexResumeInvocations.length).toBeGreaterThan(0)

      // Sanity: the raw-resume rejection this test relies on for the
      // "resume via sessionRef only" design decision above is itself real,
      // not assumed -- prove a raw `resume` on `mode:"codex"` is rejected.
      const codexRawResumeReject = await mcp.callFreshellAction('new-tab', {
        mode: 'codex', cwd: sharedRoot, resume: codexSessionId,
      })
      expect(codexRawResumeReject.error).toBeTruthy()

      // -----------------------------------------------------------------
      // 5. BROWSER + EDITOR panes (the "cheap" content kinds -- no process).
      // -----------------------------------------------------------------
      const browserUrl = 'https://example.com/mcp-qa-smoke'
      const browserTab = await mcp.callFreshellAction('new-tab', { browser: browserUrl })
      expect(browserTab.status).toBe('ok')
      const browserTabId: string = browserTab.data.tabId
      const browserPaneId: string = browserTab.data.paneId
      preRestartTabIds.push(browserTabId)

      const editorFilePath = path.join(sharedRoot, 'mcp-qa-smoke-editor-target.txt')
      await fs.writeFile(editorFilePath, 'mcp qa smoke editor content\n')
      const editorTab = await mcp.callFreshellAction('new-tab', { editor: editorFilePath })
      expect(editorTab.status).toBe('ok')
      const editorTabId: string = editorTab.data.tabId
      preRestartTabIds.push(editorTabId)

      const browserPanes = await mcp.callFreshellAction('list-panes', { target: browserTabId })
      expect(browserPanes.status).toBe('ok')
      const browserPane = (browserPanes.data.panes as Array<{ id: string; kind: string }>).find((p) => p.id === browserPaneId)
      expect(browserPane?.kind).toBe('browser')

      const editorPanes = await mcp.callFreshellAction('list-panes', { target: editorTabId })
      expect(editorPanes.status).toBe('ok')
      expect((editorPanes.data.panes as Array<{ kind: string }>).some((p) => p.kind === 'editor')).toBe(true)

      // navigate: exercised against the browser pane just created (Slice 3b-2 route).
      const navigateResult = await mcp.callFreshellAction('navigate', {
        target: browserPaneId, url: 'https://example.com/mcp-qa-smoke-navigated',
      })
      expect(navigateResult.status).not.toBe('error')

      // -----------------------------------------------------------------
      // 6. PANE OPS (Slice 3b-2, `crates/freshell-freshagent/src/pane_ops.rs`)
      //    -- exercised against the shell tab from step 1, which the MCP
      //    tool exposes for every one of these actions
      //    (`ACTION_PARAMS`: split-pane, resize-pane, swap-pane,
      //    respawn-pane, select-pane, select-tab, has-tab, kill-pane,
      //    kill-tab). `attach` is skipped: it pairs a pane with a bare
      //    terminalId obtained outside this REST/MCP surface (the WS
      //    `terminal.create` path) -- out of this smoke's scope, not a gap
      //    driven by the MCP binary lacking the action.
      // -----------------------------------------------------------------
      const splitResult = await mcp.callFreshellAction('split-pane', { target: shellPaneId, mode: 'shell' })
      expect(splitResult.status).toBe('ok')
      const shellPaneId2: string = splitResult.data.paneId
      expect(shellPaneId2).toBeTruthy()

      const panesAfterSplit = await mcp.callFreshellAction('list-panes', { target: shellTabId })
      expect((panesAfterSplit.data.panes as Array<{ id: string }>).map((p) => p.id)).toEqual(
        expect.arrayContaining([shellPaneId, shellPaneId2]),
      )

      const resizeResult = await mcp.callFreshellAction('resize-pane', { target: shellPaneId, sizes: [60, 40] })
      expect(resizeResult.status).not.toBe('error')

      const swapResult = await mcp.callFreshellAction('swap-pane', { target: shellPaneId, with: shellPaneId2 })
      expect(swapResult.status).not.toBe('error')

      const respawnResult = await mcp.callFreshellAction('respawn-pane', { target: shellPaneId2, mode: 'shell' })
      expect(respawnResult.status).toBe('ok')
      expect(respawnResult.data.terminalId).toBeTruthy()

      const selectPaneResult = await mcp.callFreshellAction('select-pane', { target: shellPaneId })
      expect(selectPaneResult.status).not.toBe('error')

      const selectTabResult = await mcp.callFreshellAction('select-tab', { target: shellTabId })
      expect(selectTabResult.status).not.toBe('error')

      const hasTabResult = await mcp.callFreshellAction('has-tab', { target: shellTabId })
      expect(hasTabResult.status).toBe('ok')
      expect(hasTabResult.data.exists).toBe(true)

      const killPaneResult = await mcp.callFreshellAction('kill-pane', { target: shellPaneId2 })
      expect(killPaneResult.status).not.toBe('error')

      const panesAfterKill = await mcp.callFreshellAction('list-panes', { target: shellTabId })
      expect((panesAfterKill.data.panes as Array<{ id: string }>).some((p) => p.id === shellPaneId2)).toBe(false)

      const killTabResult = await mcp.callFreshellAction('kill-tab', { target: shellTabId })
      expect(killTabResult.status).not.toBe('error')

      const hasTabAfterKill = await mcp.callFreshellAction('has-tab', { target: shellTabId })
      expect(hasTabAfterKill.data.exists).toBe(false)

      // -----------------------------------------------------------------
      // 7. RESTART -- ONE `server.restart()` for the whole suite. The
      //    Slice-1/3a/3b agent-API registry (`FreshAgentState.tabs` /
      //    `terminal_panes` / `content_panes` / `pane_tabs`, all
      //    `Arc<Mutex<HashMap<..>>>` in `crates/freshell-freshagent/src/lib.rs`)
      //    is IN-PROCESS MEMORY ONLY -- there is no durable backing store for
      //    it (unlike the browser client's own localStorage-persisted layout,
      //    which this suite never touches since it drives pure REST/MCP with
      //    no browser). A fresh server process after `restart()` therefore
      //    starts with EMPTY maps: every tab/pane id minted above is gone,
      //    and every PTY the terminal registry owned is gone too (the Rust
      //    server's own graceful-shutdown Drop path kills them). This is the
      //    CURRENT, real, honest behavior -- not a bug this suite is
      //    pretending doesn't exist, and not persistence this suite is
      //    fabricating. It matches the MCP tool's own advertised contract
      //    (`freshell-tool.ts`'s `INSTRUCTIONS`: "Tab and pane IDs are
      //    ephemeral... If the Freshell server restarts... previously
      //    returned IDs may no longer exist").
      // -----------------------------------------------------------------
      if (!server.restart) throw new Error('RustServer does not implement restart()')
      await server.restart()

      const listTabsAfterRestart = await mcp.callFreshellAction('list-tabs')
      expect(listTabsAfterRestart.status).toBe('ok')
      const postRestartTabIds = new Set((listTabsAfterRestart.data.tabs as Array<{ id: string }>).map((t) => t.id))
      for (const tabId of preRestartTabIds) {
        expect(postRestartTabIds.has(tabId)).toBe(false)
      }

      // A stale pane id from before the restart is genuinely gone (the PTY
      // died with the old process) -- capture-pane 404s, it does not return
      // stale/blank data silently.
      const captureAfterRestart = await mcp.callFreshellAction('capture-pane', { target: amplifierFreshPaneId })
      expect(captureAfterRestart.error).toBeTruthy()
    } finally {
      await mcp.close()
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
