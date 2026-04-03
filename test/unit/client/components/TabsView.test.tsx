import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../../src/store/panesSlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '../../../../src/store/tabRegistrySlice'
import connectionReducer, { setServerInstanceId } from '../../../../src/store/connectionSlice'
import TabsView from '../../../../src/components/TabsView'

const wsMock = {
  state: 'ready',
  sendTabsSyncQuery: vi.fn(),
  sendTabsSyncPush: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn(() => Promise.resolve(true)),
}))

function createStore() {
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
      connection: connectionReducer,
    },
  })

  store.dispatch(addTab({ id: 'local-tab', title: 'local tab', mode: 'shell' }))
  store.dispatch(initLayout({
    tabId: 'local-tab',
    content: { kind: 'terminal', mode: 'shell' },
  }))

  store.dispatch(setTabRegistrySnapshot({
    localOpen: [],
    remoteOpen: [{
      tabKey: 'remote:open',
      tabId: 'open-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote',
      deviceLabel: 'remote-device',
      tabName: 'remote open',
      status: 'open',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
    closed: [{
      tabKey: 'remote:closed',
      tabId: 'closed-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote',
      deviceLabel: 'remote-device',
      tabName: 'remote closed',
      status: 'closed',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
  }))

  return store
}

describe('TabsView', () => {
  beforeEach(() => {
    wsMock.sendTabsSyncQuery.mockClear()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders device-centric sections with local, remote, and closed groups', () => {
    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    // Local device section (h2 heading)
    const headings = [...container.querySelectorAll('h2')].map((n) => n.textContent?.trim())
    expect(headings.some((h) => h?.includes('This device'))).toBe(true)

    // Remote tab card is present (aria-label includes device:tabname)
    expect(screen.getByLabelText('remote-device: remote open')).toBeInTheDocument()

    // Closed section exists (collapsible button)
    expect(screen.getByLabelText(/Expand Recently closed/i)).toBeInTheDocument()
  })

  it('renders tab cards as accessible buttons with aria-labels', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const remoteCard = screen.getByLabelText('remote-device: remote open')
    expect(remoteCard.tagName).toBe('BUTTON')
  })

  it('opens a copy when clicking a remote tab card', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const remoteCard = screen.getByLabelText('remote-device: remote open')
    fireEvent.click(remoteCard)

    const tabs = store.getState().tabs.tabs
    expect(tabs).toHaveLength(2) // local-tab + new copy
    expect(tabs.some((t) => t.title === 'remote open')).toBe(true)
  })

  it('shows context menu on right-click with appropriate items', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const remoteCard = screen.getByLabelText('remote-device: remote open')
    fireEvent.contextMenu(remoteCard)

    // Context menu should appear with "Pull to this device" and "Copy tab name"
    expect(screen.getByRole('menuitem', { name: /Pull to this device/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Copy tab name/i })).toBeInTheDocument()
  })

  it('groups remote tabs by device', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })

    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [
        {
          tabKey: 'dev1:tab1',
          tabId: 't1',
          serverInstanceId: 'srv-1',
          deviceId: 'device-1',
          deviceLabel: 'Laptop',
          tabName: 'tab one',
          status: 'open',
          revision: 1,
          createdAt: 1,
          updatedAt: 2,
          paneCount: 1,
          titleSetByUser: false,
          panes: [],
        },
        {
          tabKey: 'dev1:tab2',
          tabId: 't2',
          serverInstanceId: 'srv-1',
          deviceId: 'device-1',
          deviceLabel: 'Laptop',
          tabName: 'tab two',
          status: 'open',
          revision: 1,
          createdAt: 1,
          updatedAt: 3,
          paneCount: 1,
          titleSetByUser: false,
          panes: [],
        },
        {
          tabKey: 'dev2:tab3',
          tabId: 't3',
          serverInstanceId: 'srv-2',
          deviceId: 'device-2',
          deviceLabel: 'Desktop',
          tabName: 'tab three',
          status: 'open',
          revision: 1,
          createdAt: 1,
          updatedAt: 4,
          paneCount: 1,
          titleSetByUser: false,
          panes: [],
        },
      ],
      closed: [],
    }))

    const { container } = render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    // Both device groups should render as h2 headings
    const headings = [...container.querySelectorAll('h2')].map((n) => n.textContent?.trim())
    expect(headings).toContain('Laptop')
    expect(headings).toContain('Desktop')

    // All tab cards are present
    expect(screen.getByLabelText('Laptop: tab one')).toBeInTheDocument()
    expect(screen.getByLabelText('Laptop: tab two')).toBeInTheDocument()
    expect(screen.getByLabelText('Desktop: tab three')).toBeInTheDocument()

    // "Pull all" button visible for multi-tab device group
    expect(screen.getByLabelText('Pull all tabs from Laptop')).toBeInTheDocument()
  })

  it('drops resumeSessionId when opening remote copy from another server instance', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setServerInstanceId('srv-local'))
    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'remote:session-copy',
        tabId: 'open-2',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'session remote',
        status: 'open',
        revision: 2,
        createdAt: 2,
        updatedAt: 3,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-remote',
          kind: 'terminal',
          payload: {
            mode: 'codex',
            resumeSessionId: 'codex-session-123',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-123',
              serverInstanceId: 'srv-remote',
            },
          },
        }],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    // Click the card directly (primary action = open copy for remote tabs)
    const remoteCard = screen.getByLabelText('remote-device: session remote')
    fireEvent.click(remoteCard)

    const tabs = store.getState().tabs.tabs
    const newTab = tabs.find((tab) => tab.title === 'session remote')
    expect(newTab).toBeTruthy()
    const layout = newTab ? (store.getState().panes.layouts[newTab.id] as any) : undefined
    expect(layout?.content?.resumeSessionId).toBeUndefined()
    expect(layout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-remote',
    })
  })

  it('shows pane kind icons with distinct colors', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'multi:pane',
        tabId: 'mp-1',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'multi-pane tab',
        status: 'open',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        paneCount: 3,
        titleSetByUser: false,
        panes: [
          { paneId: 'p1', kind: 'terminal', payload: {} },
          { paneId: 'p2', kind: 'browser', payload: {} },
          { paneId: 'p3', kind: 'agent-chat', payload: {} },
        ],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const card = screen.getByLabelText('remote-device: multi-pane tab')
    // Each unique pane kind gets an icon with aria-label
    expect(within(card).getByLabelText('Terminal')).toBeInTheDocument()
    expect(within(card).getByLabelText('Browser')).toBeInTheDocument()
    expect(within(card).getByLabelText('Agent')).toBeInTheDocument()
    expect(within(card).getByText('3 panes')).toBeInTheDocument()
  })

  it('shows individual pane items in context menu for multi-pane tabs', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })
    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [{
        tabKey: 'multi:ctx',
        tabId: 'mc-1',
        serverInstanceId: 'srv-remote',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'ctx tab',
        status: 'open',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        paneCount: 2,
        titleSetByUser: false,
        panes: [
          { paneId: 'p1', kind: 'terminal', title: 'my-shell', payload: {} },
          { paneId: 'p2', kind: 'browser', title: 'docs', payload: {} },
        ],
      }],
      closed: [],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const card = screen.getByLabelText('remote-device: ctx tab')
    fireEvent.contextMenu(card)

    expect(screen.getByRole('menuitem', { name: /Open my-shell in new tab/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Open docs in new tab/i })).toBeInTheDocument()
  })

  it('filters by status using segmented control', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    // Click "Open" filter
    const statusGroup = screen.getByRole('radiogroup', { name: 'Tab status filter' })
    fireEvent.click(within(statusGroup).getByText('Open'))

    // Remote open tab should be visible
    expect(screen.getByLabelText('remote-device: remote open')).toBeInTheDocument()

    // Closed section should not be visible
    expect(screen.queryByLabelText(/Recently closed/i)).not.toBeInTheDocument()
  })

  it('filters by device scope using segmented control', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const scopeGroup = screen.getByRole('radiogroup', { name: 'Device scope filter' })
    fireEvent.click(within(scopeGroup).getByText('This device'))

    // Remote tab should not be visible when filtered to local
    expect(screen.queryByLabelText('remote-device: remote open')).not.toBeInTheDocument()
  })
})
