import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { McpStdioClient, ensureMcpServerBuilt, REPO_ROOT } from '../helpers/mcp-stdio-client.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { claudeSimulatorServerEnv } from '../helpers/claude-sim-lane.js'

/**
 * MCP bridge pin -- Slice 2 of the agent-API + MCP parity spec
 * (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a76 "QA-Lever Design",
 * \u00a78.3 "One MCP smoke").
 *
 * Proves the standalone Node MCP stdio client (`tools/freshell-mcp/`, consumed
 * here as the freshly built `dist/tools/freshell-mcp/server.js`)
 * drives an OWNED, ephemeral Rust `freshell-server` end-to-end over its REAL
 * stdio JSON-RPC wire protocol, with ZERO Rust-side MCP code. This is the
 * "zero-Rust-MCP" QA lever the spec's \u00a76.2 describes: the moment the Rust
 * server serves the REST Agent-API with the same shapes + `x-auth-token`
 * auth (Slice 1, `crates/freshell-freshagent/src/terminal_tabs.rs`), the
 * standalone Node MCP client can drive it unchanged.
 *
 * Deliberately gated to the RUST target only (see `playwright.config.ts`'s
 * `rust-chromium` project `testMatch`), not run against legacy: the legacy
 * MCP<->legacy-REST path is legacy's own already-tested path (its own test
 * suite covers it). The NEW thing this pins is RUST-SERVER REST compatibility
 * with the unmodified MCP client -- i.e. a regression in the Rust
 * `/api/tabs`, `/api/panes`, `/api/panes/:id/send-keys`,
 * `/api/panes/:id/wait-for`, or `/api/panes/:id/capture` surface that Slice 1
 * added.
 *
 * Placement rationale (`test/e2e-browser/specs/`, Playwright -- not a bare
 * Node/Vitest integration test): the only existing harness that boots an
 * OWNED, isolated, safely-torn-down Rust server (ephemeral loopback port,
 * isolated `FRESHELL_HOME`, process-group-scoped kill safety) already lives
 * here as `RustServer` (`helpers/rust-server.ts`, HARNESS-01). Duplicating
 * that ~250-line process-lifecycle harness in a second, Vitest-based location
 * would be pure duplication risk for zero benefit. This test needs NO browser
 * `page` at all -- like `agent-continuity-matrix.spec.ts`, it drives pure
 * REST (here, REST-over-MCP-over-stdio) -- so it pays none of Playwright's
 * browser-launch overhead; it only reuses the process-supervision half of
 * the harness, exactly as that spec does.
 */

test.describe('MCP bridge -- Rust QA lever pin (Slice 2)', () => {
  test.setTimeout(120_000)

  test('standalone MCP stdio client drives an ephemeral Rust server end-to-end', async () => {
    const { path: mcpBinPath, buildMs } = ensureMcpServerBuilt(REPO_ROOT)
    // eslint-disable-next-line no-console
    console.error(`[mcp-bridge-rust] pnpm run build:tools completed in ${buildMs}ms (dist/tools/freshell-mcp/server.js)`)

    const server = new RustServer({ verbose: false })
    const info = await server.start()

    // The fixture must never bind the user's live ports.
    expect(info.port).not.toBe(3001)
    expect(info.port).not.toBe(3002)

    const projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mcp-bridge-'))

    const mcp = new McpStdioClient({
      command: process.execPath, // the current node binary
      args: [mcpBinPath],
      env: {
        ...process.env,
        FRESHELL_URL: info.baseUrl,
        FRESHELL_TOKEN: info.token,
      },
    })

    try {
      await mcp.initialize()

      // -- tools/list: the single "freshell" tool is registered --
      const tools = await mcp.listTools()
      expect(tools.map((t) => t.name)).toContain('freshell')

      // -- new-tab: create a real shell pane on the Rust server --
      const newTab = await mcp.callFreshellAction('new-tab', { mode: 'shell', cwd: projectCwd })
      expect(newTab.status).toBe('ok')
      const { tabId, paneId, terminalId } = newTab.data as {
        tabId: string
        paneId: string
        terminalId: string
      }
      expect(typeof tabId).toBe('string')
      expect(tabId.length).toBeGreaterThan(0)
      expect(typeof paneId).toBe('string')
      expect(paneId.length).toBeGreaterThan(0)
      expect(typeof terminalId).toBe('string')
      expect(terminalId.length).toBeGreaterThan(0)

      // -- list-tabs: the tab just created is present --
      const listTabsAfterCreate = await mcp.callFreshellAction('list-tabs')
      expect(listTabsAfterCreate.status).toBe('ok')
      expect((listTabsAfterCreate.data.tabs as Array<{ id: string }>).some((t) => t.id === tabId)).toBe(true)

      // -- send-keys: literal bytes (echo + CR), mirroring the manually-proven smoke --
      const marker = `MCP-BRIDGE-MARKER-${randomUUID()}`
      const sendKeys = await mcp.callFreshellAction('send-keys', {
        target: paneId,
        keys: `echo ${marker}\r`,
        literal: true,
      })
      expect(sendKeys.status).toBe('ok')
      expect(sendKeys.data.terminalId).toBe(terminalId)

      // -- wait-for: block until the marker appears in the pane's scrollback --
      const waitFor = await mcp.callFreshellAction('wait-for', {
        target: paneId,
        pattern: marker,
        timeout: 20,
      })
      expect(waitFor.status).toBe('ok')
      expect(waitFor.data.matched).toBe(true)

      // -- capture-pane: the transcript contains the marker (raw text/plain, unwrapped) --
      const capture = await mcp.callFreshellAction('capture-pane', { target: paneId, S: -200 })
      expect(typeof capture).toBe('string')
      expect(capture).toContain(marker)

      // -- list-panes: our pane is present in the bare listing, correctly
      // cross-referenced to its terminal. The pinned row contract is the
      // Node-exact `{id, index, kind?, terminalId?, title?}` — deliberately
      // WITHOUT a per-row `tabId` (the df1->main sync merge adopted main's
      // evolved Node-exact listPanes row contract; see
      // docs/plans/df1-evidence/MAIN-SYNC-MERGE.md "Gate record"). The frozen
      // MCP client types the same five fields (`PaneSummary`,
      // tools/freshell-mcp/freshell-tool.ts) and never reads `tabId`. Tab membership
      // is cross-referenced the way this surface actually offers it: the
      // `?tabId=` filter, exercised via the MCP tool's `target` param below.
      const listPanes = await mcp.callFreshellAction('list-panes')
      expect(listPanes.status).toBe('ok')
      const ourPane = (
        listPanes.data.panes as Array<{ id: string; index: number; kind?: string; terminalId?: string }>
      ).find((p) => p.id === paneId)
      expect(ourPane).toBeTruthy()
      expect(ourPane?.terminalId).toBe(terminalId)
      expect(ourPane?.kind).toBe('terminal')
      expect(ourPane?.index).toBe(0)

      // -- list-panes with the tab as target: the pane<->tab membership edge --
      const tabPanes = await mcp.callFreshellAction('list-panes', { target: tabId })
      expect(tabPanes.status).toBe('ok')
      const tabPaneIds = (tabPanes.data.panes as Array<{ id: string }>).map((p) => p.id)
      expect(tabPaneIds).toContain(paneId)
    } finally {
      await mcp.close()
      await server.stop()
      await fs.rm(projectCwd, { recursive: true, force: true }).catch(() => {})
    }
  })
})

/**
 * kata b8ke Task 10: respawn/attach ownership recovery through the MCP
 * door. The two cases below prove the recovery contract end-to-end on an
 * OWNED, ephemeral Rust server with a REAL browser page:
 * 1. respawn-pane recovers a BROWSER-CREATED pane (client-minted id, alive
 *    only in the server's LayoutStore) IN PLACE after its terminal died —
 *    same paneId, new terminalId, session id UNCHANGED (resumed, never a
 *    blank session);
 * 2. an ownership conflict surfaces the coordinator's TYPED answer through
 *    the MCP door (the frozen tool surfaces the REST refusal's message —
 *    never "pane not found") and the REST body itself carries the typed
 *    owner fields (ownerKind/ownerGeneration).
 */
test.describe('MCP bridge -- b8ke Task 10 respawn/attach ownership recovery', () => {
  test.setTimeout(180_000)

  /** Flatten a pane layout tree into its leaf nodes. */
  function collectLeaves(node: any): any[] {
    if (!node) return []
    if (node.type === 'leaf') return [node]
    if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
    return []
  }

  /** Re-read the (possibly reshuffled) leaf for a given pane id. */
  async function findLeaf(harness: TestHarness, tabId: string, paneId: string): Promise<any> {
    const layout = await harness.getPaneLayout(tabId)
    return collectLeaves(layout).find((leaf) => leaf.id === paneId)
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

  /** Boot the page + harness against an owned server and return it. */
  async function bootAndConnect(
    page: import('@playwright/test').Page,
    info: { baseUrl: string; token: string },
  ): Promise<TestHarness> {
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    return harness
  }

  /** Seed `<home>/.freshell/config.json` with the given providers/freshAgent. */
  function seedConfig(input: { providers: string[]; freshAgent?: boolean }) {
    return async (homeDir: string): Promise<void> => {
      const freshellDir = path.join(homeDir, '.freshell')
      await fs.mkdir(freshellDir, { recursive: true })
      await fs.writeFile(
        path.join(freshellDir, 'config.json'),
        JSON.stringify(
          {
            version: 1,
            settings: {
              codingCli: { enabledProviders: input.providers },
              ...(input.freshAgent ? { freshAgent: { enabled: true } } : {}),
            },
          },
          null,
          2,
        ),
      )
    }
  }

  /**
   * A fake `claude` CLI for TERMINAL panes: logs every spawn's argv (one
   * JSON row per line, in spawn order), records its PID, prints a startup
   * line, stays alive until killed, and seeds a minimal claude transcript
   * for the session id it was spawned with (under the CLAUDE_HOME/HOME the
   * server handed it) so server-side resume validation — the transcript
   * locator the handoff's attach-resume consults — finds the session.
   */
  async function installFakeClaudeCli(sharedRoot: string): Promise<{
    binPath: string
    argvLog: string
    pidFile: string
  }> {
    const binDir = path.join(sharedRoot, 'bin')
    await fs.mkdir(binDir, { recursive: true })
    const binPath = path.join(binDir, 'fake-claude-cli.mjs')
    const argvLog = path.join(sharedRoot, 'claude-argv.jsonl')
    const pidFile = path.join(sharedRoot, 'claude.pid')
    const script = `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n')
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const argv = process.argv.slice(2)
const flag = argv.includes('--session-id') ? '--session-id' : (argv.includes('--resume') ? '--resume' : null)
const sid = flag ? argv[argv.indexOf(flag) + 1] : null
if (sid) {
  const claudeHome = process.env.CLAUDE_HOME || path.join(process.env.HOME || '/tmp', '.claude')
  const dir = path.join(claudeHome, 'projects', 'freshell-e2e')
  fs.mkdirSync(dir, { recursive: true })
  const transcript = path.join(dir, sid + '.jsonl')
  if (!fs.existsSync(transcript)) {
    // A recorded cwd lets Rust resume by the session UUID while the original
    // workspace still exists. Without it, Rust correctly falls back to the
    // transcript path, which the simulator treats as a distinct session id.
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'seed' },
      sessionId: sid,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    }) + '\\n')
  }
}
process.stdout.write('fake-claude ready\\r\\n')
process.stdin.resume()
`
    await fs.writeFile(binPath, script, 'utf8')
    await fs.chmod(binPath, 0o755)
    return { binPath, argvLog, pidFile }
  }

  test('respawn-pane recovers a browser-created pane in place through the coordinator', async ({ page }) => {
    const { path: mcpBinPath } = ensureMcpServerBuilt(REPO_ROOT)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mcp-respawn-'))
    const fake = await installFakeClaudeCli(sharedRoot)
    const projectCwd = path.join(sharedRoot, 'project')
    await fs.mkdir(projectCwd, { recursive: true })

    const server = new RustServer({
      env: { CLAUDE_CMD: fake.binPath },
      setupHome: seedConfig({ providers: ['claude'] }),
    })
    const info = await server.start()

    let mcp: McpStdioClient | null = null
    try {
      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      // A BROWSER-CREATED claude terminal pane: the pane id is
      // client-minted (alive only in the server's LayoutStore — never in
      // the REST surface's pane_tabs). The picker button carries the
      // manifest's label ("Claude CLI", extensions/claude-code).
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      await page
        .getByRole('combobox', { name: /Starting directory for Claude CLI/i })
        .press('Enter')

      const leaf = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const candidates = collectLeaves(layout).filter(
          (l) => l?.content?.mode === 'claude' && l?.content?.terminalId,
        )
        return candidates.length === 1 ? candidates[0] : null
      }, { timeout: 20_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return collectLeaves(layout).find((l) => l?.content?.mode === 'claude')
      })
      const paneId: string = leaf.id
      const originalTerminalId: string = leaf.content.terminalId
      expect(paneId).toBeTruthy()
      expect(originalTerminalId).toBeTruthy()

      // Fresh claude creates preallocate the session id server-side; the
      // terminal.created fold stamps pane.content.sessionRef.
      const sessionId: string = await expect.poll(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 15_000 }).not.toBeNull().then(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.sessionRef?.sessionId
      })
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i)

      // The exact id the pane was born with (the argv the fake CLI got —
      // the row lands when the child boots, so poll for it).
      await expect.poll(async () => {
        const raw = await fs.readFile(fake.argvLog, 'utf8').catch(() => '')
        return raw.trim().split('\n').filter(Boolean).length
      }, { timeout: 15_000 }).toBe(1)
      const firstSpawnArgv = (await fs.readFile(fake.argvLog, 'utf8'))
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as { pid: number; argv: string[] })
      expect(firstSpawnArgv.length).toBe(1)
      expect(firstSpawnArgv[0].argv).toContain(sessionId)

      // Kill the pane's terminal (the forced-failure analog): the CLI dies,
      // the pane STAYS in the layout (dead terminal is a UI state, not a
      // deletion) with its terminalId cleared by the exit fold.
      const cliPid = Number(await fs.readFile(fake.pidFile, 'utf8'))
      process.kill(cliPid, 'SIGTERM')
      await expect.poll(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.terminalId ?? null
      }, { timeout: 15_000 }).toBe(null)

      // The recovery: MCP respawn-pane for the SAME pane id, resuming the
      // EXACT session id.
      mcp = new McpStdioClient({
        command: process.execPath,
        args: [mcpBinPath],
        env: {
          ...process.env,
          FRESHELL_URL: info.baseUrl,
          FRESHELL_TOKEN: info.token,
        },
      })
      await mcp.initialize()
      const respawn = await mcp.callFreshellAction('respawn-pane', {
        target: paneId,
        mode: 'claude',
        cwd: projectCwd,
        sessionRef: { provider: 'claude', sessionId },
      })
      expect(respawn.status).toBe('ok')
      const newTerminalId = (respawn.data as { terminalId: string }).terminalId
      expect(typeof newTerminalId).toBe('string')
      expect(newTerminalId).not.toBe(originalTerminalId)

      // Recovered IN PLACE: the SAME pane id now carries the NEW terminal.
      await expect.poll(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.terminalId ?? null
      }, { timeout: 15_000 }).toBe(newTerminalId)

      // Session id UNCHANGED — no blank session: the respawn's spawn
      // resumed the exact id. The argv row lands when the child CLI process
      // boots (AFTER the response folds), so poll for it (bounded).
      await expect.poll(async () => {
        const raw = await fs.readFile(fake.argvLog, 'utf8').catch(() => '')
        return raw.trim().split('\n').filter(Boolean).length
      }, { timeout: 15_000 }).toBe(2)
      const spawns = (await fs.readFile(fake.argvLog, 'utf8'))
        .trim()
        .split('\n')
        .map((row) => JSON.parse(row) as { pid: number; argv: string[] })
      const respawnArgv = spawns[1].argv
      expect(respawnArgv).toContain('--resume')
      expect(respawnArgv[respawnArgv.indexOf('--resume') + 1]).toBe(sessionId)
    } finally {
      await mcp?.close()
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('ownership conflict through MCP returns typed owner info', async ({ page }) => {
    const { path: mcpBinPath } = ensureMcpServerBuilt(REPO_ROOT)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-mcp-conflict-'))
    // The terminal Claude CLI and fresh-agent Claude sidecar are separate
    // launch paths. The terminal fixture remains local to this ownership test;
    // fresh-agent recovery uses the production sidecar and CLI simulator.
    const fake = await installFakeClaudeCli(sharedRoot)
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    const server = new RustServer({
      env: {
        CLAUDE_CMD: fake.binPath,
        ...claudeSimulatorServerEnv({
          ledgerPath: path.join(sharedRoot, 'claude-sim-ledger.jsonl'),
          program: { rules: [] },
        }),
      },
      setupHome: seedConfig({ providers: ['claude'], freshAgent: true }),
    })
    const info = await server.start()

    let mcp: McpStdioClient | null = null
    try {
      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      // 1. A browser-created TERMINAL claude pane (client-minted pane id,
      //    LayoutStore-only), carrying the server-preallocated session id S.
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      const startingDirectory = page.getByRole('combobox', { name: /Starting directory for Claude CLI/i })
      await startingDirectory.fill(projectDir)
      await startingDirectory.press('Enter')

      const leaf = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const candidates = collectLeaves(layout).filter(
          (l) => l?.content?.mode === 'claude' && l?.content?.terminalId,
        )
        return candidates.length === 1 ? candidates[0] : null
      }, { timeout: 20_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return collectLeaves(layout).find((l) => l?.content?.mode === 'claude')
      })
      const paneId: string = leaf.id
      expect(paneId).toBeTruthy()
      const sessionId: string = await expect.poll(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 15_000 }).not.toBeNull().then(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.sessionRef?.sessionId
      })
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i)

      // 2. The terminal dies (pane stays, LayoutStore-resolvable).
      const cliPid = Number(await fs.readFile(fake.pidFile, 'utf8'))
      process.kill(cliPid, 'SIGTERM')
      await expect.poll(async () => {
        const l = await findLeaf(harness, tabId!, paneId)
        return l?.content?.terminalId ?? null
      }, { timeout: 15_000 }).toBe(null)

      // 3. THE b8ke feature: the atomic handoff moves (claude, S) to a live
      //    fresh-agent owner (freshclaude resuming S over the fake SDK
      //    sidecar). The endpoint's 200 awaits the handoff's completion —
      //    the coordinator holds Live{FreshAgent} on (claude, S).
      //
      //    The pane layout clears terminalId as soon as the server observes
      //    the dead peer, but the terminal lane's ownership stamp release
      //    races the client's next request: a handoff POST that lands
      //    inside that window gets the feature's own typed 409 with
      //    ownerKind "terminal" — the designed coordination signal for
      //    exactly this transient. Retry the typed terminal-owner refusal
      //    (bounded) until the release settles; every OTHER 409 shape is a
      //    real conflict and surfaces immediately.
      let handoffResp: Response | null = null
      let lastConflictSummary = 'no response'
      const handoffDeadline = Date.now() + 15_000
      for (;;) {
        const attempt = await fetch(`${info.baseUrl}/api/sessions/handoff`, {
          method: 'POST',
          headers: {
            'x-auth-token': info.token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'claude',
            sessionId,
            targetKind: 'fresh-agent',
            sessionType: 'freshclaude',
            cwd: projectDir,
          }),
        })
        if (attempt.status === 200) {
          handoffResp = attempt
          break
        }
        const body = (await attempt.json().catch(() => null)) as
          | (Record<string, unknown> & {
              ownerKind?: string
              code?: string
              error?: { ownerKind?: string; code?: string }
            })
          | null
        lastConflictSummary = JSON.stringify(body).slice(0, 300)
        const transientTerminalOwner =
          attempt.status === 409 &&
          (body?.ownerKind === 'terminal' || body?.error?.ownerKind === 'terminal')
        if (!transientTerminalOwner || Date.now() > handoffDeadline) {
          handoffResp = attempt
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(handoffResp.status, `handoff did not settle: ${lastConflictSummary}`).toBe(200)
      const handoffBody = (await handoffResp.json()) as { ok: boolean }
      expect(handoffBody.ok).toBe(true)

      // 4. The MCP door: respawn for the same sessionRef surfaces the
      //    coordinator's typed refusal (the frozen tool surfaces the REST
      //    refusal's message) — NOT "pane not found".
      mcp = new McpStdioClient({
        command: process.execPath,
        args: [mcpBinPath],
        env: {
          ...process.env,
          FRESHELL_URL: info.baseUrl,
          FRESHELL_TOKEN: info.token,
        },
      })
      await mcp.initialize()
      const result = await mcp.callFreshellAction('respawn-pane', {
        target: paneId,
        mode: 'claude',
        cwd: projectDir,
        sessionRef: { provider: 'claude', sessionId },
      })
      expect(result.error).toBeTruthy()
      expect(result.error).toContain('still running on the server')
      expect(result.error).toContain(sessionId)
      expect(result.error).not.toContain('pane not found')

      // 5. The REST body the MCP verb proxies carries the typed owner fields.
      const restResp = await fetch(
        `${info.baseUrl}/api/panes/${encodeURIComponent(paneId)}/respawn`,
        {
          method: 'POST',
          headers: {
            'x-auth-token': info.token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            mode: 'claude',
            cwd: projectDir,
            sessionRef: { provider: 'claude', sessionId },
          }),
        },
      )
      expect(restResp.status).toBe(409)
      const conflictBody = (await restResp.json()) as {
        code: string
        ownerKind: string
        ownerGeneration: number
        message: string
      }
      expect(conflictBody.code).toBe('RESTORE_UNAVAILABLE')
      expect(conflictBody.ownerKind).toBe('fresh-agent')
      expect(typeof conflictBody.ownerGeneration).toBe('number')
      expect(conflictBody.message).toContain(sessionId)
    } finally {
      await mcp?.close()
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
