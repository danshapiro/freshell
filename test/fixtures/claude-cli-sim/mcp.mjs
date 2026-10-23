// The stdio MCP servers of a simulated CLI session, the way the pinned CLI
// runs them (conformance scenario `mcp`, claude-cli-scenarios.mjs):
//   - each stdio server in `options.mcpServers` starts when the session does,
//     with the CLI's environment (the SDK `env`) plus the server's own `env`;
//   - a server is `connected` once it answered `initialize` and `tools/list`,
//     else `failed`; a model turn waits until every server has settled, then
//     its system/init lists the servers and their tools (`mcp__<server>__<tool>`);
//   - a call of a listed tool is a `tools/call`: its content is the tool
//     result (an error result when the server says so or goes away);
//   - a call of an MCP tool no connected server lists is the CLI's
//     "No such tool available" error result;
//   - the servers stop with the session.
// Servers of other transports (http, sse, sdk) are reported `failed`: the
// simulator only runs stdio servers.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** How long a server may take to answer initialize and tools/list (the CLI's MCP_TIMEOUT). */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const PROTOCOL_VERSION = '2025-06-18'

/** `mcp__<server>__<tool>` split into its server and tool names, or null. */
export function parseMcpToolName(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(name))
  return match ? { server: match[1], tool: match[2] } : null
}

/** The CLI's error result for a tool the model called that no server offers. */
export function noSuchToolResult(name) {
  const message = `No such tool available: ${name}`
  return { content: `<tool_use_error>Error: ${message}</tool_use_error>`, toolUseResult: `Error: ${message}` }
}

class StdioServer {
  constructor(name, config, { env, cwd, timeoutMs }) {
    this.name = name
    this.status = 'pending'
    this.tools = []
    this.pending = new Map()
    this.nextId = 1
    this.child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
      cwd,
      env: { ...env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.child.on('error', () => this.fail())
    this.child.stdin.on('error', () => {})
    this.child.once('exit', () => this.fail())
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
    this.ready = this.connect(timeoutMs)
  }

  async connect(timeoutMs) {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP server connection timed out')), timeoutMs) })
    try {
      await Promise.race([this.handshake(), timeout])
      this.status = 'connected'
    } catch {
      this.fail()
    } finally {
      clearTimeout(timer)
    }
  }

  async handshake() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'claude-code', version: 'simulated' },
    })
    this.notify('notifications/initialized')
    const listed = await this.request('tools/list', {})
    this.tools = (listed?.tools ?? []).map((tool) => String(tool?.name)).filter(Boolean)
  }

  onLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message?.id === undefined || !this.pending.has(message.id)) return
    const { resolve, reject } = this.pending.get(message.id)
    this.pending.delete(message.id)
    if (message.error) reject(new Error(String(message.error.message ?? 'MCP error')))
    else resolve(message.result)
  }

  request(method, params) {
    if (this.status === 'failed') return Promise.reject(new Error(`MCP server "${this.name}" is not connected`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  fail() {
    this.status = this.status === 'stopped' ? 'stopped' : 'failed'
    for (const { reject } of this.pending.values()) reject(new Error(`MCP server "${this.name}" closed`))
    this.pending.clear()
  }

  stop() {
    this.status = 'stopped'
    this.fail()
    try { this.child.stdin.end() } catch { /* already gone */ }
    try { this.child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

export class McpServers {
  /** Start every configured server with the CLI's environment `env`. */
  constructor(configs, { env, cwd }) {
    const timeoutMs = Number(env.MCP_TIMEOUT) > 0 ? Number(env.MCP_TIMEOUT) : DEFAULT_CONNECT_TIMEOUT_MS
    this.servers = new Map()
    this.unsupported = []
    for (const [name, config] of Object.entries(configs ?? {})) {
      if ((config?.type ?? 'stdio') === 'stdio' && typeof config?.command === 'string') {
        this.servers.set(name, new StdioServer(name, config, { env, cwd, timeoutMs }))
      } else {
        this.unsupported.push(name)
      }
    }
  }

  /** Resolves once every server has connected or failed. */
  settled() {
    return Promise.all([...this.servers.values()].map((server) => server.ready))
  }

  /** The init message's `mcp_servers`. */
  statuses() {
    return [
      ...[...this.servers.values()].map((server) => ({ name: server.name, status: server.status === 'connected' ? 'connected' : server.status === 'pending' ? 'pending' : 'failed' })),
      ...this.unsupported.map((name) => ({ name, status: 'failed' })),
    ]
  }

  /** The qualified names of every connected server's tools. */
  toolNames() {
    return [...this.servers.values()]
      .filter((server) => server.status === 'connected')
      .flatMap((server) => server.tools.map((tool) => `mcp__${server.name}__${tool}`))
  }

  /** Whether a connected server lists the qualified tool `name`. */
  offers(name) {
    return this.toolNames().includes(name)
  }

  /**
   * Call the qualified tool `name`: `{ content, isError }` from the server, or
   * an error result when the call fails.
   */
  async call(name, input) {
    const parsed = parseMcpToolName(name)
    const server = parsed && this.servers.get(parsed.server)
    if (!server || server.status !== 'connected') return { content: noSuchToolResult(name).content, isError: true }
    try {
      const result = await server.request('tools/call', { name: parsed.tool, arguments: input ?? {} })
      const content = Array.isArray(result?.content) ? result.content : []
      return { content, isError: result?.isError === true }
    } catch (error) {
      return { content: `<tool_use_error>Error: ${error?.message ?? error}</tool_use_error>`, isError: true }
    }
  }

  stop() {
    for (const server of this.servers.values()) server.stop()
  }
}
