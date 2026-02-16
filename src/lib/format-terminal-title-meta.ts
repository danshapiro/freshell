import type { TerminalMetaRecord, TerminalTokenUsage } from '@/store/terminalMetaSlice'

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

export function formatTokenUsageSummary(tokenUsage: TerminalTokenUsage | undefined): string[] {
  if (!tokenUsage) return []

  const lines: string[] = []
  const fmt = (n: number) => tokenNumberFormatter.format(Math.round(n))

  if (typeof tokenUsage.inputTokens === 'number' && Number.isFinite(tokenUsage.inputTokens)) {
    lines.push(`Input: ${fmt(tokenUsage.inputTokens)}`)
  }
  if (typeof tokenUsage.outputTokens === 'number' && Number.isFinite(tokenUsage.outputTokens)) {
    lines.push(`Output: ${fmt(tokenUsage.outputTokens)}`)
  }
  if (typeof tokenUsage.cachedTokens === 'number' && Number.isFinite(tokenUsage.cachedTokens)) {
    lines.push(`Cached: ${fmt(tokenUsage.cachedTokens)}`)
  }

  const contextTokens = tokenUsage.contextTokens
  const compactThresholdTokens = tokenUsage.compactThresholdTokens
  const compactPercent = tokenUsage.compactPercent
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
    lines.push(`Context: ${fmt(contextTokens)} / ${fmt(compactThresholdTokens)} (${normalizedPercent}% full)`)
  }

  if (typeof tokenUsage.modelContextWindow === 'number' && Number.isFinite(tokenUsage.modelContextWindow)) {
    lines.push(`Model window: ${fmt(tokenUsage.modelContextWindow)}`)
  }

  return lines
}

export function formatPaneRuntimeTooltip(meta: TerminalMetaRecord | undefined): string | undefined {
  if (!meta) return undefined

  const lines: string[] = []
  const directory = meta.cwd || meta.checkoutRoot || meta.repoRoot
  if (directory) {
    lines.push(`Directory: ${directory}`)
  }

  if (meta.branch) {
    lines.push(`Branch: ${meta.branch}${meta.isDirty ? '*' : ''}`)
  }

  const usageLines = formatTokenUsageSummary(meta.tokenUsage)
  if (usageLines.length) {
    lines.push('', ...usageLines)
  }

  return lines.length ? lines.join('\n') : undefined
}
