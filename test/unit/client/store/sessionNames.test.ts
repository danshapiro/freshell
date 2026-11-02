import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import sessionNamesReducer, {
  receiveSessionNames,
  receiveSessionNameProjections,
  sessionNamesIngestMiddleware,
  type SessionNamesState,
} from '@/store/sessionNamesSlice'
import {
  sessionNameRefKey,
  type SessionNameRecord,
  type SessionNameRef,
  type SessionNameUpdate,
} from '@shared/session-names'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'

function sessionRef(
  sessionId: string,
  provider: 'claude' | 'codex' | 'opencode' | 'antigravity' = 'claude',
): SessionNameRef {
  return { kind: 'session', provider, sessionId }
}

function pendingRef(id: string): SessionNameRef {
  return { kind: 'pending', id }
}

function record(ref: SessionNameRef, name: string, revision: number, source: SessionNameRecord['source'] = 'first_message'): SessionNameRecord {
  return { ref, name, source, revision }
}

function update(
  rec: SessionNameRecord,
  documentGeneration: number,
  extra: Partial<SessionNameUpdate> = {},
): SessionNameUpdate {
  return {
    record: rec,
    documentGeneration,
    redirects: [],
    changed: true,
    ...extra,
  }
}

function recordAt(state: SessionNamesState, ref: SessionNameRef): SessionNameRecord | undefined {
  return state.records[sessionNameRefKey(ref)]
}

describe('sessionNames reducer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('stores an accepted record by its naming ref key', () => {
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Fix login', 3), 10),
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Fix login')
    expect(recordAt(state, sessionRef('s1'))?.revision).toBe(3)
  })

  it('stores an accepted antigravity record by its naming ref key (Task 9: the fourth scoped CLI)', () => {
    // An antigravity rename riding the canonical update shape must fold
    // cleanly — no schema rejection, no console error, no dropped record.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('conv-1', 'antigravity'), 'Antigravity rename', 2), 10),
    ]))
    expect(recordAt(state, sessionRef('conv-1', 'antigravity'))?.name).toBe('Antigravity rename')
    expect(errorSpy).not.toHaveBeenCalled()
    // A rename (higher revision, manual) replaces it by revision, and a
    // gemini record (out of scope by contract) still never enters the cache.
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('conv-1', 'antigravity'), 'Renamed by user', 3, 'manual'), 11),
    ]))
    expect(recordAt(state, sessionRef('conv-1', 'antigravity'))?.name).toBe('Renamed by user')
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record({ kind: 'session', provider: 'gemini', sessionId: 'g-1' } as never, 'Nope', 1), 12),
    ]))
    expect(recordAt(state, { kind: 'session', provider: 'gemini', sessionId: 'g-1' } as never)).toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('merges records by revision, not arrival order: a stale late update never retitles', () => {
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Newer name', 5), 20),
    ]))
    // The older update arrives LATER (reversed delivery) — it must lose.
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Older name', 4), 15),
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Newer name')
  })

  it('folds the same revision delivered twice idempotently', () => {
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Stable', 7), 30),
    ]))
    const before = state
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Stable', 7), 30),
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Stable')
    expect(recordAt(state, sessionRef('s1'))).toBe(before.records[sessionNameRefKey(sessionRef('s1'))])
  })

  it('treats equal revision with different name as a protocol error and keeps the accepted record', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Accepted', 9), 40),
    ]))
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Conflicting', 9), 41),
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Accepted')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('an update for session A never rewrites session B\'s record', () => {
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('a'), 'A name', 1), 1),
      update(record(sessionRef('b'), 'B name', 1), 2),
    ]))
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('a'), 'A renamed', 2), 3),
    ]))
    expect(recordAt(state, sessionRef('a'))?.name).toBe('A renamed')
    expect(recordAt(state, sessionRef('b'))?.name).toBe('B name')
  })

  describe('redirects', () => {
    it('remaps a pending binding to the durable target, keeping the highest target revision', () => {
      let state = sessionNamesReducer(undefined, { type: 'init' })
      // A pre-durable name exists on the pending handle at revision 4.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(pendingRef('h1'), 'Pre-identity name', 4), 10),
      ]))
      // Verified materialization: the record moves to the durable identity at
      // revision 4 (bind allocates a revision even with unchanged text).
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Pre-identity name', 4), 12, {
          redirects: [{ from: pendingRef('h1'), to: sessionRef('s1'), revision: 4 }],
        }),
      ]))
      expect(recordAt(state, sessionRef('s1'))?.name).toBe('Pre-identity name')
      expect(recordAt(state, sessionRef('s1'))?.revision).toBe(4)
      // The pending record was remapped away — a stale pending-key echo cannot win.
      expect(recordAt(state, pendingRef('h1'))).toBeUndefined()
      expect(state.redirects[sessionNameRefKey(pendingRef('h1'))]?.toKey).toBe(sessionNameRefKey(sessionRef('s1')))
    })

    it('keeps the newer target record when a stale redirect pair arrives late', () => {
      let state = sessionNamesReducer(undefined, { type: 'init' })
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(pendingRef('h1'), 'Fresh pending', 6), 10),
      ]))
      // Durable materialization at revision 6 with redirect revision 1.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Fresh durable', 7), 12, {
          redirects: [{ from: pendingRef('h1'), to: sessionRef('s1'), revision: 1 }],
        }),
      ]))
      // A LATE update still addressed to the pending handle resolved server-side
      // to the same durable record at a HIGHER revision (8). Its record.ref is
      // the durable ref, so it folds onto the durable key and must win.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Renamed through pending', 8), 14),
      ]))
      expect(recordAt(state, sessionRef('s1'))?.name).toBe('Renamed through pending')
      // A stale redirect revision does not replace the newer redirect.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Renamed through pending', 8), 14, {
          redirects: [{ from: pendingRef('h1'), to: sessionRef('s0'), revision: 1 }],
        }),
      ]))
      expect(state.redirects[sessionNameRefKey(pendingRef('h1'))]?.toKey).toBe(sessionNameRefKey(sessionRef('s1')))
    })

    it('treats an equal-revision redirect with a different target as a protocol error and keeps the first target', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      let state = sessionNamesReducer(undefined, { type: 'init' })
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'N', 1), 10, {
          redirects: [{ from: pendingRef('h1'), to: sessionRef('s1'), revision: 5 }],
        }),
      ]))
      // Same redirect revision, a DIFFERENT durable target: symmetric with
      // the equal-revision record case, this is logged as a protocol error
      // and the existing redirect is retained.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s2'), 'N', 1), 11, {
          redirects: [{ from: pendingRef('h1'), to: sessionRef('s2'), revision: 5 }],
        }),
      ]))
      expect(state.redirects[sessionNameRefKey(pendingRef('h1'))]?.toKey).toBe(sessionNameRefKey(sessionRef('s1')))
      expect(errorSpy).toHaveBeenCalled()
    })
  })

  describe('nativeSync', () => {
    it('folds nativeSync by documentGeneration: a newer status-only update refreshes status without retitling', () => {
      let state = sessionNamesReducer(undefined, { type: 'init' })
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Final name', 5), 50, {
          nativeSync: { status: 'pending', desiredRevision: 5, locationRevision: 1 },
        }),
      ]))
      // Status-only update: same record revision, newer documentGeneration,
      // changed:false — the native sync moved on but the name did not.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Final name', 5), 60, {
          changed: false,
          nativeSync: { status: 'unsynced', desiredRevision: 5, locationRevision: 1, reason: 'provider timeout' },
        }),
      ]))
      expect(recordAt(state, sessionRef('s1'))?.name).toBe('Final name')
      expect(state.nativeSync[sessionNameRefKey(sessionRef('s1'))]?.sync.status).toBe('unsynced')
      expect(state.nativeSync[sessionNameRefKey(sessionRef('s1'))]?.sync.reason).toBe('provider timeout')
    })

    it('a stale nativeSync generation never demotes a newer one', () => {
      let state = sessionNamesReducer(undefined, { type: 'init' })
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'N', 5), 60, {
          nativeSync: { status: 'synced', desiredRevision: 5, locationRevision: 2 },
        }),
      ]))
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'N', 5), 50, {
          nativeSync: { status: 'pending', desiredRevision: 5, locationRevision: 1 },
        }),
      ]))
      expect(state.nativeSync[sessionNameRefKey(sessionRef('s1'))]?.sync.status).toBe('synced')
    })

    it('keys nativeSync by the redirect-resolved ref: a late pending-keyed status lands on the durable key', () => {
      let state = sessionNamesReducer(undefined, { type: 'init' })
      // Materialization: the record is at the durable identity and the
      // pending→durable redirect is folded.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Durable name', 4), 12, {
          redirects: [{ from: pendingRef('h1'), to: sessionRef('s1'), revision: 4 }],
        }),
      ]))
      // A late status push still addressed to the pending handle must park
      // its nativeSync at the RESOLVED (durable) key, not the orphaned
      // pending key.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(pendingRef('h1'), 'Durable name', 4), 15, {
          changed: false,
          nativeSync: { status: 'unsynced', desiredRevision: 4, locationRevision: 1, reason: 'provider timeout' },
        }),
      ]))
      expect(state.nativeSync[sessionNameRefKey(sessionRef('s1'))]?.sync.status).toBe('unsynced')
      expect(state.nativeSync[sessionNameRefKey(sessionRef('s1'))]?.sync.reason).toBe('provider timeout')
      expect(state.nativeSync[sessionNameRefKey(pendingRef('h1'))]).toBeUndefined()
    })

    it('a changed:false status-only update with a LOWER record revision never retitles', () => {
      let state = sessionNamesReducer(undefined, { type: 'init' })
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Manual rename', 9), 70),
      ]))
      // A late generation pipeline echo reports the OLD revision's text.
      state = sessionNamesReducer(state, receiveSessionNames([
        update(record(sessionRef('s1'), 'Stale pipeline name', 6), 80, { changed: false }),
      ]))
      expect(recordAt(state, sessionRef('s1'))?.name).toBe('Manual rename')
    })
  })

  it('ingests bare last-known projections by revision (directory/inventory snapshots)', () => {
    let state = sessionNamesReducer(undefined, { type: 'init' })
    state = sessionNamesReducer(state, receiveSessionNameProjections([
      { ref: sessionRef('s1'), record: record(sessionRef('s1'), 'Directory title', 2, 'directory') },
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Directory title')
    // A newer canonical update beats the projection.
    state = sessionNamesReducer(state, receiveSessionNames([
      update(record(sessionRef('s1'), 'Freshell AI name', 3, 'freshell_ai'), 25),
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Freshell AI name')
    // A stale projection never rolls it back.
    state = sessionNamesReducer(state, receiveSessionNameProjections([
      { ref: sessionRef('s1'), record: record(sessionRef('s1'), 'Directory title', 2, 'directory') },
    ]))
    expect(recordAt(state, sessionRef('s1'))?.name).toBe('Freshell AI name')
  })
})

describe('sessionNamesIngestMiddleware', () => {
  function buildStore(preloaded?: Record<string, unknown>) {
    return configureStore({
      reducer: {
        sessionNames: sessionNamesReducer,
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        terminalDirectory: terminalDirectoryReducer,
      },
      middleware: (getDefault) => getDefault({ serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] } })
        .concat(sessionNamesIngestMiddleware),
      preloadedState: preloaded as never,
    })
  }

  it('ingests terminal-directory rows carrying sessionName/nameRef records', () => {
    const store = buildStore()
    const rowSessionName = record(sessionRef('term-sess'), 'Terminal row name', 4, 'first_message')
    store.dispatch({
      type: 'terminalDirectory/setTerminalDirectoryWindowData',
      payload: {
        surface: 'sidebar',
        items: [
          {
            terminalId: 'term-1',
            title: 'stale inventory string',
            mode: 'claude',
            createdAt: 1,
            lastActivityAt: 1,
            status: 'running',
            hasClients: true,
            sessionRef: { provider: 'claude', sessionId: 'term-sess' },
            nameRef: sessionRef('term-sess'),
            sessionName: rowSessionName,
          },
        ],
      },
    })
    const state = store.getState().sessionNames
    expect(state.records[sessionNameRefKey(sessionRef('term-sess'))]?.name).toBe('Terminal row name')
  })

  it('ingests nothing from session-directory window commits (rows carry only a name string projection)', () => {
    const store = buildStore()
    store.dispatch({
      type: 'sessions/commitSessionWindowReplacement',
      payload: {
        surface: 'sidebar',
        projects: [
          {
            projectPath: '/repo',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'dir-1',
                projectPath: '/repo',
                lastActivityAt: 1,
                nameRef: sessionRef('dir-1'),
                // The directory row's additive projection is a plain name
                // STRING (no revision) — it can never enter the cache.
                sessionName: 'Row title',
              },
            ],
          },
        ],
      },
    })
    expect(store.getState().sessionNames.records).toEqual({})
  })
})
