// A minimal stdio MCP server standing in for the Freshell MCP server
// (tools/freshell-mcp/server.ts) in the G19 contract and simulator tests.
//
//   node claude-freshell-mcp-probe-server.mjs <report.json>
//
// On start it writes what the Freshell MCP client would read from its
// environment to <report.json>: the Freshell context names, with the token as
// a sha256 digest (never its value). Its one tool, `context`, answers with the
// same report as text, so a model turn can show what the server saw.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'

const PROBE_TOOL = 'context'

const report = {
  pid: process.pid,
  FRESHELL: process.env.FRESHELL ?? null,
  FRESHELL_URL: process.env.FRESHELL_URL ?? null,
  FRESHELL_TOKEN_SHA256: process.env.FRESHELL_TOKEN
    ? createHash('sha256').update(process.env.FRESHELL_TOKEN).digest('hex')
    : null,
  FRESHELL_TAB_ID: process.env.FRESHELL_TAB_ID ?? null,
  FRESHELL_PANE_ID: process.env.FRESHELL_PANE_ID ?? null,
  FRESHELL_TERMINAL_ID: process.env.FRESHELL_TERMINAL_ID ?? null,
}
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(report)}\n`)

const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

lines.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'freshell-probe', version: '1.0.0' },
      },
    })
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{ name: PROBE_TOOL, description: 'Reports the Freshell context this server received.', inputSchema: { type: 'object', properties: {} } }],
      },
    })
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(report) }] } })
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
lines.on('close', () => process.exit(0))
