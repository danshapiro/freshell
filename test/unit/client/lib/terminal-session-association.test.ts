import { describe, expect, it, vi } from 'vitest'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import { reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { updateTab } from '@/store/tabsSlice'
import sessionActivityReducer, { updateSessionActivity } from '@/store/sessionActivitySlice'

function createState(content: Record<string, unknown>, tabOverrides: Record<string, unknown> = {}) {
  return {
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content,
        },
      },
    },
    tabs: {
      tabs: [{
        id: 'tab-1',
        title: 'Tab 1',
        status: 'running',
        ...tabOverrides,
      }],
    },
  } as any
}

function makeStateWithTerminalPane({
  terminalId,
  sessionRef,
}: {
  terminalId: string
  sessionRef: { provider: string; sessionId: string }
}) {
  const dispatch = vi.fn()
  const getState = () => createState({
    kind: 'terminal',
    terminalId,
    createRequestId: 'req-1',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    sessionRef,
  })
  return { dispatch, getState }
}

describe('terminal-session-association', () => {
  it('returns conflict and refuses to overwrite an existing canonical sessionRef', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        sessionRef: { provider: 'codex', sessionId: 'thread-new' },
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-old' },
    })

    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reconciles matching canonical identity and clears legacy resumeSessionId', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        resumeSessionId: 'legacy-thread',
        sessionRef: { provider: 'codex', sessionId: 'thread-1' },
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'thread-1',
        },
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })

    expect(result).toBe('reconciled')
    expect(dispatch).toHaveBeenCalled()
  })

  it('ignores unmatched panes cleanly', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-2',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })

    expect(result).toBe('ignored')
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('server-authoritative rebind (previousSessionId)', () => {
  it('rebinds when previousSessionId matches the pane current sessionRef', () => {
    // pane holds { provider: 'codex', sessionId: 'old-id' }
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'old-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
      previousSessionId: 'old-id',
    })
    expect(result).toBe('reconciled')
    expect(dispatch).toHaveBeenCalledWith(
      reconcileTerminalSessionRefByTerminalId({
        terminalId: 't1',
        sessionRef: { provider: 'codex', sessionId: 'new-id' },
      }),
    )
    expect(dispatch).toHaveBeenCalledWith(flushPersistedLayoutNow())
  })

  it('still conflicts when previousSessionId does NOT match the pane sessionRef', () => {
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'some-other-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
      previousSessionId: 'old-id',
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('still conflicts when previousSessionId is absent (write-once preserved)', () => {
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'old-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('re-keys tab session metadata from the superseded id to the new id on rebind', () => {
    const dispatched: any[] = []
    const dispatch = vi.fn((action) => dispatched.push(action))
    const getState = () => createState(
      {
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'opencode',
        shell: 'system',
        sessionRef: { provider: 'opencode', sessionId: 'ses_old' },
      },
      {
        sessionRef: { provider: 'opencode', sessionId: 'ses_old' },
        sessionMetadataByKey: {
          'opencode:ses_old': { sessionType: 'opencode', firstUserMessage: 'hello world' },
        },
      },
    )
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      previousSessionId: 'ses_old',
    })
    expect(result).toBe('reconciled')
    const tabUpdate = dispatched.find((action) => action.type === updateTab.type)
    expect(tabUpdate).toBeDefined()
    expect(tabUpdate.payload.updates.sessionMetadataByKey).toEqual({
      'opencode:ses_new': { sessionType: 'opencode', firstUserMessage: 'hello world' },
    })
    expect(dispatched.map((action) => action.type)).toContain(flushPersistedLayoutNow.type)
  })
})

describe('duplicate rebind broadcasts (idempotence regression guards)', () => {
  const boundPane = {
    kind: 'terminal' as const,
    terminalId: 'term-1',
    createRequestId: 'req-1',
    status: 'running' as const,
    mode: 'opencode' as const,
    shell: 'system' as const,
    sessionRef: { provider: 'opencode', sessionId: 'ses_old' },
  }

  it('a stale repeat whose previousSessionId no longer matches the pane current ref dispatches nothing', () => {
    // The pane has already moved on to ses_new2; an old rebind broadcast
    // (ses_old -> ses_new) arrives late. The supersession handshake must
    // veto it: previousSessionId (ses_old) is not the pane's current ref.
    const dispatched: any[] = []
    const dispatch = vi.fn((action) => dispatched.push(action))
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState(
        { ...boundPane, sessionRef: { provider: 'opencode', sessionId: 'ses_new2' } },
        { sessionRef: { provider: 'opencode', sessionId: 'ses_new2' } },
      ),
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      previousSessionId: 'ses_old',
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('an identical repeat neither re-dispatches updateTab nor flushes the persisted layout again', () => {
    // Post-first-rebind state: pane AND tab already carry ses_new. The tab
    // override is REQUIRED: after the first rebind's flush, the persisted
    // tab also carries the new ref -- and only a tab whose sessionRef
    // already matches suppresses the tab-side flush
    // (buildTerminalDurableSessionRefUpdate's tabNeedsSessionRef).
    const dispatched: any[] = []
    const dispatch = vi.fn((action) => dispatched.push(action))
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState(
        { ...boundPane, sessionRef: { provider: 'opencode', sessionId: 'ses_new' } },
        { sessionRef: { provider: 'opencode', sessionId: 'ses_new' } },
      ),
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      previousSessionId: 'ses_old',
    })
    expect(result).toBe('reconciled')
    const types = dispatched.map((action) => action.type)
    expect(types).not.toContain(flushPersistedLayoutNow.type)
    expect(types).not.toContain(updateTab.type)
  })
})

describe('alias activity fold on later identity binding', () => {
  // An identity-less terminal touched by the close-tab ratchet is recorded
  // under `<provider>:terminal:<terminalId>` (liveTerminalRowIdentity's
  // identity-less live-terminal row key). When the still-running terminal
  // later acquires canonical identity, the sidebar rekeys the row to
  // `<provider>:<sessionId>` and reads activity only from there, so the
  // alias timestamp must be folded across at the binding point.

  const ALIAS_KEY = 'claude:terminal:t-1'
  const CANONICAL_KEY = 'claude:s-1'

  function identityLessClaudePane(terminalId = 't-1') {
    return {
      kind: 'terminal',
      terminalId,
      createRequestId: 'req-1',
      status: 'running',
      mode: 'claude',
      shell: 'system',
    }
  }

  function createFoldHarness(
    sessions: Record<string, number>,
    content: Record<string, unknown> = identityLessClaudePane(),
  ) {
    const state = createState(content) as any
    state.sessionActivity = { sessions: { ...sessions } }
    const dispatch = vi.fn((action: any) => {
      if (action?.type === updateSessionActivity.type) {
        state.sessionActivity = sessionActivityReducer(state.sessionActivity, action)
      }
    })
    return { state, dispatch, getState: () => state }
  }

  function bindClaudeSession(harness: ReturnType<typeof createFoldHarness>) {
    return reconcileTerminalSessionAssociation({
      dispatch: harness.dispatch,
      getState: harness.getState,
      terminalId: 't-1',
      sessionRef: { provider: 'claude', sessionId: 's-1' },
    })
  }

  it('migrates the close-tab alias timestamp into the canonical key when identity binds', () => {
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111 })
    const result = bindClaudeSession(harness)
    expect(result).toBe('reconciled')
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBe(1111)
  })

  it('still folds the alias when the closed tab left no pane to match (the actual orphan)', () => {
    // The close happened earlier: the tab is gone, so no pane matches the
    // terminal and the reconciliation itself is 'ignored'. The fold must not
    // depend on a pane match -- this IS the orphan scenario.
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111 }, identityLessClaudePane('t-other'))
    const result = bindClaudeSession(harness)
    expect(result).toBe('ignored')
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBe(1111)
  })

  it('never lowers an already-newer canonical timestamp (ratchet non-regression)', () => {
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111, [CANONICAL_KEY]: 9999 })
    bindClaudeSession(harness)
    // The fold is attempted with the alias timestamp...
    expect(harness.dispatch).toHaveBeenCalledWith(
      updateSessionActivity({ sessionId: 's-1', provider: 'claude', lastInputAt: 1111 }),
    )
    // ...and the real reducer keeps the max.
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBe(9999)
  })

  it('writes nothing to the canonical key when no alias activity exists', () => {
    const harness = createFoldHarness({})
    bindClaudeSession(harness)
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBeUndefined()
  })

  it('does not fold onto a session the association itself rejects (conflict)', () => {
    // A stale/rejected association frame must not stamp alias activity onto
    // the session it declines to bind: folding happens only when the
    // association is accepted or harmlessly stale, never on the conflict
    // path. (The pane below is already bound to a different claude session,
    // so the s-1 frame is a conflict.)
    const harness = createFoldHarness({ [ALIAS_KEY]: 1111 }, {
      ...identityLessClaudePane(),
      sessionRef: { provider: 'claude', sessionId: 's-bound' },
    })
    const result = bindClaudeSession(harness)
    expect(result).toBe('conflict')
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions[CANONICAL_KEY]).toBeUndefined()
  })
})

describe('canonical activity fold on accepted rebind (previousSessionId)', () => {
  // Codex fork-handoff scenario: the tab was closed while the pane carried
  // the PARENT identity, so the close-tab ratchet wrote the parent canonical
  // key `codex:parent-1` (no terminal alias — liveTerminalRowIdentity yields
  // none for identity-bearing content). When the detached terminal later
  // commits the CHILD session and broadcasts previousSessionId, the sidebar
  // rekeys the row to the child, so the parent key's timestamp must be folded
  // across with the same ratchet-only mechanism as the terminal alias.

  function codexPane(terminalId: string, sessionId: string) {
    return {
      kind: 'terminal',
      terminalId,
      createRequestId: 'req-1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      sessionRef: { provider: 'codex', sessionId },
    }
  }

  function createRebindHarness(
    sessions: Record<string, number>,
    content: Record<string, unknown>,
  ) {
    const state = createState(content) as any
    state.sessionActivity = { sessions: { ...sessions } }
    const dispatch = vi.fn((action: any) => {
      if (action?.type === updateSessionActivity.type) {
        state.sessionActivity = sessionActivityReducer(state.sessionActivity, action)
      }
    })
    return { state, dispatch, getState: () => state }
  }

  function broadcastForkRebind(harness: ReturnType<typeof createRebindHarness>) {
    return reconcileTerminalSessionAssociation({
      dispatch: harness.dispatch,
      getState: harness.getState,
      terminalId: 't-1',
      sessionRef: { provider: 'codex', sessionId: 'child-1' },
      previousSessionId: 'parent-1',
    })
  }

  it('folds the parent canonical timestamp onto the child when a live pane accepts the rebind', () => {
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, codexPane('t-1', 'parent-1'))
    const result = broadcastForkRebind(harness)
    expect(result).toBe('reconciled')
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBe(1111)
  })

  it('still folds the parent timestamp when the tab closed before the rebind broadcast (orphan)', () => {
    // THE finding scenario: the close happened while the pane carried the
    // parent identity (parent key ratcheted, no terminal alias written) and
    // the pane is gone now; the detached terminal's rebind broadcast must
    // still fold, so the fold must not depend on a pane match.
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, codexPane('t-other', 'parent-1'))
    const result = broadcastForkRebind(harness)
    expect(result).toBe('ignored')
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBe(1111)
  })

  it('never lowers an already-newer child timestamp (ratchet non-regression)', () => {
    const harness = createRebindHarness(
      { 'codex:parent-1': 1111, 'codex:child-1': 9999 },
      codexPane('t-1', 'parent-1'),
    )
    broadcastForkRebind(harness)
    // The fold is attempted with the parent timestamp...
    expect(harness.dispatch).toHaveBeenCalledWith(
      updateSessionActivity({ sessionId: 'child-1', provider: 'codex', lastInputAt: 1111 }),
    )
    // ...and the real reducer keeps the max.
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBe(9999)
  })

  it('writes nothing when the parent key holds no activity', () => {
    const harness = createRebindHarness({}, codexPane('t-1', 'parent-1'))
    broadcastForkRebind(harness)
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBeUndefined()
  })

  it('does not fold onto the child when the rebind itself is rejected (conflict)', () => {
    // The pane carries a third identity, so previousSessionId does not
    // authorize the swap — a rejected frame must not stamp the parent's
    // activity onto a session this client never accepted.
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, codexPane('t-1', 'some-other'))
    const result = broadcastForkRebind(harness)
    expect(result).toBe('conflict')
    expect(harness.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: updateSessionActivity.type }),
    )
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBeUndefined()
  })

  it('does not move another session\'s activity on a plain association frame (no previousSessionId)', () => {
    // Without the supersession token nothing authorizes a canonical swap:
    // only the terminal alias may fold, never another session's key.
    const harness = createRebindHarness({ 'codex:parent-1': 1111 }, {
      kind: 'terminal',
      terminalId: 't-1',
      createRequestId: 'req-1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch: harness.dispatch,
      getState: harness.getState,
      terminalId: 't-1',
      sessionRef: { provider: 'codex', sessionId: 'child-1' },
    })
    expect(result).toBe('reconciled')
    expect(harness.state.sessionActivity.sessions['codex:child-1']).toBeUndefined()
    expect(harness.state.sessionActivity.sessions['codex:parent-1']).toBe(1111)
  })
})
