// mcp-servers.mjs — the MCP servers a session's query() gets, and the pane
// context its CLI environment carries (api-hosted-ops plan §2.4, G19).
//
// A session gets at most one Freshell MCP recipe:
//   - hosted: inside a hosted Claude runtime (hosted.mjs), the session host's
//     fixed command, when the lane selected it (`create.hostedMcp`). A hosted
//     sidecar never gets the ordinary recipe;
//   - ordinary: outside a session host, the command the Rust server resolved
//     for this host while `settings.codingCli.mcpServer` is on
//     (`create.freshellMcp`, `{ command, args }`).
//
// A recipe never carries an `env` key. The SDK hands the MCP config to the CLI
// on its command line (`--mcp-config <json>`), where any process can read it,
// so the endpoint and token stay in the inherited environment: the Rust
// server sets FRESHELL/FRESHELL_URL/FRESHELL_TOKEN on this process, and the
// CLI passes its environment on to the stdio MCP child.

import { usesHostedClaudeRuntime } from './hosted.mjs'

/** The MCP server name both recipes register (its tools are `mcp__freshell__*`). */
export const FRESHELL_MCP_SERVER_NAME = 'freshell'

const HOSTED_RECIPE = Object.freeze({ command: 'node', args: Object.freeze(['/opt/freshell-mcp/server.js']) })

/** The pane-scoped context names: a session's CLI carries its own pane's, never another's. */
const PANE_CONTEXT_ENV = ['FRESHELL_TERMINAL_ID', 'FRESHELL_TAB_ID', 'FRESHELL_PANE_ID']

/** `{ command, args }` copied from a well-formed ordinary recipe, else undefined. */
function ordinaryRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') return undefined
  const { command, args } = recipe
  if (typeof command !== 'string' || command.length === 0) return undefined
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined
  return { command, args: [...args] }
}

/**
 * The `mcpServers` option for the session `req` creates: the hosted recipe,
 * the ordinary recipe, or undefined (never both, never an `env` key).
 */
export function mcpServersFor(req, env = process.env) {
  if (usesHostedClaudeRuntime(env)) {
    if (req?.hostedMcp !== true) return undefined
    return { [FRESHELL_MCP_SERVER_NAME]: { command: HOSTED_RECIPE.command, args: [...HOSTED_RECIPE.args] } }
  }
  const recipe = ordinaryRecipe(req?.freshellMcp)
  return recipe ? { [FRESHELL_MCP_SERVER_NAME]: recipe } : undefined
}

/**
 * `env` with the pane the session runs for (`create.freshellContext`,
 * `{ tabId?, paneId? }`): the pane-scoped names come from the context alone,
 * so a value inherited from elsewhere never reaches the CLI. A request with
 * no context (an older server) leaves `env` as it is.
 */
export function withFreshellContext(env, context) {
  if (!context || typeof context !== 'object') return env
  const out = { ...env }
  for (const name of PANE_CONTEXT_ENV) delete out[name]
  if (typeof context.tabId === 'string' && context.tabId) out.FRESHELL_TAB_ID = context.tabId
  if (typeof context.paneId === 'string' && context.paneId) out.FRESHELL_PANE_ID = context.paneId
  return out
}
