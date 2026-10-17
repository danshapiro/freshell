// The managed launch context selects one fixed recipe. Scoped authentication
// stays in the inherited child environment and never enters SDK argv/IPC.
export function hostedMcpServers(selected, env = process.env) {
  if (selected !== true || env.FRESHELL_HOSTED_FRESH_AGENT !== 'claude') return undefined
  return { freshell: { command: 'node', args: ['/opt/freshell-mcp/server.js'] } }
}
