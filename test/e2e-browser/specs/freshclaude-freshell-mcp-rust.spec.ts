// FRESHCLAUDE FRESHELL MCP -- api-hosted-ops plan §2.4 / §5.5 (audit G19):
// a freshclaude or kilroy pane's agent gets the ordinary Freshell MCP server,
// the way a terminal pane's CLI does, end to end through the real Rust
// server, the PRODUCTION Claude sidecar and the Claude CLI simulator
// (helpers/claude-sim-lane.ts). The simulator starts the stdio MCP command
// the Rust server resolved (dist/tools/freshell-mcp/server.js, built here by
// ensureMcpServerBuilt) with the environment the CLI got, the way the pinned
// CLI does (conformance scenario `mcp`), and calls its tools for the model.
//
//   1. the agent calls the Freshell MCP `list-tabs` and its reply lists the
//      open tabs: the command Rust resolved, the endpoint and the token in
//      the sidecar's environment all work against the real server;
//   2. with Settings → Advanced → "Agent MCP server" turned off, a new pane's
//      agent has no Freshell MCP server: the same call is "No such tool".
//
// CLOUD-LEGALITY: no CLI binary and no network (the simulator stands in for
// the CLI; the MCP server talks only to this test's own loopback server);
// every wait polls observed state. This spec must NOT be added to
// CLOUD_SKIP_SPECS.

import { test, expect } from '../helpers/fixtures.js'
import { ClaudeSimLane, onPrompt, type ClaudeSimLaneOptions, type ClaudeSimPane } from '../helpers/claude-sim-lane.js'
import { ensureMcpServerBuilt, REPO_ROOT } from '../helpers/mcp-stdio-client.js'

const PROMPT = 'which tabs are open?'
const REPLY_PREFIX = 'Open tabs: '
/** A tab the agent's list-tabs must find, named so its title is unmistakable. */
const PROBE_TAB = 'g19 probe tab'

/** The model calls the Freshell MCP tool's list-tabs, then repeats its answer. */
const program = {
  rules: [onPrompt(PROMPT, [
    { kind: 'tool', data: { name: 'mcp__freshell__freshell', input: { action: 'list-tabs' } } },
    { kind: 'text', data: { text: REPLY_PREFIX, echoToolResult: true } },
  ])],
}

async function withLane(
  browser: Parameters<typeof ClaudeSimLane.start>[0],
  options: ClaudeSimLaneOptions,
  body: (lane: ClaudeSimLane) => Promise<void>,
) {
  const lane = await ClaudeSimLane.start(browser, options)
  try {
    await body(lane)
  } finally {
    await lane.attachLogsOnFailure(test.info())
    await lane.stop()
  }
}

async function api(lane: ClaudeSimLane, method: 'GET' | 'POST', route: string, body?: unknown): Promise<any> {
  const response = await fetch(`${lane.info.baseUrl}${route}`, {
    method,
    headers: { 'x-auth-token': lane.info.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  expect(response.ok, `${method} ${route} answered ${response.status}`).toBe(true)
  return response.json()
}

/** The agent's reply to PROMPT in `pane`, once its turn is over. */
async function reply(lane: ClaudeSimLane, pane: ClaudeSimPane) {
  await lane.send(pane, PROMPT)
  await lane.waitForIdle(pane)
  const turn = pane.paneRoot.getByRole('article', { name: /transcript turn$/ }).filter({ hasText: REPLY_PREFIX })
  await expect(turn).toHaveCount(1, { timeout: 30_000 })
  return turn
}

/** The `query()` options the simulated CLI recorded for its sessions, in order. */
function queryOptions(lane: ClaudeSimLane): Array<Record<string, any>> {
  return lane.ledger().filter((row) => row.kind === 'query').map((row) => row.options as Record<string, any>)
}

test.describe('freshclaude Freshell MCP (production sidecar over the CLI simulator, Rust server)', () => {
  test.setTimeout(180_000)

  test.beforeAll(() => {
    // The server resolves the built MCP server (NODE_ENV=production).
    ensureMcpServerBuilt(REPO_ROOT)
  })

  for (const flavour of ['freshclaude', 'kilroy'] as const) {
    test(`${flavour}: the agent lists the open tabs through the Freshell MCP server`, async ({ browser }) => {
      await withLane(browser, { flavour, program }, async (lane) => {
        const pane = await lane.openPane()
        await api(lane, 'POST', '/api/tabs', { name: PROBE_TAB, mode: 'shell' })

        const turn = await reply(lane, pane)
        // The real server's own tab list (GET /api/tabs), read through the MCP
        // server with the endpoint and token the server gave the sidecar.
        await expect(turn).toContainText('"status": "ok"')
        await expect(turn).toContainText(PROBE_TAB)
        await expect(turn).not.toContainText('No such tool')

        // The CLI got the recipe the server resolved, never with the token in it.
        const [options] = queryOptions(lane)
        expect(options.mcpServers?.freshell?.args?.some((arg: string) => arg.endsWith('freshell-mcp/server.js'))).toBe(true)
        expect(JSON.stringify(options.mcpServers)).not.toContain(lane.info.token)
        expect(options.envContext).toMatchObject({
          FRESHELL: '1',
          FRESHELL_TAB_ID: pane.tabId,
          FRESHELL_PANE_ID: pane.paneId,
        })
      })
    })
  }

  test('freshclaude: with "Agent MCP server" turned off in Settings, a new pane\'s agent has no Freshell MCP', async ({ browser }) => {
    await withLane(browser, { flavour: 'freshclaude', program }, async (lane) => {
      const { page } = lane
      await page.getByRole('button', { name: /^Settings/ }).click()
      await page.getByRole('tab', { name: /^Advanced$/i }).click()
      const toggle = page.getByRole('switch', { name: 'Agent MCP server' })
      await expect(toggle).toBeChecked()
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await expect.poll(async () => (await api(lane, 'GET', '/api/settings')).codingCli?.mcpServer, {
        timeout: 15_000,
        message: 'the server saved the setting',
      }).toBe(false)
      await page.getByRole('button', { name: /^Coding Agents/ }).click()

      const pane = await lane.openPane()
      const turn = await reply(lane, pane)
      await expect(turn).toContainText('No such tool available: mcp__freshell__freshell')
      const [options] = queryOptions(lane)
      expect(options.mcpServers).toBeUndefined()
    })
  })
})
