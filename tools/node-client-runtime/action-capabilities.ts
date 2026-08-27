export type ActionParameters = {
  required: readonly string[]
  optional: readonly string[]
}

export type ActionCapability = {
  action: string
  aliases?: readonly string[]
  supported: boolean
  params: ActionParameters
  unsupportedHint?: string
}

const unavailable = 'This action is unavailable with the Rust Freshell server.'
const noParams: ActionParameters = { required: [], optional: [] }
const params = (required: readonly string[] = [], optional: readonly string[] = []): ActionParameters => ({ required, optional })

/** The closed Rust client contract: 33 canonical actions and 14 tmux aliases. */
export const ACTION_CAPABILITIES: readonly ActionCapability[] = [
  { action: 'new-tab', aliases: ['new-window', 'new-session'], supported: true, params: params([], ['name', 'mode', 'shell', 'cwd', 'browser', 'editor', 'resume', 'resumeSessionId', 'sessionRef', 'prompt', 'agent', 'model', 'effort']) },
  { action: 'list-tabs', aliases: ['list-windows'], supported: true, params: noParams },
  { action: 'select-tab', aliases: ['select-window'], supported: true, params: params(['target']) },
  { action: 'kill-tab', aliases: ['kill-window'], supported: true, params: params(['target']) },
  { action: 'rename-tab', aliases: ['rename-window'], supported: true, params: params(['name'], ['target']) },
  { action: 'next-tab', aliases: ['next-window'], supported: true, params: noParams },
  { action: 'prev-tab', aliases: ['previous-window', 'prev-window'], supported: true, params: noParams },
  { action: 'split-pane', aliases: ['split-window'], supported: true, params: params([], ['target', 'direction', 'mode', 'shell', 'cwd', 'browser', 'editor', 'resume', 'sessionRef']) },
  { action: 'display', aliases: ['display-message'], supported: true, params: params([], ['target', 'format']) },
  { action: 'screenshot', aliases: ['screenshot-pane', 'screenshot-tab', 'screenshot-view'], supported: true, params: params(['scope'], ['target', 'name']) },
  { action: 'has-tab', supported: true, params: params(['target']) },
  { action: 'list-panes', supported: true, params: params([], ['target']) },
  { action: 'select-pane', supported: true, params: params(['target']) },
  { action: 'rename-pane', supported: true, params: params(['name'], ['target']) },
  { action: 'kill-pane', supported: true, params: params(['target']) },
  { action: 'resize-pane', supported: true, params: params(['target'], ['x', 'y', 'sizes']) },
  { action: 'swap-pane', supported: true, params: params(['target', 'with']) },
  { action: 'respawn-pane', supported: true, params: params(['target'], ['mode', 'shell', 'cwd', 'resume', 'sessionRef']) },
  { action: 'send-keys', supported: true, params: params([], ['target', 'keys', 'literal', 'sessionRef']) },
  // J/e are accepted no-ops by the Rust server and stay part of the public contract.
  { action: 'capture-pane', supported: true, params: params([], ['target', 'S', 'J', 'e']) },
  { action: 'wait-for', supported: true, params: params(['pattern'], ['target', 'timeout']) },
  { action: 'summarize', supported: true, params: params([], ['target']) },
  { action: 'list-terminals', supported: true, params: noParams },
  { action: 'open-browser', supported: true, params: params(['url'], ['name']) },
  { action: 'navigate', supported: true, params: params(['target', 'url']) },
  { action: 'list-sessions', supported: true, params: noParams },
  { action: 'search-sessions', supported: true, params: params(['query']) },
  { action: 'lan-info', supported: true, params: noParams },
  { action: 'health', supported: true, params: noParams },
  { action: 'help', supported: true, params: noParams },
  { action: 'run', supported: false, params: params(['command'], ['capture', 'detached', 'timeout', 'name', 'cwd']), unsupportedHint: unavailable },
  { action: 'fresh-send', supported: false, params: params(['sessionId', 'sessionType', 'provider', 'text']), unsupportedHint: unavailable },
  { action: 'attach', supported: false, params: params(['target', 'terminalId'], ['sessionRef']), unsupportedHint: unavailable },
] as const

export function validateActionCapabilities(capabilities: readonly ActionCapability[]): void {
  const names = new Set<string>()
  if (capabilities.length !== 33) throw new Error(`Expected 33 canonical actions, found ${capabilities.length}.`)
  for (const capability of capabilities) {
    if (!capability.action || typeof capability.supported !== 'boolean' || !capability.params) {
      throw new Error('Every action capability must be classified with an action, supported state, and parameters.')
    }
    for (const name of [capability.action, ...(capability.aliases ?? [])]) {
      if (!name) throw new Error(`Action '${capability.action}' contains an empty alias.`)
      if (names.has(name)) throw new Error(`Duplicate action or alias '${name}' in capability matrix.`)
      names.add(name)
    }
    const parameterNames = [...capability.params.required, ...capability.params.optional]
    if (new Set(parameterNames).size !== parameterNames.length) {
      throw new Error(`Action '${capability.action}' classifies a parameter more than once.`)
    }
  }
  const aliasCount = capabilities.reduce((count, capability) => count + (capability.aliases?.length ?? 0), 0)
  if (aliasCount !== 14) throw new Error(`Expected 14 aliases, found ${aliasCount}.`)
}

validateActionCapabilities(ACTION_CAPABILITIES)

const byAction = new Map(ACTION_CAPABILITIES.map((capability) => [capability.action, capability]))
const byAlias = new Map(ACTION_CAPABILITIES.flatMap((capability) =>
  (capability.aliases ?? []).map((alias) => [alias, capability] as const)))

export const ACTION_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  ACTION_CAPABILITIES.flatMap((capability) => (capability.aliases ?? []).map((alias) => [alias, capability.action])),
))

export function resolveActionCapability(action: string): ActionCapability | undefined {
  return byAction.get(action) ?? byAlias.get(action)
}

export function resolveCanonicalAction(action: string): string | undefined {
  return resolveActionCapability(action)?.action
}

export function supportedActionCapabilities(): readonly ActionCapability[] {
  return ACTION_CAPABILITIES.filter((capability) => capability.supported)
}

/** Renders the standalone CLI reference from the closed Rust client contract. */
export function renderCliHelp(capabilities: readonly ActionCapability[] = supportedActionCapabilities()): string {
  const actionLines = capabilities.flatMap((capability) => {
    const aliases = capability.aliases?.length ? ` (aliases: ${capability.aliases.join(', ')})` : ''
    const required = capability.params.required.map((name) => `--${name}`).join(', ') || '(none)'
    const optional = capability.params.optional.map((name) => `--${name}`).join(', ') || '(none)'
    return [
      `  ${capability.action}${aliases}`,
      `    required: ${required}`,
      `    optional: ${optional}`,
    ]
  })

  return [
    'Freshell CLI',
    '',
    'Usage: freshell <action> [options]',
    '',
    'Supported actions:',
    ...actionLines,
  ].join('\n')
}

export function unsupportedActionResult(action: string): { error: string; hint: string } | undefined {
  const capability = resolveActionCapability(action)
  if (capability?.supported !== false) return undefined
  return { error: `Action '${action}' is unavailable with the Rust Freshell server.`, hint: capability.unsupportedHint ?? unavailable }
}

export function unsupportedInvocationResult(
  action: string,
  invocation: Record<string, unknown> | undefined,
): { error: string; hint: string } | undefined {
  const unsupported = unsupportedActionResult(action)
  if (unsupported) return unsupported
  const canonical = resolveCanonicalAction(action)
  if (canonical === 'new-tab' && invocation?.agent !== undefined && invocation.agent !== 'opencode') {
    return { error: "Only agent 'opencode' is supported with the Rust Freshell server.", hint: 'Use mode for direct Claude or Codex terminals.' }
  }
  if (canonical === 'split-pane' && ['agent', 'model', 'effort'].some((key) => invocation?.[key] !== undefined)) {
    return { error: 'Fresh-agent split parameters are unavailable with the Rust Freshell server.', hint: 'Use a supported mode pane instead.' }
  }
  if (canonical === 'wait-for' && (
    typeof invocation?.pattern !== 'string' || invocation.pattern.length === 0 || ['stable', 'exit', 'prompt'].some((key) => invocation?.[key] !== undefined)
  )) {
    return { error: 'wait-for requires pattern with the Rust Freshell server.', hint: 'Use a literal output pattern.' }
  }
  return undefined
}
