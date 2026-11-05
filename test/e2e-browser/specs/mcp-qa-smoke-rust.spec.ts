import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { McpStdioClient, ensureMcpServerBuilt, REPO_ROOT } from '../helpers/mcp-stdio-client.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role.js'

/**
 * `docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a76/\u00a78.3, which
 * `mcp-bridge-rust.spec.ts` pins for `mode:"shell"` only). This spec drives
 * the retained standalone Node MCP stdio binary (`dist/tools/freshell-mcp/server.js`)
 * against one owned,
 * ephemeral Rust `freshell-server`, but exercises EVERY pane mode the Rust
 * Slice-1/3a/3b REST surface now supports: shell, amplifier (fresh + resume),
 * opencode (fresh), codex (fresh + resume-via-sessionRef), browser, editor,
 * and the Slice-3b-2 pane-lifecycle routes (split/resize/swap/respawn/select/
 * has-tab/kill-pane/kill-tab). One server boot, sequential actions, and one
 * restart at the end verifies persisted tab layouts, terminal scrollback
 * teardown, and a fresh command through the same MCP process.
 *
 *
 * No browser `page` needed -- like `mcp-bridge-rust.spec.ts`, this drives pure
 * REST (over MCP-over-stdio); it reuses only the process-supervision half of
 * `RustServer` (HARNESS-01).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')
const FAKE_CODEX_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs')

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

async function readCodexRequestLines(logPath: string): Promise<Array<{ method: string; params?: { threadId?: string } }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (!raw.trim()) return []
  return raw.trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: { threadId?: string } })
}

test.describe('MCP QA smoke -- Rust full mode-matrix (QA-lever payoff)', () => {
  test.setTimeout(170_000)

  test('the retained MCP stdio binary drives an ephemeral Rust server across every pane mode', async () => {
    const { path: mcpBinPath, buildMs } = ensureMcpServerBuilt(REPO_ROOT)
    // eslint-disable-next-line no-console
    console.error(`[mcp-qa-smoke-rust] pnpm run build:tools completed in ${buildMs}ms (dist/tools/freshell-mcp/server.js)`)

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mcp-qa-smoke-'))
    const binDir = path.join(sharedRoot, 'bin')
    const amplifierArgLog = path.join(sharedRoot, 'fake-amplifier-argv.jsonl')
    const opencodeArgLog = path.join(sharedRoot, 'fake-opencode-argv.jsonl')
    const codexArgLog = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const codexRequestLog = path.join(sharedRoot, 'fake-codex-requests.jsonl')
    const codexSessionId = randomUUID()

    const [fakeAmplifierPath, fakeOpencodePath] = await Promise.all([
      installFakeCli(binDir, FAKE_AMPLIFIER_CLI_SOURCE, 'amplifier'),
      installFakeCli(binDir, FAKE_OPENCODE_TERMINAL_SOURCE, 'opencode'),
    ])
    // A Rust codex terminal starts its app-server sidecar from CODEX_CMD
    // before it starts the terminal. This shim keeps the terminal fixture for
    // the TUI path and supplies the required long-lived app-server fixture.
    const fakeCodexPath = await installDualRoleCodexCli(binDir, FAKE_CODEX_TERMINAL_SOURCE, {
      FAKE_CODEX_TERMINAL_ARGV_LOG: codexArgLog,
    })

    const server = new RustServer({
      verbose: false,
      env: {
        AMPLIFIER_CMD: fakeAmplifierPath,
        FAKE_AMPLIFIER_ARGV_LOG: amplifierArgLog,
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: opencodeArgLog,
        CODEX_CMD: fakeCodexPath,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ appendRequestLogPath: codexRequestLog }),
      },
      setupHome: async (homeDir) => {
        // An exact resume requires native evidence. A made-up sessionRef is
        // correctly refused as SESSION_MISSING; it must never start blank.
        const sessions = path.join(homeDir, '.codex', 'sessions')
        await fs.mkdir(sessions, { recursive: true })
        const records = [
          { timestamp: '2026-07-21T08:00:00.000Z', type: 'session_meta',
            payload: { id: codexSessionId, cwd: sharedRoot } },
          { timestamp: '2026-07-21T08:00:01.000Z', type: 'response_item',
            payload: { type: 'message', role: 'user',
              content: [{ type: 'input_text', text: 'MCP smoke saved conversation' }] } },
        ]
        await fs.writeFile(path.join(sessions, `${codexSessionId}.jsonl`),
          `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
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

    // IDs returned by the mode matrix; shellTabId is explicitly killed before
    // restart and must not be included in the persisted live tab set.
    const createdTabIds: string[] = []

    try {
      await mcp.initialize()

      // -----------------------------------------------------------------
      // 1. SHELL (control) -- already pinned end-to-end by
      //    `mcp-bridge-rust.spec.ts`; one quick assertion here just proves
      //    this suite's standalone MCP wiring is sound before moving to the
      //    modes that suite doesn't cover.
      // -----------------------------------------------------------------
      const shellTab = await mcp.callFreshellAction('new-tab', { mode: 'shell', cwd: sharedRoot })
      expect(shellTab.status).toBe('ok')
      const shellTabId: string = shellTab.data.tabId
      const shellPaneId: string = shellTab.data.paneId
      createdTabIds.push(shellTabId)

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
      // 2. AMPLIFIER -- create, submit, then a SEPARATE fresh `new-tab`
      //    call carrying `resume:<sessionId>` (MCP's `new-tab` derives
      //    `sessionRef:{provider:'amplifier',sessionId}` automatically for
      //    any non-codex mode -- `freshell-tool.ts`'s `new-tab` case).
      //    LAUNCHER-ASSIGNED identity: the broker mints a UUID at create,
      //    pre-creates the session stub on disk, and ALWAYS spawns
      //    `amplifier resume <uuid>` -- so even the "fresh" pane starts as
      //    a resume of its own id, and the session id is read from the
      //    resumed-session marker (there is no `session ... started` line
      //    anymore). This is a DIFFERENT code path than
      //    `amplifier-restore-rust.spec.ts` (which proves resume across a
      //    browser-driven server RESTART); this proves resume works when an
      //    external MCP agent asks for it directly on a brand-new pane.
      // -----------------------------------------------------------------
      const amplifierFresh = await mcp.callFreshellAction('new-tab', { mode: 'amplifier', cwd: sharedRoot })
      expect(amplifierFresh.status).toBe('ok')
      const amplifierFreshPaneId: string = amplifierFresh.data.paneId
      createdTabIds.push(amplifierFresh.data.tabId)

      const amplifierFreshWait = await mcp.callFreshellAction('wait-for', {
        target: amplifierFreshPaneId, pattern: 'amplifier> ', timeout: 20,
      })
      expect(amplifierFreshWait.data.matched).toBe(true)

      // The create-time resume marker carries the BROKER-MINTED UUID.
      const amplifierFreshCapture: string = await mcp.callFreshellAction('capture-pane', { target: amplifierFreshPaneId, S: -200 })
      const amplifierSessionMatch = amplifierFreshCapture.match(
        /amplifier: resumed session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      )
      expect(amplifierSessionMatch).toBeTruthy()
      const amplifierSessionId = amplifierSessionMatch![1]

      // Submit a turn: the fixture appends to the stub's events.jsonl and
      // stamps the "used" signature (turn recorded) -- this also keeps the
      // stub alive past terminal exit, which the resume below depends on.
      await mcp.callFreshellAction('send-keys', { target: amplifierFreshPaneId, keys: 'hello amplifier\r', literal: true })
      const amplifierTurnWait = await mcp.callFreshellAction('wait-for', {
        target: amplifierFreshPaneId, pattern: 'amplifier: turn recorded', timeout: 20,
      })
      expect(amplifierTurnWait.data.matched).toBe(true)

      // Release the live PTY before resuming the same id elsewhere: the
      // broker enforces a same-id double-resume guard (a session already
      // open in a live terminal is rejected). The fake CLI exits cleanly on
      // EOF (Ctrl-D) -- the exact release mechanism the fixture documents.
      // The exit lands asynchronously, so poll the resume create until the
      // guard clears instead of sleeping.
      await mcp.callFreshellAction('send-keys', { target: amplifierFreshPaneId, keys: '\u0004', literal: true })
      let amplifierResume: any = null
      await expect.poll(async () => {
        const attempt = await mcp.callFreshellAction('new-tab', {
          mode: 'amplifier', cwd: sharedRoot, resume: amplifierSessionId,
        })
        if (attempt?.status === 'ok') {
          amplifierResume = attempt
          return 'ok'
        }
        return String(attempt?.error ?? 'error')
      }, { timeout: 30_000 }).toBe('ok')
      expect(amplifierResume.status).toBe('ok')
      const amplifierResumePaneId: string = amplifierResume.data.paneId
      createdTabIds.push(amplifierResume.data.tabId)

      const amplifierResumeWait = await mcp.callFreshellAction('wait-for', {
        target: amplifierResumePaneId, pattern: 'amplifier: resumed session', timeout: 20,
      })
      expect(amplifierResumeWait.data.matched).toBe(true)
      const amplifierResumeCapture: string = await mcp.callFreshellAction('capture-pane', { target: amplifierResumePaneId, S: -200 })
      expect(amplifierResumeCapture).toContain(`amplifier: resumed session ${amplifierSessionId}`)

      // Independent, non-DOM/non-buffer proof: the fixture's own argv log.
      // At least TWO resume invocations of this id: the create-time spawn
      // and the explicit resume tab (every amplifier spawn is a resume now).
      const amplifierArgvLines = await readArgvLines(amplifierArgLog)
      const amplifierResumeInvocations = amplifierArgvLines.filter((e) => e.argv[0] === 'session' && e.argv[1] === 'resume' && e.argv[2] === '--full-history' && e.argv[3] === amplifierSessionId)
      expect(amplifierResumeInvocations.length).toBeGreaterThanOrEqual(2)

      // -----------------------------------------------------------------
      // 3. OPENCODE -- fresh launch + submit only (per this suite's scope;
      //    resume-via-MCP for opencode terminal panes follows the identical
      //    shape amplifier just proved, so is not re-proven here).
      // -----------------------------------------------------------------
      const opencodeFresh = await mcp.callFreshellAction('new-tab', { mode: 'opencode', cwd: sharedRoot })
      expect(opencodeFresh.status).toBe('ok')
      const opencodeFreshPaneId: string = opencodeFresh.data.paneId
      const opencodeTabId: string = opencodeFresh.data.tabId
      createdTabIds.push(opencodeTabId)

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
      // 4. CODEX -- fresh launch plus an exact, seeded native resume.
      //    Raw resume values are rejected locally. The managed app-server
      //    owns the resume while the terminal connects through --remote;
      //    prove the exact native identity at that protocol boundary.
      // -----------------------------------------------------------------
      const codexFresh = await mcp.callFreshellAction('new-tab', { mode: 'codex', cwd: sharedRoot })
      expect(codexFresh.status).toBe('ok')
      const codexFreshPaneId: string = codexFresh.data.paneId
      createdTabIds.push(codexFresh.data.tabId)
      const codexFreshWait = await mcp.callFreshellAction('wait-for', { target: codexFreshPaneId, pattern: 'codex> ', timeout: 20 })
      expect(codexFreshWait.data.matched).toBe(true)

      const codexResume = await mcp.callFreshellAction('new-tab', {
        mode: 'codex', cwd: sharedRoot, sessionRef: { provider: 'codex', sessionId: codexSessionId },
      })
      expect(codexResume.status, JSON.stringify(codexResume)).toBe('ok')
      const codexResumePaneId: string = codexResume.data.paneId
      createdTabIds.push(codexResume.data.tabId)

      const codexResumeWait = await mcp.callFreshellAction('wait-for', {
        target: codexResumePaneId, pattern: `codex: resumed session ${codexSessionId}`, timeout: 20,
      })
      expect(codexResumeWait.data.matched, JSON.stringify(codexResumeWait)).toBe(true)
      const codexResumeCapture: string = await mcp.callFreshellAction('capture-pane', { target: codexResumePaneId, S: -200 })
      expect(codexResumeCapture).toContain(`codex: resumed session ${codexSessionId}`)

      const codexArgvLines = await readArgvLines(codexArgLog)
      expect(codexArgvLines.some((e) => e.argv.includes('--remote'))).toBe(true)
      // The fake terminal prints its argv-derived resume marker immediately;
      // its real proxy handshake runs asynchronously. Wait for that native
      // request to reach the fake app-server before reading its request log.
      const readResumeRequestCount = async () => (await readCodexRequestLines(codexRequestLog)).filter(request => (
        request.method === 'thread/resume' && request.params?.threadId === codexSessionId
      )).length
      await expect.poll(readResumeRequestCount, {
        message: `fake Codex app-server receives thread/resume for ${codexSessionId}`,
      }).toBe(1)
      const codexRequests = await readCodexRequestLines(codexRequestLog)
      expect(codexRequests.filter(request => request.method === 'thread/resume'
        && request.params?.threadId === codexSessionId)).toHaveLength(1)

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
      createdTabIds.push(browserTabId)

      const editorFilePath = path.join(sharedRoot, 'mcp-qa-smoke-editor-target.txt')
      await fs.writeFile(editorFilePath, 'mcp qa smoke editor content\n')
      const editorTab = await mcp.callFreshellAction('new-tab', { editor: editorFilePath })
      expect(editorTab.status).toBe('ok')
      const editorTabId: string = editorTab.data.tabId
      createdTabIds.push(editorTabId)

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
      // 7. RESTART. The Rust server persists LayoutStore snapshots under the
      //    fixture HOME and flushes pending writes during graceful shutdown.
      //    The tab/pane layouts remain available, while terminal processes
      //    and their in-memory scrollback are shut down with the old server.
      //    Read the live tab list after kill-tab so the expected set excludes
      //    the shell tab explicitly closed above.
      const tabsBeforeRestart = await mcp.callFreshellAction('list-tabs')
      expect(tabsBeforeRestart.status).toBe('ok')
      const tabIdsBeforeRestart = (tabsBeforeRestart.data.tabs as Array<{ id: string }>).map((t) => t.id)
      const expectedTabIdsBeforeRestart = createdTabIds.filter((tabId) => tabId !== shellTabId)
      expect([...tabIdsBeforeRestart].sort()).toEqual([...expectedTabIdsBeforeRestart].sort())
      expect(tabIdsBeforeRestart).not.toContain(shellTabId)

      if (!server.restart) throw new Error('RustServer does not implement restart()')
      await server.restart()

      const listTabsAfterRestart = await mcp.callFreshellAction('list-tabs')
      expect(listTabsAfterRestart.status).toBe('ok')
      const postRestartTabIds = (listTabsAfterRestart.data.tabs as Array<{ id: string }>).map((t) => t.id)
      expect([...postRestartTabIds].sort()).toEqual([...tabIdsBeforeRestart].sort())
      expect(postRestartTabIds).not.toContain(shellTabId)

      // The pane layout remains, but graceful server shutdown killed its
      // terminal process; capture cannot return that process's old scrollback.
      const persistedPanes = await mcp.callFreshellAction('list-panes', { target: amplifierFresh.data.tabId })
      expect(persistedPanes.status).toBe('ok')
      expect((persistedPanes.data.panes as Array<{ id: string }>).map((pane) => pane.id))
        .toContain(amplifierFreshPaneId)
      const captureAfterRestart = await mcp.callFreshellAction('capture-pane', { target: amplifierFreshPaneId })
      expect(captureAfterRestart.error).toBeTruthy()

      // The same retained MCP process must reach the new server instance and
      // its fresh terminal registry, rather than serving cached list data.
      const postRestartShell = await mcp.callFreshellAction('new-tab', { mode: 'shell', cwd: sharedRoot })
      expect(postRestartShell.status).toBe('ok')
      expect(tabIdsBeforeRestart).not.toContain(postRestartShell.data.tabId)
      const postRestartMarker = `MCP-QA-SMOKE-RESTART-${randomUUID()}`
      const postRestartSend = await mcp.callFreshellAction('send-keys', {
        target: postRestartShell.data.paneId,
        keys: `echo ${postRestartMarker}\r`,
        literal: true,
      })
      expect(postRestartSend.status).toBe('ok')
      const postRestartWait = await mcp.callFreshellAction('wait-for', {
        target: postRestartShell.data.paneId, pattern: postRestartMarker, timeout: 20,
      })
      expect(postRestartWait.status).toBe('ok')
      expect(postRestartWait.data.matched).toBe(true)
      const postRestartCapture = await mcp.callFreshellAction('capture-pane', {
        target: postRestartShell.data.paneId, S: -200,
      })
      expect(postRestartCapture).toContain(postRestartMarker)
      const tabsAfterRestartCommand = await mcp.callFreshellAction('list-tabs')
      expect(tabsAfterRestartCommand.status).toBe('ok')
      expect((tabsAfterRestartCommand.data.tabs as Array<{ id: string }>).map((t) => t.id))
        .toContain(postRestartShell.data.tabId)
    } finally {
      await mcp.close()
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
