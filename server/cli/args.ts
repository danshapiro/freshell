export type ParsedArgs = {
  command?: string
  flags: Record<string, string | boolean>
  args: string[]
}

const SHORT_BOOLEAN_FLAGS = new Set([
  'c', // split-window --capture
  'd', // split-window --detach
  'e', // capture-pane include escapes
  'J', // capture-pane join wrapped lines
  'l', // send-keys --literal
  'h', // split-pane --horizontal
])

const FLAGS_ALLOWING_DASH_PREFIX_VALUES = new Set([
  'other',
  'pane',
  's',
  'swap',
  't',
  'tab',
  'target',
])

const COMMAND_FLAG_KEYS_ALLOWING_DASH_PREFIX_VALUES: Partial<Record<string, Set<string>>> = {
  // attach uses -p for pane target; allow dash-prefixed pane ids like "-abc123".
  attach: new Set(['p']),
  // send-keys can take a pane id positionally, and nanoid-generated pane ids can
  // start with "-". Keep its real flags recognized while allowing positional ids.
  'send-keys': new Set(['l', 'literal', 'pane', 't', 'target']),
  // rename commands accept generated tab/pane ids positionally or via flags, and
  // those ids come from nanoid(), which can start with "-".
  'rename-pane': new Set(['n', 'name', 'pane', 't', 'target', 'title']),
  'rename-tab': new Set(['n', 'name', 't', 'tab', 'target', 'title']),
}

const COMMANDS_TREATING_UNKNOWN_DASH_TOKENS_AS_POSITIONALS = new Set([
  'send-keys',
  'rename-pane',
  'rename-tab',
])

function isNegativeNumericToken(token: string): boolean {
  return /^-\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(token)
}

function allowsDashPrefixedValue(command: string | undefined, key: string): boolean {
  if (FLAGS_ALLOWING_DASH_PREFIX_VALUES.has(key)) return true
  if (!command) return false
  return COMMAND_FLAG_KEYS_ALLOWING_DASH_PREFIX_VALUES[command]?.has(key) ?? false
}

function canUseAsFlagValue(token: string | undefined, key: string, command: string | undefined): token is string {
  if (!token) return false
  if (token === '--') return false
  return !token.startsWith('-') || isNegativeNumericToken(token) || allowsDashPrefixedValue(command, key)
}

function shouldTreatDashTokenAsPositional(
  command: string | undefined,
  token: string,
  args: string[],
): boolean {
  if (!command || !COMMANDS_TREATING_UNKNOWN_DASH_TOKENS_AS_POSITIONALS.has(command)) return false
  if (args.length > 0) return true
  const allowedKeys = COMMAND_FLAG_KEYS_ALLOWING_DASH_PREFIX_VALUES[command]
  const key = token.startsWith('--') ? token.slice(2).split('=')[0] : token.slice(1)
  return !allowedKeys?.has(key)
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const args: string[] = []
  let command: string | undefined
  let i = 0

  while (i < argv.length) {
    const token = argv[i]
    if (!command && !token.startsWith('-')) {
      command = token
      i += 1
      continue
    }

    if (token === '--') {
      args.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith('-') && shouldTreatDashTokenAsPositional(command, token, args)) {
      args.push(token)
      i += 1
      continue
    }

    if (token.startsWith('--')) {
      const raw = token.slice(2)
      const eqIndex = raw.indexOf('=')
      if (eqIndex >= 0) {
        const key = raw.slice(0, eqIndex)
        const value = raw.slice(eqIndex + 1)
        flags[key] = value
        i += 1
        continue
      }
      const key = raw
      const next = argv[i + 1]
      if (canUseAsFlagValue(next, key, command)) {
        flags[key] = next
        i += 2
        continue
      }
      flags[key] = true
      i += 1
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1)
      if (SHORT_BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
        i += 1
        continue
      }
      const next = argv[i + 1]
      if (canUseAsFlagValue(next, key, command)) {
        flags[key] = next
        i += 2
        continue
      }
      flags[key] = true
      i += 1
      continue
    }

    args.push(token)
    i += 1
  }

  return { command, flags, args }
}
