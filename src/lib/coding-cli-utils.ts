import type { CodingCliProviderName } from './coding-cli-types'

export type CodingCliProviderConfig = {
  name: CodingCliProviderName
  label: string
  supportsModel?: boolean
  supportsSandbox?: boolean
  supportsPermissionMode?: boolean
}

export const CODING_CLI_PROVIDERS: CodingCliProviderName[] = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'kimi',
]

export const CODING_CLI_PROVIDER_LABELS: Record<CodingCliProviderName, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  kimi: 'Kimi',
}

export const CODING_CLI_PROVIDER_CONFIGS: CodingCliProviderConfig[] = [
  {
    name: 'claude',
    label: CODING_CLI_PROVIDER_LABELS.claude,
    supportsPermissionMode: true,
  },
  {
    name: 'codex',
    label: CODING_CLI_PROVIDER_LABELS.codex,
    supportsModel: true,
    supportsSandbox: true,
  },
]

export type ResumeCommandProvider = Extract<CodingCliProviderName, 'claude' | 'codex'>

export function isCodingCliProviderName(value?: string): value is CodingCliProviderName {
  if (!value) return false
  return CODING_CLI_PROVIDERS.includes(value as CodingCliProviderName)
}

export function isResumeCommandProvider(value?: string): value is ResumeCommandProvider {
  return value === 'claude' || value === 'codex'
}

export function buildResumeCommand(provider?: string, sessionId?: string): string | null {
  if (!sessionId) return null
  if (!isResumeCommandProvider(provider)) return null
  if (provider === 'claude') return `claude --resume ${sessionId}`
  return `codex resume ${sessionId}`
}

export function isCodingCliMode(mode?: string): mode is CodingCliProviderName {
  if (!mode || mode === 'shell') return false
  return isCodingCliProviderName(mode)
}

export function getProviderLabel(provider?: string) {
  if (!provider) return 'CLI'
  const label = CODING_CLI_PROVIDER_LABELS[provider as CodingCliProviderName]
  return label || provider.toUpperCase()
}
