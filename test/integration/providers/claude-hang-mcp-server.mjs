// A minimal stdio MCP server with one tool, `wait`, that never answers.
// The real-CLI contract suite uses it to pin the CLI's behavior around a hung
// MCP tool call (tool_progress heartbeats with no end).
import readline from 'node:readline'

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
        serverInfo: { name: 'hang', version: '1.0.0' },
      },
    })
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'wait', description: 'Waits forever.', inputSchema: { type: 'object', properties: {} } }] },
    })
  } else if (message.method === 'tools/call') {
    // Deliberately never answered.
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
lines.on('close', () => process.exit(0))
