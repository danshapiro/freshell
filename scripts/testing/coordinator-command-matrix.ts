export type SuiteKey =
  | 'full-suite'
  | 'default:coverage'
  | 'default:test/unit'
  | 'default:test/unit/client'
  | 'server:test/server'
  | 'server:all:run'

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
    config: 'default' | 'server'
    args: string[]
  }
  | {
    runner: 'npm'
    script: 'typecheck' | 'build' | 'test:balanced'
    args: string[]
  }

export type CommandDisposition =
  | { kind: 'coordinated'; suiteKey?: SuiteKey; phases: UpstreamPhase[] }
  | { kind: 'delegated'; phases: UpstreamPhase[] }
  | { kind: 'passthrough'; phases: UpstreamPhase[] }
  | { kind: 'rejected'; reason: string }

type SinglePhaseSpec = {
  owner: 'default' | 'server'
  broadSuiteKey?: SuiteKey
  broadArgs: string[]
  delegatedArgs?: string[]
  passthroughKind?: 'delegated' | 'passthrough'
}

const COMPOSITE_COMMANDS = new Set<CommandKey>(['test', 'test:all', 'check', 'verify'])
const SINGLE_PHASE_SPECS: Record<Exclude<CommandKey, 'test' | 'test:all' | 'check' | 'verify'>, SinglePhaseSpec> = {
  'test:watch': {
    owner: 'default',
    broadArgs: [],
    passthroughKind: 'passthrough',
  },
  'test:ui': {
    owner: 'default',
    broadArgs: ['--ui'],
    passthroughKind: 'passthrough',
  },
  'test:server': {
    owner: 'server',
    broadSuiteKey: 'server:all:run',
    broadArgs: ['--config', 'vitest.server.config.ts', '--run'],
    delegatedArgs: ['--config', 'vitest.server.config.ts'],
  },
  'test:coverage': {
    owner: 'default',
    broadSuiteKey: 'default:coverage',
    broadArgs: ['run', '--coverage'],
  },
  'test:unit': {
    owner: 'default',
    broadSuiteKey: 'default:test/unit',
    broadArgs: ['run', 'test/unit'],
  },
  'test:integration': {
    owner: 'server',
    broadSuiteKey: 'server:test/server',
    broadArgs: ['run', '--config', 'vitest.server.config.ts', 'test/server'],
  },
  'test:client': {
    owner: 'default',
    broadSuiteKey: 'default:test/unit/client',
    broadArgs: ['run', 'test/unit/client'],
  },
  'test:vitest': {
    owner: 'default',
    broadArgs: [],
    passthroughKind: 'passthrough',
  },
}

type CompositeTargetAnalysis =
  | { kind: 'none' }
  | { kind: 'default' | 'server' }
  | { kind: 'cross-config'; suiteKey?: SuiteKey }
  | { kind: 'mixed' }

const TARGET_VALUE_FLAGS = new Set(['-t', '--testNamePattern', '--reporter', '--config', '-c', '--bail', '--changed'])

export function classifyCommand(input: CoordinatorInput): CommandDisposition {
  const normalizedArgs = stripLeadingArgSeparator(input.forwardedArgs)

  if (input.commandKey === 'test:vitest') {
    return passthrough([buildVitestPassthroughPhase(normalizedArgs)])
  }

  if (hasExplicitConfigOverride(normalizedArgs)) {
    return {
      kind: 'rejected',
      reason: 'Public test commands do not accept --config overrides. Use npm run test:vitest -- ... for direct Vitest config control.',
    }
  }

  if (hasHelpOrVersion(normalizedArgs)) {
    return classifyHelpOrVersion(input.commandKey, normalizedArgs)
  }

  if (COMPOSITE_COMMANDS.has(input.commandKey)) {
    return classifyCompositeCommand(input.commandKey, normalizedArgs)
  }

  return classifySinglePhaseCommand(input.commandKey, normalizedArgs)
}

export function isCommandKey(value: string): value is CommandKey {
  return (COMMAND_KEYS as readonly string[]).includes(value)
}

function classifyHelpOrVersion(commandKey: CommandKey, normalizedArgs: string[]): CommandDisposition {
  if (commandKey === 'test:vitest') {
    return passthrough([buildVitestPassthroughPhase(normalizedArgs)])
  }

  if (COMPOSITE_COMMANDS.has(commandKey)) {
    const targetOwnership = classifyTargetOwnership(normalizedArgs)
    const owner = targetOwnership === 'server' ? 'server' : 'default'
    return passthrough([vitestPhase(owner, [...ownerRunPrefix(owner), ...normalizedArgs])])
  }

  const spec = SINGLE_PHASE_SPECS[commandKey]
  if (spec.passthroughKind === 'passthrough') {
    return passthrough([buildSinglePhasePassthroughPhase(commandKey, normalizedArgs)])
  }

  return passthrough([buildSinglePhaseDelegatedPhase(commandKey, normalizedArgs)])
}

function classifyCompositeCommand(commandKey: CommandKey, args: string[]): CommandDisposition {
  if (hasReporter(args)) {
    return {
      kind: 'rejected',
      reason: 'Composite commands do not support --reporter. Split the command into one truthful config-specific invocation.',
    }
  }

  const filteredArgs = removeCompositeCompatibilityFlags(args)
  const targetAnalysis = analyzeCompositeTargets(filteredArgs)

  if (targetAnalysis.kind === 'mixed') {
    return {
      kind: 'rejected',
      reason: 'Mixed client and server selectors are not supported here. Please split the command by config owner.',
    }
  }

  if (targetAnalysis.kind === 'cross-config') {
    return coordinated(targetAnalysis.suiteKey, [
      npmPhase('test:balanced', filteredArgs),
    ])
  }

  if (targetAnalysis.kind === 'server') {
    return delegated([
      vitestPhase('server', ['run', '--config', 'vitest.server.config.ts', ...filteredArgs]),
    ])
  }

  if (targetAnalysis.kind === 'default') {
    return delegated([
      vitestPhase('default', ['run', ...filteredArgs]),
    ])
  }

  if (isBroadCompositeWorkload(filteredArgs)) {
    return coordinated(coordinatedSuiteKeyForCompositeWorkload(filteredArgs), [
      npmPhase('test:balanced', filteredArgs),
    ])
  }

  return delegated([
    vitestPhase('default', ['run', ...filteredArgs]),
  ])
}

function classifySinglePhaseCommand(commandKey: Exclude<CommandKey, 'test' | 'test:all' | 'check' | 'verify'>, args: string[]): CommandDisposition {
  const spec = SINGLE_PHASE_SPECS[commandKey]

  if (spec.passthroughKind === 'passthrough') {
    return passthrough([buildSinglePhasePassthroughPhase(commandKey, args)])
  }

  if (hasWatchOrUi(args)) {
    return delegated([buildSinglePhaseDelegatedPhase(commandKey, args)])
  }

  if (commandKey === 'test:server' && isExplicitBroadServerRun(args)) {
    return coordinated(suiteKeyForSinglePhaseWorkload(spec, args), [
      vitestPhase('server', buildBroadSinglePhaseArgs(spec, args)),
    ])
  }

  if (commandKey === 'test:server' && args.length === 0) {
    return delegated([vitestPhase('server', singlePhaseDelegatedBaseArgs(spec))])
  }

  if (isBroadSinglePhaseWorkload(commandKey, args) && spec.broadSuiteKey) {
    return coordinated(suiteKeyForSinglePhaseWorkload(spec, args), [
      vitestPhase(spec.owner, buildBroadSinglePhaseArgs(spec, args)),
    ])
  }

  return delegated([buildSinglePhaseDelegatedPhase(commandKey, args)])
}

function buildSinglePhasePassthroughPhase(
  commandKey: Exclude<CommandKey, 'test' | 'test:all' | 'check' | 'verify'>,
  args: string[],
): UpstreamPhase {
  const spec = SINGLE_PHASE_SPECS[commandKey]
  const targetOwnership = classifyTargetOwnership(args)

  if (targetOwnership === 'mixed') {
    throw new Error('Mixed config ownership is not supported in a single passthrough phase.')
  }

  if (targetOwnership && targetOwnership !== spec.owner) {
    return vitestPhase(targetOwnership, [...singlePhasePassthroughTargetBaseArgs(spec, targetOwnership), ...args])
  }

  return vitestPhase(spec.owner, [...spec.broadArgs, ...args])
}

function buildSinglePhaseDelegatedPhase(
  commandKey: Exclude<CommandKey, 'test' | 'test:all' | 'check' | 'verify'>,
  args: string[],
): UpstreamPhase {
  const spec = SINGLE_PHASE_SPECS[commandKey]
  const targetOwnership = classifyTargetOwnership(args)

  if (targetOwnership === 'mixed') {
    throw new Error('Mixed config ownership is not supported in a single delegated phase.')
  }

  if (targetOwnership && targetOwnership !== spec.owner) {
    return vitestPhase(targetOwnership, [...ownerRunPrefix(targetOwnership), ...args])
  }

  if (targetOwnership === spec.owner) {
    return vitestPhase(spec.owner, [...singlePhaseTargetBaseArgs(spec), ...args])
  }

  return vitestPhase(spec.owner, [...singlePhaseDelegatedBaseArgs(spec), ...args])
}

function stripLeadingArgSeparator(args: string[]): string[] {
  if (args[0] === '--') {
    return args.slice(1)
  }
  return [...args]
}

function removeCompositeCompatibilityFlags(args: string[]): string[] {
  return args.filter((arg) => arg !== '--run')
}

function hasHelpOrVersion(args: string[]): boolean {
  return args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v')
}

function hasWatchOrUi(args: string[]): boolean {
  return args.some((arg) => arg === '--watch' || arg === '-w' || arg === '--ui')
}

function hasNamePattern(args: string[]): boolean {
  return args.some((arg) => arg === '-t' || arg === '--testNamePattern' || arg.startsWith('--testNamePattern='))
}

function hasReporter(args: string[]): boolean {
  return args.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='))
}

function hasExplicitConfigOverride(args: string[]): boolean {
  return args.some((arg) => (
    arg === '--config'
    || arg.startsWith('--config=')
    || arg === '-c'
    || arg.startsWith('-c=')
  ))
}

function isExplicitBroadServerRun(args: string[]): boolean {
  if (!args.includes('--run')) return false
  return !hasNarrowingSelectors(args)
}

function isBroadCompositeWorkload(args: string[]): boolean {
  return !hasNarrowingSelectors(args)
}

function isBroadSinglePhaseWorkload(
  commandKey: Exclude<CommandKey, 'test' | 'test:all' | 'check' | 'verify'>,
  args: string[],
): boolean {
  if (commandKey === 'test:server') {
    return isExplicitBroadServerRun(args)
  }

  return !hasNarrowingSelectors(args)
}

function hasNarrowingSelectors(args: string[]): boolean {
  return hasWatchOrUi(args) || hasNamePattern(args) || extractTargets(args).length > 0
}

function buildBroadSinglePhaseArgs(spec: SinglePhaseSpec, args: string[]): string[] {
  if (spec.owner === 'server' && args.includes('--run')) {
    const extraArgs = args.filter((arg) => arg !== '--run')
    return [...spec.broadArgs, ...extraArgs]
  }

  return [...spec.broadArgs, ...args]
}

function suiteKeyForSinglePhaseWorkload(spec: SinglePhaseSpec, args: string[]): SuiteKey | undefined {
  return hasPartialSelectionFlags(args) ? undefined : spec.broadSuiteKey
}

function coordinatedSuiteKeyForCompositeWorkload(args: string[]): SuiteKey | undefined {
  return hasPartialSelectionFlags(args) ? undefined : 'full-suite'
}

function hasPartialSelectionFlags(args: string[]): boolean {
  return args.some((arg) => arg === '--changed' || arg.startsWith('--changed='))
}

function analyzeCompositeTargets(args: string[]): CompositeTargetAnalysis {
  const classifications = extractTargets(args)
    .map(classifyCompositeTarget)
    .filter((classification): classification is NonNullable<ReturnType<typeof classifyCompositeTarget>> => classification !== undefined)

  if (classifications.length === 0) {
    return { kind: 'none' }
  }

  const unique = new Set(classifications)
  if (unique.size === 1) {
    const [only] = unique
    if (only === 'full-suite') {
      return { kind: 'cross-config', suiteKey: 'full-suite' }
    }
    if (only === 'cross-config') {
      return { kind: 'cross-config' }
    }
    return { kind: only }
  }

  const includesCrossConfig = unique.has('cross-config') || unique.has('full-suite')
  if (includesCrossConfig) {
    const onlyCrossConfig = [...unique].every((classification) => classification === 'cross-config' || classification === 'full-suite')
    if (onlyCrossConfig) {
      return { kind: 'cross-config' }
    }
    return { kind: 'mixed' }
  }

  return { kind: 'mixed' }
}

function classifyTargetOwnership(args: string[]): 'default' | 'server' | 'mixed' | undefined {
  const ownerships = extractTargets(args)
    .map(classifyTarget)
    .filter((owner): owner is 'default' | 'server' => owner !== undefined)

  if (ownerships.length === 0) {
    return undefined
  }

  const unique = new Set(ownerships)
  if (unique.size > 1) {
    return 'mixed'
  }

  return ownerships[0]
}

function extractTargets(args: string[]): string[] {
  const targets: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue

    if (TARGET_VALUE_FLAGS.has(arg)) {
      index += 1
      continue
    }

    if (
      arg.startsWith('--testNamePattern=')
      || arg.startsWith('--reporter=')
      || arg.startsWith('--config=')
      || arg.startsWith('-c=')
    ) {
      continue
    }

    if (arg.startsWith('-')) {
      continue
    }

    targets.push(arg)
  }

  return targets
}

function classifyTarget(target: string): 'default' | 'server' | undefined {
  const normalizedTarget = normalizeTargetForOwnership(target)

  if (
    normalizedTarget === 'test/server'
    || normalizedTarget.startsWith('test/server/')
    || normalizedTarget === 'test/unit/server'
    || normalizedTarget.startsWith('test/unit/server/')
    || normalizedTarget === 'test/integration/server'
    || normalizedTarget.startsWith('test/integration/server/')
    || normalizedTarget === 'test/integration/session-repair.test.ts'
    || normalizedTarget === 'test/integration/session-search-e2e.test.ts'
    || normalizedTarget === 'test/integration/extension-system.test.ts'
  ) {
    return 'server'
  }

  if (normalizedTarget.startsWith('test/')) {
    return 'default'
  }

  return undefined
}

function classifyCompositeTarget(target: string): 'default' | 'server' | 'cross-config' | 'full-suite' | undefined {
  const normalizedTarget = normalizeTargetForOwnership(target)

  if (normalizedTarget === 'test') {
    return 'full-suite'
  }

  if (normalizedTarget === 'test/unit' || normalizedTarget === 'test/integration') {
    return 'cross-config'
  }

  return classifyTarget(target)
}

function normalizeTargetForOwnership(target: string): string {
  return target
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')
}

function ownerRunPrefix(owner: 'default' | 'server'): string[] {
  if (owner === 'server') {
    return ['run', '--config', 'vitest.server.config.ts']
  }
  return ['run']
}

function singlePhaseDelegatedBaseArgs(spec: SinglePhaseSpec): string[] {
  return spec.delegatedArgs ? [...spec.delegatedArgs] : [...spec.broadArgs]
}

function singlePhaseTargetBaseArgs(spec: SinglePhaseSpec): string[] {
  return spec.delegatedArgs ? [...spec.delegatedArgs] : [...ownerRunPrefix(spec.owner)]
}

function singlePhasePassthroughTargetBaseArgs(spec: SinglePhaseSpec, owner: 'default' | 'server'): string[] {
  if (owner === 'server') {
    return ['--config', 'vitest.server.config.ts', ...spec.broadArgs]
  }
  return [...spec.broadArgs]
}

function coordinated(suiteKey: SuiteKey | undefined, phases: UpstreamPhase[]): CommandDisposition {
  return { kind: 'coordinated', suiteKey, phases }
}

function delegated(phases: UpstreamPhase[]): CommandDisposition {
  return { kind: 'delegated', phases }
}

function passthrough(phases: UpstreamPhase[]): CommandDisposition {
  return { kind: 'passthrough', phases }
}

function buildVitestPassthroughPhase(args: string[]): UpstreamPhase {
  if (hasExplicitConfigOverride(args)) {
    return vitestPhase(inferVitestConfig(args), args)
  }

  const owner = classifyTargetOwnership(args)
  if (owner === 'server') {
    return vitestPhase('server', ['run', '--config', 'vitest.server.config.ts', ...args])
  }

  return vitestPhase('default', args)
}

function vitestPhase(config: 'default' | 'server', args: string[]): UpstreamPhase {
  return {
    runner: 'vitest',
    config,
    args,
  }
}

function npmPhase(script: 'typecheck' | 'build' | 'test:balanced', args: string[]): UpstreamPhase {
  return {
    runner: 'npm',
    script,
    args,
  }
}

function inferVitestConfig(args: string[]): 'default' | 'server' {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--config' || arg === '-c') {
      return isServerConfigArg(args[index + 1]) ? 'server' : 'default'
    }

    if (arg.startsWith('--config=')) {
      return isServerConfigArg(arg.slice('--config='.length)) ? 'server' : 'default'
    }

    if (arg.startsWith('-c=')) {
      return isServerConfigArg(arg.slice('-c='.length)) ? 'server' : 'default'
    }
  }

  return 'default'
}

function isServerConfigArg(value: string | undefined): boolean {
  if (!value) {
    return false
  }

  const normalized = value.replaceAll('\\', '/')
  return normalized === 'vitest.server.config.ts' || normalized.endsWith('/vitest.server.config.ts')
}
