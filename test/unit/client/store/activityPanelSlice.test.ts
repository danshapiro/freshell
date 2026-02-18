import { describe, it, expect } from 'vitest'
import reducer, {
  togglePanel,
  setPanel,
  addActivityEvent,
  updateTokenUsage,
  addPendingApproval,
  resolvePendingApproval,
  updateTask,
  clearSession,
  getActivityPanelEvents,
} from '@/store/activityPanelSlice'
import { ACTIVITY_PANEL_MAX_EVENTS } from '@/store/activityPanelTypes'
import type { ActivityPanelState } from '@/store/activityPanelTypes'
import type { NormalizedEvent } from '@/lib/coding-cli-types'

function makeEvent(type: NormalizedEvent['type'], seq: number): NormalizedEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    provider: 'claude',
    sequenceNumber: seq,
  }
}

function makeToolCallEvent(seq: number, toolName = 'Bash'): NormalizedEvent {
  return {
    ...makeEvent('tool.call', seq),
    tool: { callId: `call-${seq}`, name: toolName },
  }
}

describe('activityPanelSlice', () => {
  const initialState: ActivityPanelState = {
    sessions: {},
    visibility: {},
  }

  describe('togglePanel', () => {
    it('toggles visibility for a session from false to true', () => {
      const state = reducer(initialState, togglePanel({ sessionId: 'ses-1' }))
      expect(state.visibility['ses-1']).toBe(true)
    })

    it('toggles visibility back to false', () => {
      const state1 = reducer(initialState, togglePanel({ sessionId: 'ses-1' }))
      const state2 = reducer(state1, togglePanel({ sessionId: 'ses-1' }))
      expect(state2.visibility['ses-1']).toBe(false)
    })

    it('toggles independently per session', () => {
      let state = reducer(initialState, togglePanel({ sessionId: 'ses-1' }))
      state = reducer(state, togglePanel({ sessionId: 'ses-2' }))
      expect(state.visibility['ses-1']).toBe(true)
      expect(state.visibility['ses-2']).toBe(true)
    })
  })

  describe('setPanel', () => {
    it('sets panel open explicitly', () => {
      const state = reducer(initialState, setPanel({ sessionId: 'ses-1', open: true }))
      expect(state.visibility['ses-1']).toBe(true)
    })

    it('sets panel closed explicitly', () => {
      let state = reducer(initialState, setPanel({ sessionId: 'ses-1', open: true }))
      state = reducer(state, setPanel({ sessionId: 'ses-1', open: false }))
      expect(state.visibility['ses-1']).toBe(false)
    })
  })

  describe('addActivityEvent', () => {
    it('adds events to a new session', () => {
      const event = makeToolCallEvent(1)
      const state = reducer(initialState, addActivityEvent({ sessionId: 'ses-1', event }))
      expect(state.sessions['ses-1'].events).toHaveLength(1)
      expect(state.sessions['ses-1'].eventCount).toBe(1)
    })

    it('adds events up to the cap without ring buffering', () => {
      let state = initialState
      for (let i = 0; i < ACTIVITY_PANEL_MAX_EVENTS; i++) {
        state = reducer(state, addActivityEvent({ sessionId: 'ses-1', event: makeToolCallEvent(i) }))
      }
      expect(state.sessions['ses-1'].events).toHaveLength(ACTIVITY_PANEL_MAX_EVENTS)
      expect(state.sessions['ses-1'].eventCount).toBe(ACTIVITY_PANEL_MAX_EVENTS)
      expect(state.sessions['ses-1'].eventStart).toBe(0)
    })

    it('ring-buffers after exceeding the cap', () => {
      let state = initialState
      // Fill to cap
      for (let i = 0; i < ACTIVITY_PANEL_MAX_EVENTS; i++) {
        state = reducer(state, addActivityEvent({ sessionId: 'ses-1', event: makeToolCallEvent(i) }))
      }
      // Add one more — should overwrite index 0
      state = reducer(state, addActivityEvent({ sessionId: 'ses-1', event: makeToolCallEvent(ACTIVITY_PANEL_MAX_EVENTS, 'Read') }))

      const session = state.sessions['ses-1']
      expect(session.events).toHaveLength(ACTIVITY_PANEL_MAX_EVENTS) // Still capped
      expect(session.eventCount).toBe(ACTIVITY_PANEL_MAX_EVENTS + 1)
      expect(session.eventStart).toBe(1) // Wrapped around
      // The overwritten event at index 0 should be the newest
      expect(session.events[0].event.tool?.name).toBe('Read')
    })

    it('returns events in chronological order from ring buffer via selector', () => {
      let state = initialState
      for (let i = 0; i < ACTIVITY_PANEL_MAX_EVENTS + 5; i++) {
        state = reducer(state, addActivityEvent({ sessionId: 'ses-1', event: makeToolCallEvent(i, `tool-${i}`) }))
      }
      const ordered = getActivityPanelEvents(state.sessions['ses-1'])
      expect(ordered).toHaveLength(ACTIVITY_PANEL_MAX_EVENTS)
      // First event should be the oldest remaining (index 5)
      expect(ordered[0].event.tool?.name).toBe('tool-5')
      // Last event should be the newest
      expect(ordered[ACTIVITY_PANEL_MAX_EVENTS - 1].event.tool?.name).toBe(`tool-${ACTIVITY_PANEL_MAX_EVENTS + 4}`)
    })
  })

  describe('updateTokenUsage', () => {
    it('accumulates token totals', () => {
      let state = reducer(initialState, updateTokenUsage({
        sessionId: 'ses-1',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
        totalCost: 0.01,
      }))
      state = reducer(state, updateTokenUsage({
        sessionId: 'ses-1',
        inputTokens: 200,
        outputTokens: 75,
        cachedTokens: 30,
        totalCost: 0.02,
      }))

      const totals = state.sessions['ses-1'].tokenTotals
      expect(totals.inputTokens).toBe(300)
      expect(totals.outputTokens).toBe(125)
      expect(totals.cachedTokens).toBe(50)
      expect(totals.totalCost).toBeCloseTo(0.03)
    })

    it('handles missing optional fields', () => {
      const state = reducer(initialState, updateTokenUsage({
        sessionId: 'ses-1',
        inputTokens: 100,
        outputTokens: 50,
      }))
      expect(state.sessions['ses-1'].tokenTotals.cachedTokens).toBe(0)
      expect(state.sessions['ses-1'].tokenTotals.totalCost).toBe(0)
    })
  })

  describe('addPendingApproval / resolvePendingApproval', () => {
    it('adds a pending approval', () => {
      const state = reducer(initialState, addPendingApproval({
        sessionId: 'ses-1',
        approval: {
          requestId: 'req-1',
          toolName: 'Bash',
          description: 'Run git status',
          timestamp: new Date().toISOString(),
        },
      }))
      expect(state.sessions['ses-1'].pendingApprovals).toHaveLength(1)
      expect(state.sessions['ses-1'].pendingApprovals[0].requestId).toBe('req-1')
    })

    it('does not add duplicate approvals', () => {
      const approval = {
        requestId: 'req-1',
        toolName: 'Bash',
        description: 'Run git status',
        timestamp: new Date().toISOString(),
      }
      let state = reducer(initialState, addPendingApproval({ sessionId: 'ses-1', approval }))
      state = reducer(state, addPendingApproval({ sessionId: 'ses-1', approval }))
      expect(state.sessions['ses-1'].pendingApprovals).toHaveLength(1)
    })

    it('resolves a pending approval', () => {
      const approval = {
        requestId: 'req-1',
        toolName: 'Bash',
        description: 'Run git status',
        timestamp: new Date().toISOString(),
      }
      let state = reducer(initialState, addPendingApproval({ sessionId: 'ses-1', approval }))
      state = reducer(state, resolvePendingApproval({ sessionId: 'ses-1', requestId: 'req-1' }))
      expect(state.sessions['ses-1'].pendingApprovals).toHaveLength(0)
    })

    it('ignores resolve for non-existent session', () => {
      const state = reducer(initialState, resolvePendingApproval({ sessionId: 'ses-1', requestId: 'req-1' }))
      expect(state.sessions['ses-1']).toBeUndefined()
    })
  })

  describe('updateTask', () => {
    it('adds a new task', () => {
      const state = reducer(initialState, updateTask({
        sessionId: 'ses-1',
        task: { id: 'task-1', subject: 'Fix bug', status: 'pending' },
      }))
      expect(state.sessions['ses-1'].tasks).toHaveLength(1)
      expect(state.sessions['ses-1'].tasks[0].subject).toBe('Fix bug')
    })

    it('updates an existing task', () => {
      let state = reducer(initialState, updateTask({
        sessionId: 'ses-1',
        task: { id: 'task-1', subject: 'Fix bug', status: 'pending' },
      }))
      state = reducer(state, updateTask({
        sessionId: 'ses-1',
        task: { id: 'task-1', subject: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
      }))
      expect(state.sessions['ses-1'].tasks).toHaveLength(1)
      expect(state.sessions['ses-1'].tasks[0].status).toBe('in_progress')
      expect(state.sessions['ses-1'].tasks[0].activeForm).toBe('Fixing bug')
    })

    it('adds multiple tasks', () => {
      let state = reducer(initialState, updateTask({
        sessionId: 'ses-1',
        task: { id: 'task-1', subject: 'First', status: 'completed' },
      }))
      state = reducer(state, updateTask({
        sessionId: 'ses-1',
        task: { id: 'task-2', subject: 'Second', status: 'pending' },
      }))
      expect(state.sessions['ses-1'].tasks).toHaveLength(2)
    })
  })

  describe('clearSession', () => {
    it('removes session state and visibility', () => {
      let state = reducer(initialState, togglePanel({ sessionId: 'ses-1' }))
      state = reducer(state, addActivityEvent({ sessionId: 'ses-1', event: makeToolCallEvent(1) }))
      state = reducer(state, clearSession({ sessionId: 'ses-1' }))

      expect(state.sessions['ses-1']).toBeUndefined()
      expect(state.visibility['ses-1']).toBeUndefined()
    })

    it('does not affect other sessions', () => {
      let state = reducer(initialState, addActivityEvent({ sessionId: 'ses-1', event: makeToolCallEvent(1) }))
      state = reducer(state, addActivityEvent({ sessionId: 'ses-2', event: makeToolCallEvent(2) }))
      state = reducer(state, clearSession({ sessionId: 'ses-1' }))

      expect(state.sessions['ses-1']).toBeUndefined()
      expect(state.sessions['ses-2']).toBeDefined()
    })
  })
})
