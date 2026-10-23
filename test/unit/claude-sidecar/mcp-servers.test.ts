// @vitest-environment node
//
// The MCP servers a freshclaude or kilroy sidecar hands the SDK's query()
// (mcp-servers.mjs), and the pane context it adds to the CLI's environment
// (api-hosted-ops plan §2.4, G19).
//
// Two recipes exist and a session gets at most one of them:
//   - the ordinary recipe: the Freshell MCP command the server resolved for
//     this host (`create.freshellMcp`), outside a session host;
//   - the hosted recipe: the session host's fixed command, when the lane
//     selected it (`create.hostedMcp`) inside a hosted Claude runtime.
// Neither ever carries an `env` key: the SDK passes the MCP config to the CLI
// on its command line (`--mcp-config <json>`), so the endpoint and token stay
// in the inherited environment, which the MCP child receives from the CLI.

import { describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { mcpServersFor, withFreshellContext } from '../../../crates/freshell-claude-sidecar/mcp-servers.mjs'
import { startRealSidecar } from './harness'

const HOSTED_RECIPE = { freshell: { command: 'node', args: ['/opt/freshell-mcp/server.js'] } }
const ORDINARY = { command: '/usr/bin/node', args: ['--import', '/repo/tsx/loader.mjs', '/repo/tools/freshell-mcp/server.ts'] }
const hosted = (provider = 'claude') => ({ FRESHELL_HOSTED_FRESH_AGENT: provider })

/** No server config in `servers` has an `env` key. */
function expectNoEnvKey(servers: Record<string, Record<string, unknown>> | undefined) {
  for (const config of Object.values(servers ?? {})) expect(Object.keys(config)).not.toContain('env')
}

describe('mcpServersFor', () => {
  it('hands an ordinary session the Freshell MCP command the server resolved', () => {
    const servers = mcpServersFor({ freshellMcp: ORDINARY, hostedMcp: false }, {})
    expect(servers).toEqual({ freshell: ORDINARY })
    expectNoEnvKey(servers)
  })

  it('hands a hosted session that selected it the fixed hosted recipe, claude and kilroy alike', () => {
    expect(mcpServersFor({ hostedMcp: true }, hosted('claude'))).toEqual(HOSTED_RECIPE)
    expect(mcpServersFor({ hostedMcp: true }, hosted('kilroy'))).toEqual(HOSTED_RECIPE)
  })

  it('hands a session that has neither recipe no MCP servers', () => {
    expect(mcpServersFor({}, {})).toBeUndefined()
    expect(mcpServersFor({ hostedMcp: false, freshellMcp: null }, {})).toBeUndefined()
    // The hosted selection means nothing outside a session host.
    expect(mcpServersFor({ hostedMcp: true }, {})).toBeUndefined()
    // A hosted sidecar whose lane did not select the hosted recipe gets none.
    expect(mcpServersFor({ hostedMcp: false }, hosted())).toBeUndefined()
  })

  it('never hands a hosted sidecar the ordinary recipe: the hosted one wins, and alone it is ignored', () => {
    const both = mcpServersFor({ hostedMcp: true, freshellMcp: ORDINARY }, hosted())
    expect(both).toEqual(HOSTED_RECIPE)
    expect(mcpServersFor({ hostedMcp: false, freshellMcp: ORDINARY }, hosted())).toBeUndefined()
  })

  it('never puts an env key in a recipe, even when the request carries one', () => {
    const servers = mcpServersFor({ freshellMcp: { ...ORDINARY, env: { FRESHELL_TOKEN: 'secret' } } }, {})
    expect(servers).toEqual({ freshell: ORDINARY })
    expectNoEnvKey(servers)
    expectNoEnvKey(mcpServersFor({ hostedMcp: true }, hosted()))
  })

  it('ignores a malformed ordinary recipe instead of handing the CLI a broken server', () => {
    for (const freshellMcp of [
      { args: [] },
      { command: '', args: [] },
      { command: 'node', args: 'server.js' },
      { command: 'node', args: ['server.js', 7] },
      'node server.js',
    ]) {
      expect(mcpServersFor({ freshellMcp }, {}), JSON.stringify(freshellMcp)).toBeUndefined()
    }
  })
})

describe('withFreshellContext', () => {
  it('adds the pane the session runs for, and only that pane, to the environment', () => {
    const inherited = { PATH: '/bin', FRESHELL_URL: 'http://localhost:9', FRESHELL_TAB_ID: 'other-tab', FRESHELL_PANE_ID: 'other-pane', FRESHELL_TERMINAL_ID: 'term-1' }
    expect(withFreshellContext(inherited, { tabId: 'tab-1', paneId: 'pane-1' })).toEqual({
      PATH: '/bin', FRESHELL_URL: 'http://localhost:9', FRESHELL_TAB_ID: 'tab-1', FRESHELL_PANE_ID: 'pane-1',
    })
    // A context without a pane id names no pane.
    expect(withFreshellContext(inherited, { tabId: 'tab-1' })).toEqual({ PATH: '/bin', FRESHELL_URL: 'http://localhost:9', FRESHELL_TAB_ID: 'tab-1' })
  })

  it('leaves the environment alone when the request carries no context (an older server)', () => {
    const inherited = { PATH: '/bin', FRESHELL_TAB_ID: 'tab-0' }
    expect(withFreshellContext(inherited, undefined)).toEqual(inherited)
    expect(withFreshellContext(inherited, null)).toEqual(inherited)
  })
})

describe('the sidecar hands query() the MCP recipe and the pane context', () => {
  it('passes an ordinary recipe without env and puts the context in the CLI environment', async () => {
    const sidecar = await startRealSidecar({
      env: { FRESHELL: '1', FRESHELL_URL: 'http://localhost:4100', FRESHELL_TOKEN: 'tok-mcp', FRESHELL_TAB_ID: 'stale-tab', FRESHELL_TERMINAL_ID: 'stale-terminal' },
    })
    await sidecar.create({ freshellMcp: ORDINARY, freshellContext: { tabId: 'tab-7', paneId: 'pane-7' } })
    const { options } = await sidecar.waitForLedger((row) => row.kind === 'query', 'the query() options')
    expect(options.mcpServers).toEqual({ freshell: ORDINARY })
    expectNoEnvKey(options.mcpServers)
    expect(options.envContext).toEqual({
      FRESHELL: '1',
      FRESHELL_URL: 'http://localhost:4100',
      FRESHELL_TAB_ID: 'tab-7',
      FRESHELL_PANE_ID: 'pane-7',
    })
    expect(options.envKeys).not.toContain('FRESHELL_TERMINAL_ID')
    expect(options.envDigests.FRESHELL_TOKEN).toMatch(/^[0-9a-f]{12}$/)
  })

  it('passes no MCP servers when the server sent no recipe', async () => {
    const sidecar = await startRealSidecar()
    await sidecar.create({ freshellMcp: null, freshellContext: null })
    const { options } = await sidecar.waitForLedger((row) => row.kind === 'query', 'the query() options')
    expect(options.mcpServers).toBeUndefined()
  })

  it('passes the fixed hosted recipe, never the ordinary one, in a hosted kilroy sidecar', async () => {
    const sidecar = await startRealSidecar({ env: hosted('kilroy') })
    await sidecar.create({ sessionType: 'kilroy', hostedMcp: true, freshellMcp: ORDINARY })
    const { options } = await sidecar.waitForLedger((row) => row.kind === 'query', 'the query() options')
    expect(options.mcpServers).toEqual(HOSTED_RECIPE)
  })
})
