import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

const tokenNumberFormatter = new Intl.NumberFormat('en-US')

function safeBasename(input?: string): string | undefined {
  if (!input) return undefined
  const normalized = input.replace(/[\\/]+$/, '')
  if (!normalized) return undefined
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || normalized
}

export function formatPaneRuntimeLabel(meta: TerminalMetaRecord | undefined): string | undefined {
  if (!meta) return undefined

  const subdir = meta.displaySubdir || safeBasename(meta.checkoutRoot) || safeBasename(meta.cwd)
  const branch = meta.branch
  const percentRaw = meta.tokenUsage?.compactPercent
  const percent = typeof percentRaw === 'number' && Number.isFinite(percentRaw)
    ? `${Math.max(0, Math.min(100, Math.round(percentRaw)))}%`
    : undefined

  const leftParts = [
    subdir,
    branch ? `(${branch}${meta.isDirty ? '*' : ''})` : undefined,
  ].filter(Boolean)

  if (!leftParts.length && !percent) return undefined

  const left = leftParts.join(' ')
  if (!percent) return left || undefined
  return left ? `${left}  ${percent}` : percent
}

export function formatPaneRuntimeTooltip(meta: TerminalMetaRecord | undefined): string | undefined {
  if (!meta) return undefined

  const lines: string[] = []
  const directory = meta.cwd || meta.checkoutRoot || meta.repoRoot
  if (directory) {
    lines.push(`Directory: ${directory}`)
  }

  if (meta.branch) {
    lines.push(`branch: ${meta.branch}${meta.isDirty ? '*' : ''}`)
  }

  const contextTokens = meta.tokenUsage?.contextTokens
  const compactThresholdTokens = meta.tokenUsage?.compactThresholdTokens
  const compactPercent = meta.tokenUsage?.compactPercent
  if (
    typeof contextTokens === 'number' &&
    Number.isFinite(contextTokens) &&
    typeof compactThresholdTokens === 'number' &&
    Number.isFinite(compactThresholdTokens) &&
    compactThresholdTokens > 0
  ) {
    const normalizedPercent = typeof compactPercent === 'number' && Number.isFinite(compactPercent)
      ? Math.max(0, Math.min(100, Math.round(compactPercent)))
      : Math.max(0, Math.min(100, Math.round((contextTokens / compactThresholdTokens) * 100)))
    lines.push(
      `Tokens: ${tokenNumberFormatter.format(Math.round(contextTokens))}/${tokenNumberFormatter.format(Math.round(compactThresholdTokens))}(${normalizedPercent}% full)`,
    )
  }

  return lines.length ? lines.join('\n') : undefined
}
