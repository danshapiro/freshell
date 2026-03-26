// MCP server entry point for Freshell orchestration.
// Registers a single "freshell" tool and connects via stdio JSON-RPC transport.

/**
 * CRITICAL: No console.log() -- it corrupts the stdio JSON-RPC channel.
 * Use console.error() for debug output only.
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOL_DESCRIPTION, INSTRUCTIONS, INPUT_SCHEMA, executeAction } from './freshell-tool.js'

/**
 * Walk up from __dirname to find the repo root's package.json.
 * Works in both dev (server/mcp/server.ts) and prod (dist/server/mcp/server.js).
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
    const text = result !== undefined ? JSON.stringify(result, null, 2) : '{}'
    return {
      content: [{ type: 'text' as const, text }],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
