import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { McpStdioClient, ensureMcpServerBuilt, REPO_ROOT } from '../helpers/mcp-stdio-client.js'

/**
 * MCP bridge pin -- Slice 2 of the agent-API + MCP parity spec
 * (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a76 "QA-Lever Design",
 * \u00a78.3 "One MCP smoke").
 *
 * Proves the legacy Node MCP stdio binary (`server/mcp/` -- FROZEN, consumed
 * here ONLY as the already-BUILT `dist/server/mcp/server.js`, never edited)
 * drives an OWNED, ephemeral Rust `freshell-server` end-to-end over its REAL
 * stdio JSON-RPC wire protocol, with ZERO Rust-side MCP code. This is the
 * "zero-Rust-MCP" QA lever the spec's \u00a76.2 describes: the moment the Rust
 * server serves the REST Agent-API with the same shapes + `x-auth-token`
 * auth (Slice 1, `crates/freshell-freshagent/src/terminal_tabs.rs`), the
 * unmodified Node MCP binary can drive it unchanged.
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

  test('unmodified legacy MCP stdio binary drives an ephemeral Rust server end-to-end', async () => {
    const { path: mcpBinPath, buildMs } = ensureMcpServerBuilt(REPO_ROOT)
    // eslint-disable-next-line no-console
    console.error(`[mcp-bridge-rust] npm run build:server completed in ${buildMs}ms (dist/server/mcp/server.js)`)

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

      // -- list-panes: our pane is present, correctly cross-referenced to tab + terminal --
      const listPanes = await mcp.callFreshellAction('list-panes')
      expect(listPanes.status).toBe('ok')
      const ourPane = (listPanes.data.panes as Array<{ id: string; tabId: string; terminalId: string }>).find(
        (p) => p.id === paneId,
      )
      expect(ourPane).toBeTruthy()
      expect(ourPane?.tabId).toBe(tabId)
      expect(ourPane?.terminalId).toBe(terminalId)
    } finally {
      await mcp.close()
      await server.stop()
      await fs.rm(projectCwd, { recursive: true, force: true }).catch(() => {})
    }
  })
})
