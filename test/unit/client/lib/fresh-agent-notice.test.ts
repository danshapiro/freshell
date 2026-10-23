import { describe, expect, it } from 'vitest'
import { formatFreshAgentNotice, formatResetTime } from '@/lib/fresh-agent-notice'

const at = (date: Date) => Math.floor(date.getTime() / 1000)

describe('provider notice text (transcript-live D6)', () => {
  const now = new Date(2026, 9, 23, 10, 0)

  it('keeps a notice without a rate limit as the CLI wrote it', () => {
    expect(formatFreshAgentNotice({ message: 'Compaction failed: too long' }, now)).toBe('Compaction failed: too long')
    expect(formatFreshAgentNotice({ message: 'Close to your limit.', rateLimit: { status: 'allowed_warning' } }, now)).toBe('Close to your limit.')
  })

  it('names only the time for a reset later today, and the day too for a later day', () => {
    const later = new Date(2026, 9, 23, 15, 45)
    const tomorrow = new Date(2026, 9, 24, 15, 45)
    const today = formatResetTime(at(later), now)
    const otherDay = formatResetTime(at(tomorrow), now)
    expect(today).toBe(later.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
    expect(otherDay).not.toBe(today)
    expect(otherDay.endsWith(today)).toBe(true)
    expect(otherDay.startsWith(tomorrow.toLocaleDateString(undefined, { weekday: 'short' }))).toBe(true)
  })

  it('reads a reset in epoch seconds or milliseconds alike', () => {
    const later = new Date(2026, 9, 23, 15, 45)
    expect(formatResetTime(later.getTime(), now)).toBe(formatResetTime(at(later), now))
  })

  it('appends the reset time to a rate-limit notice', () => {
    const later = new Date(2026, 9, 23, 15, 45)
    const text = formatFreshAgentNotice({
      message: 'You have reached your Claude usage limit.',
      rateLimit: { status: 'rejected', resetsAt: at(later) },
    }, now)
    expect(text.startsWith('You have reached your Claude usage limit.')).toBe(true)
    expect(text).toContain(formatResetTime(at(later), now))
  })
})
