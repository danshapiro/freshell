import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import OverviewView from '@/components/OverviewView'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import type { SessionNameRecord, SessionNameRef, SessionNameUpdate } from '@shared/session-names'

const { mockApiGet, mockApiPatch, mockApiDelete, mockApiPost, wsMessageHandlers } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPatch: vi.fn(),
  mockApiDelete: vi.fn(),
  mockApiPost: vi.fn(),
  wsMessageHandlers: new Set<(msg: unknown) => void>(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string, options?: unknown) => mockApiGet(path, options),
    patch: (path: string, body: unknown, options?: unknown) => mockApiPatch(path, body, options),
    delete: (path: string) => mockApiDelete(path),
    post: (path: string) => mockApiPost(path),
  },
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    onMessage: (handler: (msg: unknown) => void) => {
      wsMessageHandlers.add(handler)
      return () => { wsMessageHandlers.delete(handler) }
    },
  }),
}))

const nameRef: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 'sess-1' }

const rowRecord: SessionNameRecord = {
  ref: nameRef,
  name: 'Row last-known name',
  source: 'first_message',
  revision: 3,
}

function scopedRow(overrides: Record<string, unknown> = {}) {
  return {
    terminalId: 'term-1',
    title: 'Terminal-level title',
    description: 'A terminal',
    createdAt: 1_000,
    lastActivityAt: 2_000,
    status: 'running',
    hasClients: false,
    mode: 'claude',
    nameRef,
    sessionName: rowRecord,
    ...overrides,
  }
}

function updateOf(
  rec: SessionNameRecord,
  documentGeneration: number,
  extra: Partial<SessionNameUpdate> = {},
): SessionNameUpdate {
  return { record: rec, documentGeneration, redirects: [], changed: true, ...extra }
}

function buildStore() {
  return configureStore({
    reducer: {
      sessionNames: sessionNamesReducer,
      tabs: tabsReducer,
      panes: panesReducer,
    },
    preloadedState: {
      tabs: { tabs: [], activeTabId: null },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    } as never,
  })
}

function renderOverview(store: ReturnType<typeof buildStore>) {
  return render(
    <Provider store={store}>
      <OverviewView />
    </Provider>,
  )
}

const retainedCases = [
  { recoveryState: 'blocked', runtimeStatus: 'blocked', paneStatus: 'error', label: 'Blocked' },
  { recoveryState: 'lost', runtimeStatus: 'exited', paneStatus: 'error', label: 'Lost' },
  { recoveryState: 'stopped', runtimeStatus: 'exited', paneStatus: 'exited', label: 'Stopped' },
] as const

function retainedRow({ recoveryState, runtimeStatus }: typeof retainedCases[number]) {
  return scopedRow({
    status: runtimeStatus,
    runtimeStatus,
    soulId: 'soul-retained',
    recoverySummary: {
      desiredState: 'running', recoveryState, reason: 'STORE_UNREADABLE',
      attemptId: 'attempt-retained', incidentId: 'incident-retained',
    },
  })
}

describe('OverviewView terminal cards — unified agent names', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiPatch.mockReset()
    mockApiDelete.mockReset()
    mockApiPost.mockReset()
    wsMessageHandlers.clear()
  })

  afterEach(() => cleanup())

  it.each(retainedCases)('shows the retained $recoveryState reason and status without counting it as running', async (row) => {
    mockApiGet.mockResolvedValue([retainedRow(row)])
    renderOverview(buildStore())
    const card = await screen.findByRole('button', { name: 'Open terminal Row last-known name' })
    expect(within(card).getByText('STORE_UNREADABLE')).toBeVisible()
    expect(within(card).getByText(row.label)).toBeVisible()
    expect(screen.getByText(`0 running, ${row.runtimeStatus === 'exited' ? 1 : 0} exited`)).toBeVisible()
  })

  it.each(retainedCases)('opens the retained $recoveryState card with its exact status and existing identity', async (row) => {
    mockApiGet.mockResolvedValue([retainedRow(row)])
    const store = buildStore()
    renderOverview(store)
    const card = await screen.findByRole('button', { name: 'Open terminal Row last-known name' })
    fireEvent.click(card)
    const [tab] = store.getState().tabs.tabs
    const layout = store.getState().panes.layouts[tab.id]
    expect(layout.type).toBe('leaf')
    if (layout.type !== 'leaf') throw new Error('expected leaf')
    expect(layout.content).toMatchObject({
      terminalId: 'term-1', mode: 'claude', soulId: 'soul-retained', runtimeStatus: row.runtimeStatus,
    })
    expect(layout.content.status).toBe(row.paneStatus)
    expect(tab.status).toBe(layout.content.status)
    expect(layout.content).toMatchObject({ recoverySummary: { reason: 'STORE_UNREADABLE',
      attemptId: 'attempt-retained', incidentId: 'incident-retained' } })
    expect(mockApiPost).not.toHaveBeenCalled()
  })

  it('resolves a scoped card display through the live canonical cache without a directory refetch', async () => {
    mockApiGet.mockResolvedValue([scopedRow()])
    const store = buildStore()
    renderOverview(store)

    expect(await screen.findByText('Row last-known name')).toBeVisible()

    // A rename lands through the canonical cache (session.name.updated fold) —
    // the card must converge immediately, before any directory refetch.
    act(() => {
      store.dispatch(receiveSessionNames([
        updateOf({ ref: nameRef, name: 'Renamed elsewhere', source: 'manual', revision: 4 }, 10),
      ]))
    })
    await waitFor(() => {
      expect(screen.getByText('Renamed elsewhere')).toBeVisible()
    })
    expect(screen.queryByText('Row last-known name')).not.toBeInTheDocument()
    // No refetch was needed for convergence: the directory fetch answered
    // exactly the initial load.
    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })

  it('shows a nonblocking native-sync status on a scoped terminal card', async () => {
    mockApiGet.mockResolvedValue([scopedRow()])
    const store = buildStore()
    renderOverview(store)

    expect(await screen.findByText('Row last-known name')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => {
      store.dispatch(receiveSessionNames([
        updateOf({ ref: nameRef, name: 'Row last-known name', source: 'first_message', revision: 3 }, 12, {
          nativeSync: {
            status: 'unsynced',
            desiredRevision: 3,
            locationRevision: 1,
            reason: 'provider writeback timed out',
          },
        }),
      ]))
    })

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(/native sync: unsynced/i)
    expect(status).toHaveTextContent(/provider writeback timed out/i)
    // Nonblocking display only: the status row itself carries no control
    // (retry/reset/generate); the card's pre-existing action buttons are
    // untouched by it.
    expect(within(status).queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not reset the edit form when a row refresh lands mid-edit', async () => {
    mockApiGet.mockResolvedValue([scopedRow()])
    const store = buildStore()
    renderOverview(store)

    expect(await screen.findByText('Row last-known name')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Edit terminal' }))
    const input = screen.getByLabelText('Terminal title') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'My in-progress edit' } })

    // A refresh lands a NEW row object (identity change via lastActivityAt)
    // while the user is mid-edit.
    mockApiGet.mockResolvedValue([scopedRow({ lastActivityAt: 3_000 })])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh terminals' }))
    await waitFor(() => { expect(mockApiGet).toHaveBeenCalledTimes(2) })
    // Wait until the refresh fully settles (the button leaves its loading state).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refresh terminals' })).toBeTruthy()
    })

    expect((screen.getByLabelText('Terminal title') as HTMLInputElement).value).toBe('My in-progress edit')
  })

  it('keeps an out-of-scope terminal card on its terminal-level title (non-agent non-regression)', async () => {
    mockApiGet.mockResolvedValue([scopedRow({
      terminalId: 'term-shell',
      mode: 'shell',
      nameRef: undefined,
      sessionName: undefined,
      title: 'Shell terminal title',
      description: undefined,
    })])
    const store = buildStore()
    renderOverview(store)

    expect(await screen.findByText('Shell terminal title')).toBeVisible()

    // Canonical cache activity for other sessions never touches the shell row.
    act(() => {
      store.dispatch(receiveSessionNames([
        updateOf({ ref: nameRef, name: 'Renamed elsewhere', source: 'manual', revision: 4 }, 10),
      ]))
    })
    expect(screen.getByText('Shell terminal title')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
