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

type BuildResumeCommandOptions = {
  cwd?: string
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

  const templateUsesCwd = ext.cli.resumeCommandTemplate.some((arg) => arg.includes('{{cwd}}'))
  const args = ext.cli.resumeCommandTemplate.map((arg) => (
    arg
      .replaceAll('{{sessionId}}', sessionId)
      .replaceAll('{{cwd}}', cwd ?? '')
  ))
  const command = args.map(quoteResumeCommandArg).join(' ')

  if (requiresCwd && cwd && !templateUsesCwd) {
    return `cd ${quoteResumeCommandArg(cwd)} && ${command}`
  }

  return command
}

function quoteResumeCommandArg(arg: string): string {
  if (arg.length === 0) return "''"
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) {
    return arg
  }
  return `'${arg.replace(/'/g, `'"'"'`)}'`
}
