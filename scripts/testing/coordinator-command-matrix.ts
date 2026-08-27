export type SuiteKey =
  | 'full-suite'
  | 'default:coverage'
  | 'default:test/unit'
  | 'default:test/unit/client'
  | 'rust:server'
  | 'rust:integration'

export type CommandKey =
  | 'test'
  | 'test:all'
  | 'check'
  | 'verify'
  | 'test:watch'
  | 'test:ui'
  | 'test:server'
  | 'test:coverage'
  | 'test:unit'
  | 'test:integration'
  | 'test:client'
  | 'test:vitest'

export const COMMAND_KEYS = [
  'test',
  'test:all',
  'check',
  'verify',
  'test:watch',
  'test:ui',
  'test:server',
  'test:coverage',
  'test:unit',
  'test:integration',
  'test:client',
  'test:vitest',
] as const satisfies readonly CommandKey[]

export type CoordinatorInput = {
  commandKey: CommandKey
  forwardedArgs: string[]
}

export type UpstreamPhase =
  | {
    runner: 'vitest'
    config: 'default' | 'electron' | 'runtime' | 'direct'
    args: string[]
  }
  | {
    runner: 'npm'
    script: 'typecheck' | 'build' | 'test:balanced'
    args: string[]
  }
  | {
    runner: 'cargo'
    args: string[]
  }

export type CommandDisposition =
  | { kind: 'coordinated'; suiteKey?: SuiteKey; phases: UpstreamPhase[] }
  | { kind: 'delegated'; phases: UpstreamPhase[] }
  | { kind: 'passthrough'; phases: UpstreamPhase[] }
  | { kind: 'rejected'; reason: string }

const COMPOSITE_COMMANDS = new Set<CommandKey>(['test', 'test:all', 'check', 'verify'])
const DEFAULT_VITEST_CONFIG = 'config/vitest/vitest.config.ts'
const ELECTRON_VITEST_CONFIG = 'config/vitest/vitest.electron.config.ts'
const RUNTIME_VITEST_CONFIG = 'config/vitest/vitest.runtime.config.ts'

export function classifyCommand(input: CoordinatorInput): CommandDisposition {
  const args = stripLeadingArgSeparator(input.forwardedArgs)

  if (input.commandKey === 'test:vitest') {
    if (args.some((arg) => isRetiredServerConfigSelector(arg))) {
      return {
        kind: 'rejected',
        reason: 'The Node server Vitest config was retired. Use npm run test:server for the Rust cargo lane.',
      }
    }
    return passthrough([vitestPhase('direct', args)])
  }

  if (hasExplicitConfigOverride(args)) {
    return {
      kind: 'rejected',
      reason: 'Public test commands do not accept --config overrides. Use npm run test:vitest -- ... for direct Vitest config control.',
    }
  }

  if (hasHelpOrVersion(args)) return classifyHelpOrVersion(input.commandKey, args)
  if (COMPOSITE_COMMANDS.has(input.commandKey)) return classifyCompositeCommand(input.commandKey, args)
  return classifySinglePhaseCommand(input.commandKey, args)
}

function isRetiredServerConfigSelector(arg: string): boolean {
  return /(?:^|[/=])server\.config(?:\.|$)/.test(arg)
    || /(?:^|[/=])server(?:$|\.)/.test(arg)
}

export function isCommandKey(value: string): value is CommandKey {
  return (COMMAND_KEYS as readonly string[]).includes(value)
}

function classifyHelpOrVersion(commandKey: CommandKey, args: string[]): CommandDisposition {
  if (commandKey === 'test:vitest') return passthrough([vitestPhase('direct', args)])
  if (COMPOSITE_COMMANDS.has(commandKey)) return passthrough([vitestPhase('default', ['--config', DEFAULT_VITEST_CONFIG, ...args])])
  if (commandKey === 'test:server') return passthrough([cargoPhase(['test', '-p', 'freshell-server', '--locked', ...args])])
  if (commandKey === 'test:integration') return passthrough([cargoPhase(['test', '--workspace', '--tests', '--locked', ...args])])
  return passthrough([vitestPhase('default', ['--config', DEFAULT_VITEST_CONFIG, ...args])])
}

function classifyCompositeCommand(commandKey: CommandKey, args: string[]): CommandDisposition {
  if (hasReporter(args)) {
    return {
      kind: 'rejected',
      reason: 'Composite commands do not support --reporter. Split the command into one truthful config-specific invocation.',
    }
  }

  const filtered = removeCompositeCompatibilityFlags(args)
  const targets = extractTargets(filtered)
  if (targets.length > 0) {
    const hasRustTarget = targets.some((target) => isRustTarget(target))
    const hasClientTarget = targets.some((target) => !isRustTarget(target))
    if (hasRustTarget && hasClientTarget) {
      return {
        kind: 'rejected',
        reason: 'Mixed client and Rust selectors are not supported here. Please split the command by lane.',
      }
    }
    if (hasRustTarget) {
      return delegated([cargoPhase(['test', '--workspace', '--locked', ...filtered])])
    }
    return delegated([vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, ...filtered])])
  }

  if (isBroadCompositeWorkload(filtered)) {
    return coordinated('full-suite', [npmPhase('test:balanced', filtered)])
  }
  return delegated([vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, ...filtered])])
}

function classifySinglePhaseCommand(
  commandKey: Exclude<CommandKey, 'test' | 'test:all' | 'check' | 'verify'>,
  args: string[],
): CommandDisposition {
  switch (commandKey) {
    case 'test:server':
      return args.length === 0 || isExplicitBroadCargoRun(args)
        ? coordinated('rust:server', [cargoPhase(['test', '-p', 'freshell-server', '--locked', ...withoutCargoFlags(args)])])
        : delegated([cargoPhase(['test', '-p', 'freshell-server', '--locked', ...withoutCargoFlags(args)])])
    case 'test:integration':
      return args.length === 0 || isExplicitBroadCargoRun(args)
        ? coordinated('rust:integration', [cargoPhase(['test', '--workspace', '--tests', '--locked', ...withoutCargoFlags(args)])])
        : delegated([cargoPhase(['test', '--workspace', '--tests', '--locked', ...withoutCargoFlags(args)])])
    case 'test:coverage':
      return coordinated('default:coverage', [vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, '--coverage', ...args])])
    case 'test:unit':
      return args.length === 0
        ? coordinated('default:test/unit', [vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, 'test/unit'])])
        : delegated([vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, ...args])])
    case 'test:client':
      return args.length === 0
        ? coordinated('default:test/unit/client', [vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, 'test/unit/client'])])
        : delegated([vitestPhase('default', ['run', '--config', DEFAULT_VITEST_CONFIG, ...args])])
    case 'test:watch':
      return passthrough([vitestPhase('default', ['--config', DEFAULT_VITEST_CONFIG, ...args])])
    case 'test:ui':
      return passthrough([vitestPhase('default', ['--config', DEFAULT_VITEST_CONFIG, '--ui', ...args])])
    default:
      return passthrough([vitestPhase('default', ['--config', DEFAULT_VITEST_CONFIG, ...args])])
  }
}

function isExplicitBroadCargoRun(args: string[]): boolean {
  return args.includes('--run') && !extractTargets(args).length
}

function withoutCargoFlags(args: string[]): string[] {
  return args.filter((arg) => arg !== '--run')
}

function stripLeadingArgSeparator(args: string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args]
}

function removeCompositeCompatibilityFlags(args: string[]): string[] {
  return args.filter((arg) => arg !== '--run')
}

function hasHelpOrVersion(args: string[]): boolean {
  return args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v')
}

function hasReporter(args: string[]): boolean {
  return args.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='))
}

function hasExplicitConfigOverride(args: string[]): boolean {
  return args.some((arg) => arg === '--config' || arg.startsWith('--config=') || arg === '-c' || arg.startsWith('-c='))
}

function isBroadCompositeWorkload(args: string[]): boolean {
  return !extractTargets(args).length && !args.some((arg) => arg === '--changed' || arg.startsWith('--changed='))
}

function extractTargets(args: string[]): string[] {
  const targets: string[] = []
  const valueFlags = new Set(['-t', '--testNamePattern', '--reporter', '--config', '-c', '--bail', '--changed'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue
    if (valueFlags.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('--testNamePattern=') || arg.startsWith('--reporter=') || arg.startsWith('--config=') || arg.startsWith('-c=')) continue
    if (arg.startsWith('-')) continue
    targets.push(arg)
  }
  return targets
}

function isRustTarget(target: string): boolean {
  const normalized = target.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  return normalized === 'test/server'
    || normalized.startsWith('test/server/')
    || normalized.startsWith('test/integration/server/')
    || normalized.startsWith('crates/')
}

function coordinated(suiteKey: SuiteKey, phases: UpstreamPhase[]): CommandDisposition {
  return { kind: 'coordinated', suiteKey, phases }
}

function delegated(phases: UpstreamPhase[]): CommandDisposition {
  return { kind: 'delegated', phases }
}

function passthrough(phases: UpstreamPhase[]): CommandDisposition {
  return { kind: 'passthrough', phases }
}

function vitestPhase(config: 'default' | 'electron' | 'runtime' | 'direct', args: string[]): UpstreamPhase {
  return { runner: 'vitest', config, args }
}

function npmPhase(script: 'typecheck' | 'build' | 'test:balanced', args: string[]): UpstreamPhase {
  return { runner: 'npm', script, args }
}

function cargoPhase(args: string[]): UpstreamPhase {
  return { runner: 'cargo', args }
}

export const RUNTIME_VITEST_CONFIG_PATH = RUNTIME_VITEST_CONFIG
export const DEFAULT_VITEST_CONFIG_PATH = DEFAULT_VITEST_CONFIG
export const ELECTRON_VITEST_CONFIG_PATH = ELECTRON_VITEST_CONFIG
