import type { NormalizedEvent, NormalizedEventType } from '@/lib/coding-cli-types'

/**
 * Event types that are relevant for the activity panel sidebar.
 * Excludes streaming deltas and session lifecycle noise.
 */
const RELEVANT_EVENT_TYPES: Set<NormalizedEventType> = new Set([
  'tool.call',
  'tool.result',
  'token.usage',
  'approval.request',
  'approval.response',
  'error',
])

/**
 * Returns true if the event should be shown in the activity panel.
 * Filters out message deltas, reasoning, and session lifecycle events
 * that would create noise in the tool-focused sidebar.
 */
export function isActivityPanelRelevant(event: NormalizedEvent): boolean {
  return RELEVANT_EVENT_TYPES.has(event.type)
}

/**
 * Humanize MCP-style tool names.
 * "Bash" → "Bash"
 * "mcp__linear__get_issue" → "Linear: Get Issue"
 * "mcp__supabase__execute_sql" → "Supabase: Execute Sql"
 */
export function formatToolName(name: string): string {
  if (!name) return 'Unknown'

  // MCP tool names follow the pattern: mcp__server__action_name
  const mcpMatch = name.match(/^mcp__([^_]+)__(.+)$/)
  if (mcpMatch) {
    const server = mcpMatch[1].charAt(0).toUpperCase() + mcpMatch[1].slice(1)
    const action = mcpMatch[2]
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
    return `${server}: ${action}`
  }

  return name
}

/**
 * Format ISO timestamp to relative time string.
 * Within 60s: "Ns ago"
 * Within 60m: "Nm ago"
 * Otherwise: "Nh ago"
 */
export function formatTimestamp(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return 'just now'

  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

/**
 * Format token count to human-readable string.
 * < 1000: "450"
 * >= 1000: "1.2k"
 * >= 1000000: "1.2M"
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
