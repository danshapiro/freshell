import type { CodingCliProviderName } from './coding-cli-types'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { sessionKeyRequiresCwdScope } from './coding-cli-session-key'

// REMOVED: CODING_CLI_PROVIDERS, CODING_CLI_PROVIDER_LABELS, CODING_CLI_PROVIDER_CONFIGS
// These are now derived from extension entries in Redux state.

export type CodingCliProviderConfig = {
  name: CodingCliProviderName
  label: string
  supportsModel?: boolean
  supportsSandbox?: boolean
  supportsPermissionMode?: boolean
}

export function getCliProviderConfigs(extensions: ClientExtensionEntry[]): CodingCliProviderConfig[] {
  return extensions
    .filter(e => e.category === 'cli')
    .map(e => ({
      name: e.name,
      label: e.label,
      supportsPermissionMode: e.cli?.supportsPermissionMode,
      supportsModel: e.cli?.supportsModel,
      supportsSandbox: e.cli?.supportsSandbox,
    }))
}

export function getCliProviders(extensions: ClientExtensionEntry[]): CodingCliProviderName[] {
  return extensions
    .filter(e => e.category === 'cli')
    .map(e => e.name)
}

export function getProviderLabel(provider?: string, extensions?: ClientExtensionEntry[]): string {
  if (!provider) return 'CLI'
  const ext = extensions?.find(e => e.name === provider && e.category === 'cli')
  if (ext) return ext.label
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function isCodingCliProviderName(value?: string, extensions?: ClientExtensionEntry[]): value is CodingCliProviderName {
  if (!value) return false
  if (!extensions) return false
  return extensions.some(e => e.category === 'cli' && e.name === value)
}

export function isCodingCliMode(mode?: string, extensions?: ClientExtensionEntry[]): boolean {
  if (!mode || mode === 'shell') return false
  return isCodingCliProviderName(mode, extensions)
}

/**
 * Lenient check for non-shell terminal modes.
 * Unlike isCodingCliMode (which validates against the extension registry),
 * this simply checks that mode is not 'shell'. Use in contexts where the mode
 * was already validated at creation time (e.g. Redux reducers, display logic).
 */
export function isNonShellMode(mode?: string): boolean {
  return !!mode && mode !== 'shell'
}

export type ResumeCommandProvider = string
export type ResumeCommandShell = 'system' | 'cmd' | 'powershell' | 'wsl'

export type BuildResumeCommandOptions = {
  cwd?: string
  platform?: string | null
  shell?: ResumeCommandShell
}

export function isResumeCommandProvider(value?: string, extensions?: ClientExtensionEntry[]): value is ResumeCommandProvider {
  if (!value) return false
  if (!extensions) return false
  const ext = extensions.find(e => e.name === value && e.category === 'cli')
  return !!ext?.cli?.supportsResume
}

/**
 * Build a resume command string from extension manifest data.
 * Uses the resumeCommandTemplate from the extension's cli config,
 * replacing {{sessionId}} with the actual session ID.
 * Returns null if the provider doesn't support resume or isn't found.
 */
export function buildResumeCommand(
  provider?: string,
  sessionId?: string,
  extensions?: ClientExtensionEntry[],
  options?: BuildResumeCommandOptions,
): string | null {
  if (!sessionId || !provider) return null
  const ext = extensions?.find(e => e.name === provider && e.category === 'cli')
  if (!ext?.cli?.resumeCommandTemplate) return null
  const cwd = options?.cwd?.trim()
  const requiresCwd = sessionKeyRequiresCwdScope(provider)
  if (requiresCwd && !cwd) return null

  const shell = resolveResumeShell(options?.platform ?? null, options?.shell)
  const templateUsesCwd = ext.cli.resumeCommandTemplate.some((arg) => arg.includes('{{cwd}}'))
  const args = ext.cli.resumeCommandTemplate.map((arg) => (
    arg
      .replaceAll('{{sessionId}}', sessionId)
      .replaceAll('{{cwd}}', cwd ?? '')
  ))
  const command = buildShellCommand(args, shell)

  if (requiresCwd && cwd && !templateUsesCwd) {
    if (shell === 'cmd') {
      return `cd /d ${quoteCmdCommandArg(cwd)} && ${command}`
    }
    if (shell === 'powershell') {
      return `Set-Location -LiteralPath ${quotePowerShellLiteral(cwd)}; ${command}`
    }
    return `cd ${quotePosixCommandArg(cwd)} && ${command}`
  }

  return command
}

function resolveResumeShell(platform: string | null, shell?: ResumeCommandShell): ResumeCommandShell {
  if (shell === 'cmd' || shell === 'powershell' || shell === 'wsl') {
    return shell
  }
  if (platform === 'win32') {
    return 'cmd'
  }
  return 'system'
}

function buildShellCommand(args: string[], shell: ResumeCommandShell): string {
  if (shell === 'cmd') {
    return args.map(quoteCmdCommandArg).join(' ')
  }
  if (shell === 'powershell') {
    return ['&', quotePowerShellLiteral(args[0] || ''), ...args.slice(1).map(quotePowerShellLiteral)].join(' ')
  }
  return args.map(quotePosixCommandArg).join(' ')
}

function quotePosixCommandArg(arg: string): string {
  if (arg.length === 0) return "''"
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) {
    return arg
  }
  return `'${arg.replace(/'/g, `'"'"'`)}'`
}

function quoteCmdCommandArg(arg: string): string {
  if (/^[A-Za-z0-9_./@%+=,-]+$/.test(arg)) {
    return arg
  }

  const escaped = arg.replace(/%/g, '%%')
  let quoted = '"'
  let backslashCount = 0
  for (const ch of escaped) {
    if (ch === '\\') {
      backslashCount += 1
      continue
    }

    if (ch === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1)
      quoted += '"'
      backslashCount = 0
      continue
    }

    if (backslashCount > 0) {
      quoted += '\\'.repeat(backslashCount)
      backslashCount = 0
    }
    quoted += ch
  }

  if (backslashCount > 0) {
    quoted += '\\'.repeat(backslashCount * 2)
  }

  quoted += '"'
  return quoted
}

function quotePowerShellLiteral(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`
}
