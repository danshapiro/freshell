export type ActionCapability = {
  action: string
  aliases?: readonly string[]
  supported: boolean
  unsupportedHint?: string
}

const unavailable = 'This action is unavailable with the Rust Freshell server.'

/** The closed Rust client contract: 33 canonical actions and 14 tmux aliases. */
export const ACTION_CAPABILITIES: readonly ActionCapability[] = [
  { action: 'new-tab', aliases: ['new-window', 'new-session'], supported: true },
  { action: 'list-tabs', aliases: ['list-windows'], supported: true },
  { action: 'select-tab', aliases: ['select-window'], supported: true },
  { action: 'kill-tab', aliases: ['kill-window'], supported: true },
  { action: 'rename-tab', aliases: ['rename-window'], supported: true },
  { action: 'next-tab', aliases: ['next-window'], supported: true },
  { action: 'prev-tab', aliases: ['previous-window', 'prev-window'], supported: true },
  { action: 'split-pane', aliases: ['split-window'], supported: true },
  { action: 'display', aliases: ['display-message'], supported: true },
  { action: 'screenshot', aliases: ['screenshot-pane', 'screenshot-tab', 'screenshot-view'], supported: true },
  { action: 'has-tab', supported: true }, { action: 'list-panes', supported: true },
  { action: 'select-pane', supported: true }, { action: 'rename-pane', supported: true },
  { action: 'kill-pane', supported: true }, { action: 'resize-pane', supported: true },
  { action: 'swap-pane', supported: true }, { action: 'respawn-pane', supported: true },
  { action: 'send-keys', supported: true }, { action: 'capture-pane', supported: true },
  { action: 'wait-for', supported: true }, { action: 'summarize', supported: true },
  { action: 'list-terminals', supported: true }, { action: 'open-browser', supported: true },
  { action: 'navigate', supported: true }, { action: 'list-sessions', supported: true },
  { action: 'search-sessions', supported: true }, { action: 'lan-info', supported: true },
  { action: 'health', supported: true }, { action: 'help', supported: true },
  { action: 'run', supported: false, unsupportedHint: unavailable },
  { action: 'fresh-send', supported: false, unsupportedHint: unavailable },
  { action: 'attach', supported: false, unsupportedHint: unavailable },
]

const byAction = new Map(ACTION_CAPABILITIES.map((capability) => [capability.action, capability]))
const byAlias = new Map(ACTION_CAPABILITIES.flatMap((capability) =>
  (capability.aliases ?? []).map((alias) => [alias, capability] as const)))

export function resolveActionCapability(action: string): ActionCapability | undefined {
  return byAction.get(action) ?? byAlias.get(action)
}

export function unsupportedActionResult(action: string): { error: string; hint: string } | undefined {
  const capability = resolveActionCapability(action)
  if (capability?.supported !== false) return undefined
  return { error: `Action '${action}' is unavailable with the Rust Freshell server.`, hint: capability.unsupportedHint ?? unavailable }
}
