// Prompt markers: the one scripting language shared by the local fake
// Anthropic endpoint (test/integration/providers/claude-local-provider.mjs,
// which drives the REAL pinned Claude CLI) and the CLI simulator
// (test/fixtures/claude-cli-sim/query.mjs). A prompt that contains a marker
// makes "the model" behave the same way on both targets, which is what lets
// the conformance suite compare their traces.
//
//   (no marker)               one short text reply ("ok")
//   SLOW                      text streamed in SLOW_CHUNKS deltas, SLOW_DELAY_MS apart
//   TOOL:sleep=<s>            a Bash tool call running `sleep <s>`, then a text reply
//   TOOL:sleep=<s>,timeout=<ms>   the same Bash call with an explicit timeout
//   APIERR:<status>           the model request fails with that HTTP status
//   HANG                      the model request never completes
//   MCP:hang                  a call to the hung stdio MCP tool (mcp__hang__wait)
//   AGENT:async               a background Agent; its completion starts a CLI-initiated turn
//
// Only the text after the last tool_result of the LAST user message is
// scanned: a marker in an earlier turn never leaks into a later request, a
// tool's own continuation is a plain reply, and a send absorbed into a tool
// call (which the CLI appends after the tool_result) is read like a prompt.

export const SLOW_CHUNKS = 8
export const SLOW_DELAY_MS = 250
export const SUBAGENT_MARKER = 'SUBAGENT-TASK'
export const HANG_MCP_SERVER_NAME = 'hang'
export const HANG_MCP_TOOL_NAME = 'wait'
export const HANG_MCP_QUALIFIED_TOOL = `mcp__${HANG_MCP_SERVER_NAME}__${HANG_MCP_TOOL_NAME}`

const TOOL_RE = /\bTOOL:sleep=(\d+(?:\.\d+)?)(?:,timeout=(\d+))?/
const APIERR_RE = /\bAPIERR:(\d{3})\b/

/**
 * @param {string} text the text of the last user message
 * @returns {{kind:'text'}|{kind:'slow',chunks:number,delayMs:number}|{kind:'tool',command:string,seconds:number,timeoutMs?:number}|{kind:'api_error',status:number}|{kind:'hang'}|{kind:'mcp_hang'}|{kind:'agent_async'}}
 */
export function parsePromptMarkers(text) {
  const value = String(text ?? '')
  const apiError = APIERR_RE.exec(value)
  if (apiError) return { kind: 'api_error', status: Number(apiError[1]) }
  if (/\bMCP:hang\b/.test(value)) return { kind: 'mcp_hang' }
  if (/\bAGENT:async\b/.test(value)) return { kind: 'agent_async' }
  const tool = TOOL_RE.exec(value)
  if (tool) {
    return {
      kind: 'tool',
      seconds: Number(tool[1]),
      command: `sleep ${tool[1]}`,
      ...(tool[2] ? { timeoutMs: Number(tool[2]) } : {}),
    }
  }
  if (/\bHANG\b/.test(value)) return { kind: 'hang' }
  if (/\bSLOW\b/.test(value)) return { kind: 'slow', chunks: SLOW_CHUNKS, delayMs: SLOW_DELAY_MS }
  return { kind: 'text' }
}
