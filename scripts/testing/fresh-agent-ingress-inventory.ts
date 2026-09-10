import fs from 'node:fs'
import path from 'node:path'

export const FRESH_AGENT_INGRESS_INVENTORY_VERSION = 1

export type FreshAgentIngressId =
  | 'browser-picker' | 'browser-split' | 'history-resume' | 'ws-create' | 'ws-attach'
  | 'rest-tab' | 'rest-split' | 'mcp-new-tab' | 'mcp-split' | 'startup-restore'
  | 'auto-resume' | 'managed-child-agent'

type SourceSymbol = { source: string; symbol: string }
export type FreshAgentIngressInventoryRow = {
  ingress: FreshAgentIngressId
  entry: SourceSymbol
  durableGateway: SourceSymbol
  sharedSupervisorOperation: SourceSymbol
}

const DURABLE_GATEWAY: SourceSymbol = {
  source: 'crates/freshell-server/src/fresh_agent_proxy.rs', symbol: 'create',
}
const SUPERVISOR_OPERATION: SourceSymbol = {
  source: 'crates/freshell-supervisor/src/service.rs', symbol: 'activate_prepared',
}
const row = (ingress: FreshAgentIngressId, entry: SourceSymbol): FreshAgentIngressInventoryRow => ({
  ingress, entry, durableGateway: DURABLE_GATEWAY, sharedSupervisorOperation: SUPERVISOR_OPERATION,
})

export const FRESH_AGENT_INGRESS_INVENTORY: readonly FreshAgentIngressInventoryRow[] = [
  row('browser-picker', { source: 'src/components/panes/PaneContainer.tsx', symbol: 'PickerWrapper' }),
  row('browser-split', { source: 'src/components/panes/PaneContainer.tsx', symbol: 'createContentForType' }),
  row('history-resume', { source: 'src/components/fresh-agent/FreshAgentView.tsx', symbol: 'FreshAgentView' }),
  row('ws-create', { source: 'crates/freshell-ws/src/hosted_fresh_agent.rs', symbol: 'dispatch_if_installed' }),
  row('ws-attach', { source: 'crates/freshell-ws/src/hosted_fresh_agent.rs', symbol: 'dispatch_if_installed' }),
  row('rest-tab', { source: 'crates/freshell-freshagent/src/lib.rs', symbol: 'create_tab' }),
  row('rest-split', { source: 'crates/freshell-freshagent/src/pane_ops.rs', symbol: 'split_pane' }),
  row('mcp-new-tab', { source: 'server/mcp/freshell-tool.ts', symbol: 'executeAction' }),
  row('mcp-split', { source: 'server/mcp/freshell-tool.ts', symbol: 'executeAction' }),
  row('startup-restore', { source: 'crates/freshell-supervisor/src/inventory.rs', symbol: 'reconcile_startup' }),
  row('auto-resume', { source: 'crates/freshell-supervisor/src/recovery.rs', symbol: 'recover' }),
  row('managed-child-agent', { source: 'crates/freshell-supervisor/src/service.rs', symbol: 'fresh_agent_send' }),
] as const

export function validateFreshAgentIngressInventory(repoRoot: string): FreshAgentIngressInventoryRow[] {
  const expected: FreshAgentIngressId[] = [
    'browser-picker', 'browser-split', 'history-resume', 'ws-create', 'ws-attach', 'rest-tab',
    'rest-split', 'mcp-new-tab', 'mcp-split', 'startup-restore', 'auto-resume', 'managed-child-agent',
  ]
  const actual = FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('fresh-agent ingress inventory is incomplete or reordered')
  }
  const cache = new Map<string, string>()
  for (const item of FRESH_AGENT_INGRESS_INVENTORY) {
    for (const target of [item.entry, item.durableGateway, item.sharedSupervisorOperation]) {
      const absolute = path.resolve(repoRoot, target.source)
      if (!absolute.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) {
        throw new Error(`fresh-agent inventory path escapes repository: ${target.source}`)
      }
      const source = cache.get(absolute) ?? fs.readFileSync(absolute, 'utf8')
      cache.set(absolute, source)
      if (!symbolDefinition(source, target.symbol)) {
        throw new Error(`fresh-agent inventory symbol is unresolved: ${target.source}#${target.symbol}`)
      }
    }
    if (item.sharedSupervisorOperation.source !== SUPERVISOR_OPERATION.source
      || item.sharedSupervisorOperation.symbol !== SUPERVISOR_OPERATION.symbol) {
      throw new Error(`${item.ingress} does not resolve to the shared supervisor operation`)
    }
  }
  return [...FRESH_AGENT_INGRESS_INVENTORY]
}

function symbolDefinition(source: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`,
    `(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`,
    `(?:export\\s+)?(?:const|class|type|interface)\\s+${escaped}\\b`,
  ].some((pattern) => new RegExp(pattern).test(source))
}
