export const QUALIFICATION_PROVIDER_SELECTION_ENV =
  'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS'

export const QUALIFIABLE_TERMINAL_PROVIDERS = [
  'claude',
  'codex',
  'opencode',
  'amplifier',
] as const

export type QualifiableTerminalProvider = typeof QUALIFIABLE_TERMINAL_PROVIDERS[number]

/**
 * Parse the exact live-provider subset requested by an operator. There is no
 * `all` shorthand: a campaign must name every provider it is prepared to bill
 * and bootstrap, and can therefore qualify Claude or Codex without Amplifier.
 */
export function parseQualificationProviderSelection(
  value: string,
): QualifiableTerminalProvider[] {
  if (!value) throw selectionError('must name at least one provider')
  const allowed = new Set<string>(QUALIFIABLE_TERMINAL_PROVIDERS)
  const seen = new Set<string>()
  const selected: QualifiableTerminalProvider[] = []
  for (const provider of value.split(',')) {
    if (!provider || provider.trim() !== provider || !allowed.has(provider)) {
      throw selectionError(`contains unsupported provider ${JSON.stringify(provider)}`)
    }
    if (seen.has(provider)) throw selectionError(`contains duplicate provider ${provider}`)
    seen.add(provider)
    selected.push(provider as QualifiableTerminalProvider)
  }
  return selected
}

function selectionError(detail: string): Error {
  return new Error(
    `${QUALIFICATION_PROVIDER_SELECTION_ENV} ${detail}; allowed values are ${QUALIFIABLE_TERMINAL_PROVIDERS.join(',')}`,
  )
}
