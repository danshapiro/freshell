const summaryMarker = '[e2e-cloud] Per-shard summary:'
const summaryEndMarker = '[e2e-cloud] Succeeded tasks:'
const maxPendingLineCharacters = 16_384
const maxSummaryLines = 8
const ansiEscape = /\u001B\[[0-?]*[ -/]*[@-~]/g

export type ManagedEnvironmentBrowserSummary = {
  footer: string
  executedCases: number
  passedCases: number
  failedCases: number
  skippedCases: number
  interruptedCases: number
}

type Counts = Omit<ManagedEnvironmentBrowserSummary, 'footer' | 'executedCases'>

function parseFooter(line: string): ManagedEnvironmentBrowserSummary | undefined {
  const normalized = line.replace(ansiEscape, '').trim()
  if (!/\b(?:failed|passed|skipped|interrupted)\b/.test(normalized)) return undefined

  const withoutDuration = normalized.replace(/\s+\([^()]*\)$/, '')
  const tokens = [...withoutDuration.matchAll(/(\d+)\s+(failed|passed|skipped|interrupted)\b/g)]
  if (tokens.length === 0) return undefined
  const remainder = withoutDuration.replace(/\d+\s+(?:failed|passed|skipped|interrupted)\b/g, '').replace(/[\s,]/g, '')
  if (remainder.length > 0) return undefined

  const counts: Counts = { passedCases: 0, failedCases: 0, skippedCases: 0, interruptedCases: 0 }
  const seen = new Set<string>()
  for (const token of tokens) {
    const count = Number(token[1])
    const category = token[2]
    if (!Number.isSafeInteger(count) || count < 0 || seen.has(category)) return undefined
    seen.add(category)
    counts[`${category}Cases` as keyof Counts] = count
  }

  const executedCases = counts.passedCases + counts.failedCases + counts.skippedCases + counts.interruptedCases
  if (!Number.isSafeInteger(executedCases) || executedCases < 1) return undefined
  return { footer: normalized, executedCases, ...counts }
}

/**
 * Bounded streaming capture for the actual Playwright line-reporter footer
 * printed by scripts/e2e-cloud.sh after it reads the accepted execution logs.
 * It retains only the small per-shard summary section, never arbitrary test or
 * environment output.
 */
export class ManagedEnvironmentBrowserSummaryCapture {
  private pendingLine = ''
  private inSummary = false
  private finished = false
  private skippingOverlongLine = false
  private failure: string | undefined
  private readonly summaries: ManagedEnvironmentBrowserSummary[] = []

  write(chunk: string | Uint8Array): void {
    if (this.finished) {
      this.failure ??= 'Cloud browser output arrived after summary capture finished'
      return
    }
    if (this.failure) return

    let remaining = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    while (remaining.length > 0) {
      if (this.skippingOverlongLine) {
        const newline = remaining.indexOf('\n')
        if (newline < 0) return
        remaining = remaining.slice(newline + 1)
        this.skippingOverlongLine = false
      }

      const newline = remaining.indexOf('\n')
      const segmentLength = newline < 0 ? remaining.length : newline
      if (this.pendingLine.length + segmentLength > maxPendingLineCharacters) {
        this.pendingLine = ''
        if (this.inSummary) {
          this.failure = 'Cloud browser output contained an overlong Playwright summary line'
          return
        }
        this.skippingOverlongLine = newline < 0
      } else {
        const segment = newline < 0 ? remaining : remaining.slice(0, newline)
        this.pendingLine += segment
        if (newline < 0) return
        this.consume(this.pendingLine.replace(/\r$/, ''))
        this.pendingLine = ''
        if (this.failure) return
      }
      if (newline < 0) return
      remaining = remaining.slice(newline + 1)
    }
  }

  finish(): ManagedEnvironmentBrowserSummary {
    if (this.finished) throw new Error('Cloud browser summary capture may only be finished once')
    this.finished = true
    if (this.failure) throw new Error(this.failure)
    if (this.skippingOverlongLine && this.inSummary) {
      throw new Error('Cloud browser output ended in an overlong Playwright summary line')
    }
    if (this.pendingLine.length > 0) this.consume(this.pendingLine.replace(/\r$/, ''))
    this.pendingLine = ''
    if (this.failure) throw new Error(this.failure)
    if (this.summaries.length !== 1) {
      throw new Error(`Expected exactly one Playwright shard summary, observed ${this.summaries.length}`)
    }
    return this.summaries[0]!
  }

  private consume(rawLine: string): void {
    const line = rawLine.replace(ansiEscape, '').trim()
    if (line === summaryMarker) {
      if (this.inSummary) this.failure = 'Cloud browser emitted a nested Playwright summary section'
      this.inSummary = true
      return
    }
    if (!this.inSummary) return
    if (line.startsWith(summaryEndMarker)) {
      this.inSummary = false
      return
    }
    const parsed = parseFooter(rawLine)
    if (!parsed) return
    this.summaries.push(parsed)
    if (this.summaries.length > maxSummaryLines) this.failure = 'Cloud browser emitted too many Playwright shard summaries'
  }
}
