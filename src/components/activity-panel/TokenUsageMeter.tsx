import { formatTokenCount } from '@/lib/activity-panel-utils'
import type { TokenTotals } from '@/store/activityPanelTypes'

interface TokenUsageMeterProps {
  totals: TokenTotals
}

export default function TokenUsageMeter({ totals }: TokenUsageMeterProps) {
  const { inputTokens, outputTokens, cachedTokens, totalCost } = totals
  const total = inputTokens + outputTokens
  const hasData = total > 0

  if (!hasData) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-2">
        No token usage yet
      </div>
    )
  }

  // Compute segment widths as percentages
  const inputPct = total > 0 ? (inputTokens / total) * 100 : 0
  const outputPct = total > 0 ? (outputTokens / total) * 100 : 0

  return (
    <div className="px-3 py-2 space-y-1.5">
      {/* Bar */}
      <div className="flex h-2 rounded-full overflow-hidden bg-muted">
        <div
          className="bg-blue-500 transition-all duration-300"
          style={{ width: `${inputPct}%` }}
          title={`Input: ${formatTokenCount(inputTokens)}`}
        />
        <div
          className="bg-green-500 transition-all duration-300"
          style={{ width: `${outputPct}%` }}
          title={`Output: ${formatTokenCount(outputTokens)}`}
        />
      </div>

      {/* Labels */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
          In: {formatTokenCount(inputTokens)}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          Out: {formatTokenCount(outputTokens)}
        </span>
        {cachedTokens > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/40" />
            Cache: {formatTokenCount(cachedTokens)}
          </span>
        )}
      </div>

      {/* Cost */}
      {totalCost > 0 && (
        <div className="text-[11px] text-muted-foreground">
          Cost: ${totalCost.toFixed(4)}
        </div>
      )}
    </div>
  )
}
