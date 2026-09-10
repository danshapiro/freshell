export const FRESH_AGENT_QUALIFICATION_MODES_ENV =
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES'

export const QUALIFIABLE_FRESH_AGENT_MODES = [
  'freshclaude',
  'kilroy',
  'freshcodex',
  'freshopencode',
] as const

export type QualifiableFreshAgentMode = typeof QUALIFIABLE_FRESH_AGENT_MODES[number]

/**
 * Parse an operator's exact billable live-mode selection before any workload
 * is constructed. There is deliberately no alias and no `all` shorthand.
 */
export function parseFreshAgentQualificationModes(
  value: string,
): QualifiableFreshAgentMode[] {
  if (!value) throw selectionError('must name at least one mode')
  const allowed = new Set<string>(QUALIFIABLE_FRESH_AGENT_MODES)
  const selected: QualifiableFreshAgentMode[] = []
  const seen = new Set<string>()
  for (const mode of value.split(',')) {
    if (!mode || mode.trim() !== mode || !allowed.has(mode)) {
      throw selectionError(`contains unsupported mode ${JSON.stringify(mode)}`)
    }
    if (seen.has(mode)) throw selectionError(`contains duplicate mode ${mode}`)
    seen.add(mode)
    selected.push(mode as QualifiableFreshAgentMode)
  }
  return selected
}

function selectionError(detail: string): Error {
  return new Error(
    `${FRESH_AGENT_QUALIFICATION_MODES_ENV} ${detail}; allowed values are ${QUALIFIABLE_FRESH_AGENT_MODES.join(',')}`,
  )
}
