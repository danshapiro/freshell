import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export const SESSION_ACTIVITY_STORAGE_KEY = 'freshell.sessionActivity.v1'
const MAX_SESSION_ACTIVITY_ENTRIES = 2000
const SESSION_ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionActivityState {
  sessions: Record<string, number>
}

function makeSessionKey(sessionId: string, provider?: string): string {
  if (sessionId.includes(':')) return sessionId
  if (provider) return `${provider}:${sessionId}`
  return sessionId
}

function canUseStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

function normalizeSessions(raw: Record<string, unknown>): Record<string, number> {
  const normalized: Record<string, number> = {}
  for (const [sessionId, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[sessionId] = value
    }
  }
  return normalized
}

function pruneSessions(sessions: Record<string, number>, now: number): Record<string, number> {
  const entries = Object.entries(sessions)
  if (entries.length === 0) return sessions

  let changed = false
  const fresh: Array<[string, number]> = []
  for (const [sessionId, lastInputAt] of entries) {
    if (now - lastInputAt > SESSION_ACTIVITY_RETENTION_MS) {
      changed = true
      continue
    }
    fresh.push([sessionId, lastInputAt])
  }

  if (fresh.length > MAX_SESSION_ACTIVITY_ENTRIES) {
    changed = true
    fresh.sort((a, b) => b[1] - a[1])
    fresh.length = MAX_SESSION_ACTIVITY_ENTRIES
  }

  if (!changed) return sessions
  return Object.fromEntries(fresh)
}

function loadFromStorage(): Record<string, number> {
  if (!canUseStorage()) return {}
  try {
    const raw = localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const normalized = normalizeSessions(parsed as Record<string, unknown>)
    return pruneSessions(normalized, Date.now())
  } catch {
    return {}
  }
}

const initialState: SessionActivityState = {
  sessions: loadFromStorage(),
}

const EMPTY_ACTIVITY: Record<string, number> = {}

export const sessionActivitySlice = createSlice({
  name: 'sessionActivity',
  initialState,
  reducers: {
    updateSessionActivity: (
      state,
      action: PayloadAction<{ sessionId: string; provider?: string; lastInputAt: number }>
    ) => {
      const { sessionId, provider, lastInputAt } = action.payload
      const key = makeSessionKey(sessionId, provider)
      const existing = state.sessions[key] || 0

      if (lastInputAt > existing) {
        state.sessions[key] = lastInputAt
        const pruned = pruneSessions(state.sessions, lastInputAt)
        if (pruned !== state.sessions) {
          state.sessions = pruned
        }
      }
    },
  },
})

export const { updateSessionActivity } = sessionActivitySlice.actions

export const selectSessionActivity = (
  state: { sessionActivity?: SessionActivityState },
  sessionId: string
): number | undefined => state.sessionActivity?.sessions?.[sessionId]

export const selectAllSessionActivity = (
  state: { sessionActivity?: SessionActivityState }
): Record<string, number> => state.sessionActivity?.sessions ?? EMPTY_ACTIVITY

export default sessionActivitySlice.reducer
