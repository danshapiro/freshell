// Runs only inside the owned Fresh parity enclosure. No inference requests.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const { provider, context, cwd, fixturePlugin, parityFixture } = JSON.parse(process.argv[2])
const home = '/home/freshell/provider'
const grant = JSON.parse(fs.readFileSync('/run/freshell/mcp-capability.json', 'utf8'))
// Match the host's child launch: read the private scope, then consume selected
// inputs as the provider. The scope stays in memory and child environment.
process.setgid(0)
process.setuid(65534)
const env = { ...process.env, HOME: home, CODEX_HOME: `${home}/.codex`,
  FRESHELL: '1', FRESHELL_URL: grant.endpoint, FRESHELL_TOKEN: grant.scope }

async function rpc(command, args, method, params, codex = false) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] })
  const closed = new Promise(resolve => child.once('close', resolve))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  const request = async (id, selected, input) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: selected, params: input })}\n`)
    for (;;) {
      const line = await lines.next()
      if (line.done) throw new Error(`${selected} consumer ended before its reply`)
      const response = JSON.parse(line.value)
      if (response.id !== id) continue
      if (response.error) throw new Error(`${selected} consumer rejected the request`)
      return response.result
    }
  }
  try {
    await request(1, 'initialize', codex
      ? { clientInfo: { name: 'fresh-parity', version: '1' }, capabilities: { experimentalApi: true } }
      : { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fresh-parity', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: codex ? 'initialized' : 'notifications/initialized' })}\n`)
    return await request(2, method, params)
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
    await closed
    clearTimeout(timer)
  }
}

const recipe = entry => Array.isArray(entry.command)
  ? { command: entry.command[0], args: entry.command.slice(1) }
  : { command: entry.command, args: entry.args ?? [] }
const call = async (entry, action) => {
  const selected = recipe(entry)
  const result = await rpc(selected.command, selected.args, 'tools/call', action)
  if (result.isError) throw new Error('configured MCP operation failed')
  return JSON.parse(result.content[0].text)
}
const files = [...new Set([
  ...(context.preparedInputs?.configBinds ?? []).map(bind => bind.effectiveDestination),
  ...(context.config ?? []).filter(config => config.format !== 'directory')
    .map(config => path.join(home, config.providerRelativePath)),
])]
if (!files.length) throw new Error('selected configuration is missing')
const configs = files.map(file => file.endsWith('.toml')
  ? Bun.TOML.parse(fs.readFileSync(file, 'utf8'))
  : Bun.JSONC.parse(fs.readFileSync(file, 'utf8')))
const userMcp = new Map()
const pluginResults = new Map()
for (const config of configs) {
  for (const [name, entry] of Object.entries(config.mcpServers ?? config.mcp_servers ?? config.mcp ?? {})) {
    if (!['user_fixture', 'other_global', 'project_fixture'].includes(name)) continue
    userMcp.set(name, await call(entry, { name: 'fixture', arguments: {} }))
  }
  for (const spec of config.plugin ?? []) {
    const exports = await import(spec)
    for (const [name, factory] of Object.entries(exports)) {
      if (typeof factory === 'function') pluginResults.set(name, await factory({}))
    }
  }
}
const health = entry => call(entry, { name: 'freshell', arguments: { action: 'health', params: {} } })
const mcpHealth = []
let selectedExecutable
let rebind
if (provider === 'codex') {
  for (const args of [context.preparation.codex.tui_args, context.preparation.codex.sidecar_args]) {
    const resolved = await rpc('/usr/local/bin/codex', ['app-server', ...args], 'config/read',
      { includeLayers: true, cwd }, true)
    userMcp.set('user_fixture', await call(resolved.config.mcp_servers.user_fixture,
      { name: 'fixture', arguments: {} }))
    mcpHealth.push((await health(resolved.config.mcp_servers.freshell)).ok)
  }
} else if (provider === 'claude') {
  // Hosted SDK transports use the scoped stdio bridge directly.
  mcpHealth.push((await health({ command: 'node', args: ['/opt/freshell-mcp/server.js'] })).ok)
  const unit = context.preparedInputs.resourceMounts.find(unit => unit.logicalDestination === fixturePlugin)
  if (!unit) throw new Error('selected Claude plugin projection is missing')
  const output = spawnSync(path.join(home, unit.providerRelativePath, 'command'), [], { env, encoding: 'utf8' })
  if (output.status !== 0) throw new Error('projected Claude plugin executable failed')
  selectedExecutable = output.stdout
} else {
  mcpHealth.push((await health({ command: 'node', args: ['/opt/freshell-mcp/server.js'] })).ok)
  const module = await import(pathToFileURL(`${home}/.config/opencode/plugin/user-plugin.ts`).href)
  pluginResults.set('User', await module.User({}))
  const { observeOpenCodeParitySelection } = await import(pathToFileURL(parityFixture).href)
  const observed = await observeOpenCodeParitySelection(home, cwd, `${home}/.freshell/opencode/tui.json`)
  rebind = observed.rebindPlugin
}
process.stdout.write(JSON.stringify({ configCount: files.length, userMcp: Object.fromEntries(userMcp),
  pluginResults: Object.fromEntries(pluginResults), mcpHealth, selectedExecutable, rebind }))
