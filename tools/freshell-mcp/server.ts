/**
 * MCP server entry point for Freshell orchestration.
 *
 * Registers a single "freshell" tool with action dispatch and connects
 * via stdio JSON-RPC transport. Spawned as a child process by each agent.
 *
 * CRITICAL: No console.log() -- it corrupts the stdio JSON-RPC channel.
 * Use console.error() for debug output only.
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TOOL_DESCRIPTION, INSTRUCTIONS, INPUT_SCHEMA, executeAction } from './freshell-tool.js'

/**
 * Walk up from __dirname to find the repo root's package.json.
 * Works in both dev (tools/freshell-mcp/server.ts) and prod (dist/tools/freshell-mcp/server.js).
 */
function findPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8'))
      if (pkg.name === 'freshell') return pkg.version
    } catch { /* not found, keep walking */ }
    dir = dirname(dir)
  }
  return '0.0.0'
}

const server = new McpServer(
  { name: 'freshell', version: findPackageVersion() },
  { instructions: INSTRUCTIONS },
)

server.tool(
  'freshell',
  TOOL_DESCRIPTION,
  INPUT_SCHEMA,
  async ({ action, params }) => {
    const result = await executeAction(action, params as Record<string, unknown> | undefined)
    // Guard against undefined results (e.g. from API envelopes with no data).
    // JSON.stringify(undefined) produces the literal "undefined", not valid JSON.
    const text = result !== undefined ? JSON.stringify(result, null, 2) : '{}'
    return {
      content: [{ type: 'text' as const, text }],
    }
  },
)

async function selfTest(): Promise<void> {
  const client = new Client({ name: 'freshell-mcp-image-probe', version: findPackageVersion() })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...process.execArgv, fileURLToPath(import.meta.url)],
    env: process.env as Record<string, string>,
    stderr: 'pipe',
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    if (!tools.tools.some(tool => tool.name === 'freshell')) {
      throw new Error('Freshell tool was not registered')
    }

    const response = await client.callTool({ name: 'freshell', arguments: { action: 'health' } })
    const content = (response.content as Array<{ type: string; text?: string }> | undefined)?.[0]
    if (response.isError || content?.type !== 'text' || typeof content.text !== 'string') {
      throw new Error('Freshell health tool returned an error')
    }
    const result = JSON.parse(content.text) as { probe?: string }
    if (result.probe !== 'freshell-mcp-image') {
      throw new Error('Freshell health tool did not reach the probe endpoint')
    }
    process.stdout.write(JSON.stringify({ tool: 'freshell', action: 'health', ok: true }) + '\n')
  } finally {
    await client.close()
  }
}

if (process.argv[2] === '--self-test') {
  try {
    await selfTest()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} else {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
