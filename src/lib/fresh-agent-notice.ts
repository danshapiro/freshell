import type { LiveNotice } from '@/store/freshAgentLiveTypes'

/**
 * When a usage limit resets, as a Date. The CLI reports `resetsAt` in epoch
 * seconds; a value already in milliseconds (13 digits) is taken as is.
 */
function resetDate(resetsAt: number): Date {
  return new Date(resetsAt < 1e11 ? resetsAt * 1000 : resetsAt)
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "3:45 PM" today, "Fri 3:45 PM" on another day — in the viewer's locale and time zone. */
export function formatResetTime(resetsAt: number, now: Date = new Date()): string {
  const date = resetDate(resetsAt)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameLocalDay(date, now)) return time
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** The banner text for a provider notice: its message, plus when a rate limit resets. */
export function formatFreshAgentNotice(notice: Pick<LiveNotice, 'message' | 'rateLimit'>, now: Date = new Date()): string {
  const resetsAt = notice.rateLimit?.resetsAt
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return notice.message
  return `${notice.message} It resets at ${formatResetTime(resetsAt, now)}.`
}
