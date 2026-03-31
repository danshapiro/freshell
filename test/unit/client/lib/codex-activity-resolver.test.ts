import { describe, expect, it } from 'vitest'
import type { CodexActivityRecord } from '@shared/ws-protocol'
import { resolveExactCodexActivity } from '@/lib/codex-activity-resolver'

function makeRecord(overrides: Partial<CodexActivityRecord> = {}): CodexActivityRecord {
  return {
    terminalId: 'term-1',
    phase: 'busy',
    updatedAt: 1,
    ...overrides,
  }
}

describe('resolveExactCodexActivity', () => {
  it('returns the exact terminal activity record when the pane has a live terminal id', () => {
    const record = makeRecord()

    expect(resolveExactCodexActivity(
      { 'term-1': record },
      { terminalId: 'term-1', isOnlyPane: true },
    )).toEqual(record)
  })

  it('returns undefined when pane has no terminalId even for single-pane tab', () => {
    const record = makeRecord({ terminalId: 'term-tab' })

    expect(resolveExactCodexActivity(
      { 'term-tab': record },
      { terminalId: undefined, isOnlyPane: true },
    )).toBeUndefined()
  })

  it('returns undefined when there is no exact terminal id match', () => {
    expect(resolveExactCodexActivity(
      { 'term-other': makeRecord({ terminalId: 'term-other' }) },
      { terminalId: undefined, isOnlyPane: true },
    )).toBeUndefined()
  })
})
