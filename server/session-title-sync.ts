import type { CodingCliProviderName } from './coding-cli/types.js'

const DEFAULT_PROVIDER_TITLES: Partial<Record<CodingCliProviderName, string[]>> = {
  claude: ['Claude', 'Claude CLI'],
  codex: ['Codex', 'Codex CLI'],
  opencode: ['OpenCode'],
  gemini: ['Gemini'],
  kimi: ['Kimi'],
}

export function shouldPromoteSessionTitle(
  currentTitle: string | undefined,
  provider: CodingCliProviderName,
): boolean {
  if (!currentTitle) return true
  const defaults = DEFAULT_PROVIDER_TITLES[provider] ?? ['CLI']
  return defaults.includes(currentTitle)
}
