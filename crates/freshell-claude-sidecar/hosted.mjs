// hosted.mjs — whether this sidecar runs inside a hosted session host, and
// which hosted rules apply. The ONE reader of FRESHELL_HOSTED_FRESH_AGENT:
// the session host sets it to the provider it hosts, which for this runtime
// is `claude` (freshclaude) or `kilroy` (crates/freshell-supervisor/src/
// backend.rs). Two rules read it:
//   - every hosted sidecar logs CLI output by size only (isHostedSidecar);
//   - the managed spawn check and the fixed hosted MCP recipe apply to every
//     hosted Claude runtime, freshclaude and kilroy alike
//     (usesHostedClaudeRuntime): both run the same Claude CLI inside the same
//     managed enclosure, and kilroy consumes the Claude launch recipes
//     (FreshProvider::native_provider in freshell-runtime-protocol).

/** The providers whose hosted sidecar runs the Claude CLI. */
const HOSTED_CLAUDE_RUNTIMES = new Set(['claude', 'kilroy'])

/** The provider the session host hosts, or undefined outside a session host. */
export function hostedProvider(env = process.env) {
  return env.FRESHELL_HOSTED_FRESH_AGENT || undefined
}

/** Any hosted sidecar, freshclaude or kilroy: its CLI output is logged by size only. */
export function isHostedSidecar(env = process.env) {
  return hostedProvider(env) !== undefined
}

/** Hosted claude or kilroy: the SDK spawn is checked against the managed exec profile and the fixed MCP recipe is offered. */
export function usesHostedClaudeRuntime(env = process.env) {
  return HOSTED_CLAUDE_RUNTIMES.has(hostedProvider(env))
}
