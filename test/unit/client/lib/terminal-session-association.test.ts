import { describe, expect, it, vi } from 'vitest'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import { reconcileTerminalSessionRefByTerminalId, updatePaneTitle } from '@/store/panesSlice'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { updateTab } from '@/store/tabsSlice'

function createState(
  content: Record<string, unknown>,
  tabOverrides: Record<string, unknown> = {},
  sessions?: Record<string, unknown>,
) {
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
    sessions: sessions ?? { windows: {} },
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

  describe('rebind tab title adoption (non-user-set titles only)', () => {
    const codexPaneBoundToOldThread = {
      kind: 'terminal' as const,
      terminalId: 't-1',
      createRequestId: 'req-1',
      status: 'running' as const,
      mode: 'codex' as const,
      shell: 'system' as const,
      sessionRef: { provider: 'codex', sessionId: 'old-thread' },
    }
    const sessionsWithNewThreadTitle = {
      windows: {
        main: {
          projects: [{
            projectPath: '/repo',
            sessions: [{
              provider: 'codex',
              sessionId: 'new-thread',
              projectPath: '/repo',
              lastActivityAt: 1,
              title: 'Durable thread title',
            }],
          }],
        },
      },
    }
    const rebindReconcile = (dispatch: any, getState: () => any) =>
      reconcileTerminalSessionAssociation({
        dispatch,
        getState,
        terminalId: 't-1',
        sessionRef: { provider: 'codex', sessionId: 'new-thread' },
        previousSessionId: 'old-thread',
      })

    it('adopts the new session directory title for a non-user-set tab title', () => {
      const dispatched: any[] = []
      const dispatch = vi.fn((action) => dispatched.push(action))
      const getState = () => createState(
        codexPaneBoundToOldThread,
        {
          title: 'Old title',
          titleSetByUser: undefined,
          sessionRef: { provider: 'codex', sessionId: 'old-thread' },
        },
        sessionsWithNewThreadTitle,
      )
      const result = rebindReconcile(dispatch, getState)
      expect(result).toBe('reconciled')
      const tabUpdate = dispatched.find((action) => action.type === updateTab.type)
      expect(tabUpdate).toBeDefined()
      expect(tabUpdate.payload.updates).toMatchObject({ title: 'Durable thread title' })
      expect(dispatch).toHaveBeenCalledWith(updatePaneTitle({
        tabId: 'tab-1',
        paneId: 'pane-1',
        title: 'Durable thread title',
        setByUser: false,
      }))
      expect(dispatch).toHaveBeenCalledWith(flushPersistedLayoutNow())
    })

    it('never replaces a user-set tab title on rebind', () => {
      const dispatched: any[] = []
      const dispatch = vi.fn((action) => dispatched.push(action))
      const getState = () => createState(
        codexPaneBoundToOldThread,
        {
          title: 'User title',
          titleSetByUser: true,
          sessionRef: { provider: 'codex', sessionId: 'old-thread' },
        },
        sessionsWithNewThreadTitle,
      )
      const result = rebindReconcile(dispatch, getState)
      expect(result).toBe('reconciled')
      const tabUpdate = dispatched.find((action) => action.type === updateTab.type)
      expect(tabUpdate).toBeDefined()
      expect(tabUpdate.payload.updates).not.toHaveProperty('title')
      expect(dispatched.some((action) => action.type === updatePaneTitle.type)).toBe(false)
      expect(dispatch).toHaveBeenCalledWith(flushPersistedLayoutNow())
    })

    it('leaves the title alone when the directory has no row for the new key', () => {
      const dispatched: any[] = []
      const dispatch = vi.fn((action) => dispatched.push(action))
      const getState = () => createState(
        codexPaneBoundToOldThread,
        {
          title: 'Old title',
          sessionRef: { provider: 'codex', sessionId: 'old-thread' },
        },
        {
          windows: {
            main: {
              projects: [{
                projectPath: '/repo',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'other-thread',
                  projectPath: '/repo',
                  lastActivityAt: 1,
                  title: 'Someone else\'s title',
                }],
              }],
            },
          },
        },
      )
      const result = rebindReconcile(dispatch, getState)
      expect(result).toBe('reconciled')
      const tabUpdate = dispatched.find((action) => action.type === updateTab.type)
      expect(tabUpdate).toBeDefined()
      expect(tabUpdate.payload.updates).not.toHaveProperty('title')
      expect(dispatched.some((action) => action.type === updatePaneTitle.type)).toBe(false)
    })

    it('never adopts a title on a first bind (previousSessionId absent)', () => {
      const dispatched: any[] = []
      const dispatch = vi.fn((action) => dispatched.push(action))
      const getState = () => createState(
        {
          kind: 'terminal',
          terminalId: 't-1',
          createRequestId: 'req-1',
          status: 'running',
          mode: 'codex',
          shell: 'system',
        },
        { title: 'First bind title' },
        sessionsWithNewThreadTitle,
      )
      const result = reconcileTerminalSessionAssociation({
        dispatch,
        getState,
        terminalId: 't-1',
        sessionRef: { provider: 'codex', sessionId: 'new-thread' },
      })
      expect(result).toBe('reconciled')
      const tabUpdate = dispatched.find((action) => action.type === updateTab.type)
      expect(tabUpdate).toBeDefined()
      expect(tabUpdate.payload.updates).toMatchObject({
        sessionRef: { provider: 'codex', sessionId: 'new-thread' },
      })
      expect(tabUpdate.payload.updates).not.toHaveProperty('title')
      expect(dispatched.some((action) => action.type === updatePaneTitle.type)).toBe(false)
    })

    it('a rebind that the conflict gate refuses never touches titles', () => {
      const dispatched: any[] = []
      const dispatch = vi.fn((action) => dispatched.push(action))
      const getState = () => createState(
        { ...codexPaneBoundToOldThread, sessionRef: { provider: 'codex', sessionId: 'some-other-thread' } },
        {
          title: 'Old title',
          sessionRef: { provider: 'codex', sessionId: 'some-other-thread' },
        },
        sessionsWithNewThreadTitle,
      )
      const result = rebindReconcile(dispatch, getState)
      expect(result).toBe('conflict')
      expect(dispatch).not.toHaveBeenCalled()
    })
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
