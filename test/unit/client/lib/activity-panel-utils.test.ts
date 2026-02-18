import { describe, it, expect } from 'vitest'
import {
  isActivityPanelRelevant,
  formatToolName,
  formatTimestamp,
  formatTokenCount,
} from '@/lib/activity-panel-utils'
import type { NormalizedEvent } from '@/lib/coding-cli-types'

function makeEvent(type: NormalizedEvent['type']): NormalizedEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    provider: 'claude',
  }
}

describe('isActivityPanelRelevant', () => {
  it('returns true for tool.call events', () => {
    expect(isActivityPanelRelevant(makeEvent('tool.call'))).toBe(true)
  })

  it('returns true for tool.result events', () => {
    expect(isActivityPanelRelevant(makeEvent('tool.result'))).toBe(true)
  })

  it('returns true for token.usage events', () => {
    expect(isActivityPanelRelevant(makeEvent('token.usage'))).toBe(true)
  })

  it('returns true for approval.request events', () => {
    expect(isActivityPanelRelevant(makeEvent('approval.request'))).toBe(true)
  })

  it('returns true for error events', () => {
    expect(isActivityPanelRelevant(makeEvent('error'))).toBe(true)
  })

  it('returns false for message.user events', () => {
    expect(isActivityPanelRelevant(makeEvent('message.user'))).toBe(false)
  })

  it('returns false for message.assistant events', () => {
    expect(isActivityPanelRelevant(makeEvent('message.assistant'))).toBe(false)
  })

  it('returns false for message.delta events', () => {
    expect(isActivityPanelRelevant(makeEvent('message.delta'))).toBe(false)
  })

  it('returns false for reasoning events', () => {
    expect(isActivityPanelRelevant(makeEvent('reasoning'))).toBe(false)
  })

  it('returns false for session.start events', () => {
    expect(isActivityPanelRelevant(makeEvent('session.start'))).toBe(false)
  })
})

describe('formatToolName', () => {
  it('returns simple tool names unchanged', () => {
    expect(formatToolName('Bash')).toBe('Bash')
    expect(formatToolName('Read')).toBe('Read')
  })

  it('humanizes MCP tool names', () => {
    expect(formatToolName('mcp__linear__get_issue')).toBe('Linear: Get Issue')
    expect(formatToolName('mcp__supabase__execute_sql')).toBe('Supabase: Execute Sql')
  })

  it('handles empty string', () => {
    expect(formatToolName('')).toBe('Unknown')
  })
})

describe('formatTimestamp', () => {
  it('formats recent timestamps as seconds ago', () => {
    const recent = new Date(Date.now() - 5000).toISOString()
    expect(formatTimestamp(recent)).toBe('5s ago')
  })

  it('formats minute-old timestamps as minutes ago', () => {
    const minuteAgo = new Date(Date.now() - 90000).toISOString()
    expect(formatTimestamp(minuteAgo)).toBe('1m ago')
  })

  it('formats hour-old timestamps as hours ago', () => {
    const hourAgo = new Date(Date.now() - 3700000).toISOString()
    expect(formatTimestamp(hourAgo)).toBe('1h ago')
  })

  it('handles future timestamps', () => {
    const future = new Date(Date.now() + 10000).toISOString()
    expect(formatTimestamp(future)).toBe('just now')
  })
})

describe('formatTokenCount', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokenCount(45)).toBe('45')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('formats thousands with k suffix', () => {
    expect(formatTokenCount(1200)).toBe('1.2k')
    expect(formatTokenCount(45000)).toBe('45.0k')
  })

  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1200000)).toBe('1.2M')
  })

  it('formats zero', () => {
    expect(formatTokenCount(0)).toBe('0')
  })
})
