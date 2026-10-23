// The pinned SDK and CLI, with the contract suite's real hung stdio MCP server.
import { query as sdkQuery } from '../../../crates/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
import { HANG_MCP_SERVER_SCRIPT } from './claude-local-provider.mjs'

export function query(params) {
  return sdkQuery({
    ...params,
    options: {
      ...params.options,
      mcpServers: {
        ...params.options?.mcpServers,
        hang: { type: 'stdio', command: process.execPath, args: [HANG_MCP_SERVER_SCRIPT] },
      },
    },
  })
}
