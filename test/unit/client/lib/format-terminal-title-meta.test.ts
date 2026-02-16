import { describe, it, expect } from 'vitest'
import {
  formatTokenUsageSummary,
  formatPaneRuntimeTooltip,
} from '@/lib/format-terminal-title-meta'
import type { TerminalTokenUsage, TerminalMetaRecord } from '@/store/terminalMetaSlice'

function makeTokenUsage(overrides: Partial<TerminalTokenUsage> = {}): TerminalTokenUsage {
  return {
    inputTokens: 12345,
    outputTokens: 6789,
    cachedTokens: 3210,
    totalTokens: 22344,
    contextTokens: 22344,
    modelContextWindow: 200000,
    compactThresholdTokens: 190000,
    compactPercent: 11.8,
    ...overrides,
  }
}

function makeMeta(overrides: Partial<TerminalMetaRecord> = {}): TerminalMetaRecord {
  return {
    terminalId: 't1',
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('formatTokenUsageSummary', () => {
  it('returns empty array for undefined input', () => {
    expect(formatTokenUsageSummary(undefined)).toEqual([])
  })

  it('returns all lines for full token data', () => {
    const lines = formatTokenUsageSummary(makeTokenUsage())

    expect(lines).toContainEqual(expect.stringContaining('Input: 12,345'))
    expect(lines).toContainEqual(expect.stringContaining('Output: 6,789'))
    expect(lines).toContainEqual(expect.stringContaining('Cached: 3,210'))
    expect(lines).toContainEqual(expect.stringContaining('Context: 22,344 / 190,000 (12% full)'))
    expect(lines).toContainEqual(expect.stringContaining('Model window: 200,000'))
  })

  it('handles partial data (no context info)', () => {
    const lines = formatTokenUsageSummary(makeTokenUsage({
      contextTokens: undefined,
      compactThresholdTokens: undefined,
      compactPercent: undefined,
      modelContextWindow: undefined,
    }))

    expect(lines).toHaveLength(3) // input, output, cached
    expect(lines).toContainEqual(expect.stringContaining('Input:'))
    expect(lines).toContainEqual(expect.stringContaining('Output:'))
    expect(lines).toContainEqual(expect.stringContaining('Cached:'))
  })

  it('computes percent from context/threshold when compactPercent missing', () => {
    const lines = formatTokenUsageSummary(makeTokenUsage({
      contextTokens: 95000,
      compactThresholdTokens: 100000,
      compactPercent: undefined,
    }))

    expect(lines).toContainEqual(expect.stringContaining('(95% full)'))
  })

  it('omits model window line when undefined', () => {
    const lines = formatTokenUsageSummary(makeTokenUsage({
      modelContextWindow: undefined,
    }))

    expect(lines.some(l => l.includes('Model window'))).toBe(false)
  })

  it('skips context line when compactThresholdTokens is 0', () => {
    const lines = formatTokenUsageSummary(makeTokenUsage({
      compactThresholdTokens: 0,
    }))

    expect(lines.some(l => l.includes('Context:'))).toBe(false)
  })
})

describe('formatPaneRuntimeTooltip', () => {
  it('returns undefined for undefined meta', () => {
    expect(formatPaneRuntimeTooltip(undefined)).toBeUndefined()
  })

  it('includes token breakdown when tokenUsage has data', () => {
    const result = formatPaneRuntimeTooltip(makeMeta({
      cwd: '/home/user/project',
      branch: 'main',
      tokenUsage: makeTokenUsage(),
    }))

    expect(result).toContain('Directory: /home/user/project')
    expect(result).toContain('Branch: main')
    expect(result).toContain('Input: 12,345')
    expect(result).toContain('Output: 6,789')
    expect(result).toContain('Cached: 3,210')
  })

  it('preserves existing behavior when tokenUsage is undefined', () => {
    const result = formatPaneRuntimeTooltip(makeMeta({
      cwd: '/home/user/project',
      branch: 'main',
    }))

    expect(result).toContain('Directory: /home/user/project')
    expect(result).toContain('Branch: main')
    expect(result).not.toContain('Input:')
    expect(result).not.toContain('Output:')
  })

  it('shows dirty indicator on branch', () => {
    const result = formatPaneRuntimeTooltip(makeMeta({
      branch: 'feature',
      isDirty: true,
    }))

    expect(result).toContain('Branch: feature*')
  })
})
