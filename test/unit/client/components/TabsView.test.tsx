import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '../../../../src/store/tabsSlice'
import panesReducer, { initLayout } from '../../../../src/store/panesSlice'
import tabRegistryReducer, {
  recordClosedTabSnapshot,
  setTabRegistrySnapshot,
} from '../../../../src/store/tabRegistrySlice'
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
    cleanup()
    wsMock.sendTabsSyncQuery.mockClear()
  })

  it('renders groups in order: local open, remote open, closed', () => {
    const store = createStore()
    const { container } = render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const headings = [...container.querySelectorAll('h2')].map((node) => node.textContent?.trim())
    expect(headings).toEqual([
      'Open on this device',
      'Open on other devices',
      'Closed',
    ])
    expect(screen.getByText('remote-device: remote open')).toBeInTheDocument()
    expect(screen.getByText('remote-device: remote closed')).toBeInTheDocument()
  })

  it('drops resumeSessionId when opening remote copy from another server instance', () => {
    const store = createStore()
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

    const remoteCardTitle = screen.getByText('remote-device: session remote')
    const remoteCard = remoteCardTitle.closest('article')
    expect(remoteCard).toBeTruthy()
    fireEvent.click(within(remoteCard as HTMLElement).getByText('Open copy'))

    const tabs = store.getState().tabs.tabs
    const newTab = tabs.find((tab) => tab.title === 'session remote')
    expect(newTab).toBeTruthy()
    expect(newTab?.titleSource).toBe('stable')
    const layout = newTab ? (store.getState().panes.layouts[newTab.id] as any) : undefined
    expect(layout?.content?.resumeSessionId).toBeUndefined()
    expect(layout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-123',
      serverInstanceId: 'srv-remote',
    })
  })

  it('does not fabricate an exact sessionRef from a named claude resume when reopening on the same server', () => {
    const store = createStore()
    store.dispatch(setServerInstanceId('srv-local'))
    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [],
      closed: [{
        tabKey: 'local:named-claude',
        tabId: 'closed-named-claude',
        serverInstanceId: 'srv-local',
        deviceId: 'remote',
        deviceLabel: 'remote-device',
        tabName: 'named claude',
        status: 'closed',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        closedAt: 3,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-claude',
          kind: 'terminal',
          payload: {
            mode: 'claude',
            resumeSessionId: 'named-claude-resume',
          },
        }],
      }],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const card = screen.getByText('remote-device: named claude').closest('article')
    expect(card).toBeTruthy()
    fireEvent.click(within(card as HTMLElement).getByText('Open copy'))

    const newTab = store.getState().tabs.tabs.find((tab) => tab.title === 'named claude')
    const layout = newTab ? (store.getState().panes.layouts[newTab.id] as any) : undefined
    expect(layout?.content?.resumeSessionId).toBe('named-claude-resume')
    expect(layout?.content?.sessionRef).toBeUndefined()
  })

  it('preserves resumeSessionId for same-device exact copies before local server identity is ready', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        tabRegistry: tabRegistryReducer,
        connection: connectionReducer,
      },
    })

    store.dispatch(addTab({ id: 'local-codex', title: 'local codex', mode: 'codex', status: 'running' }))
    store.dispatch(initLayout({
      tabId: 'local-codex',
      content: {
        kind: 'terminal',
        mode: 'codex',
        resumeSessionId: 'codex-session-local',
        sessionRef: {
          provider: 'codex',
          sessionId: 'codex-session-local',
          serverInstanceId: 'srv-local',
        },
      },
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const localCard = screen.getByText(/: local codex$/).closest('article')
    expect(localCard).toBeTruthy()
    fireEvent.click(within(localCard as HTMLElement).getByText('Open copy'))

    const copiedTab = store.getState().tabs.tabs.find((tab) => tab.id !== 'local-codex')
    expect(copiedTab?.title).toBe('local codex')
    const copiedLayout = copiedTab ? (store.getState().panes.layouts[copiedTab.id] as any) : undefined
    expect(copiedLayout?.content?.resumeSessionId).toBe('codex-session-local')
    expect(copiedLayout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-local',
      serverInstanceId: 'srv-local',
    })
  })

  it('drops mirrored resumeSessionId for same-device foreign exact snapshots before local server identity is ready', () => {
    const store = createStore()
    const localDeviceId = store.getState().tabRegistry.deviceId
    const localDeviceLabel = store.getState().tabRegistry.deviceLabel

    store.dispatch(setTabRegistrySnapshot({
      localOpen: [],
      remoteOpen: [],
      closed: [{
        tabKey: `${localDeviceId}:foreign-closed`,
        tabId: 'foreign-closed',
        serverInstanceId: 'srv-remote',
        deviceId: localDeviceId,
        deviceLabel: localDeviceLabel,
        tabName: 'foreign same-device closed',
        status: 'closed',
        revision: 3,
        createdAt: 3,
        updatedAt: 4,
        closedAt: 5,
        paneCount: 1,
        titleSetByUser: false,
        panes: [{
          paneId: 'pane-foreign-closed',
          kind: 'terminal',
          payload: {
            mode: 'codex',
            resumeSessionId: 'codex-session-foreign',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-foreign',
              serverInstanceId: 'srv-remote',
            },
          },
        }],
      }],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const card = screen.getByText(`${localDeviceLabel}: foreign same-device closed`).closest('article')
    expect(card).toBeTruthy()
    fireEvent.click(within(card as HTMLElement).getByText('Open copy'))

    const newTab = store.getState().tabs.tabs.find((tab) => tab.title === 'foreign same-device closed')
    const layout = newTab ? (store.getState().panes.layouts[newTab.id] as any) : undefined
    expect(layout?.content?.resumeSessionId).toBeUndefined()
    expect(layout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-foreign',
      serverInstanceId: 'srv-remote',
    })
  })

  it('does not grant pre-ready resume authority to closed local records before the current server identity is known', () => {
    const store = createStore()
    const { deviceId, deviceLabel } = store.getState().tabRegistry

    store.dispatch(recordClosedTabSnapshot({
      tabKey: `${deviceId}:closed-local-old`,
      tabId: 'closed-local-old',
      serverInstanceId: 'srv-old-local',
      deviceId,
      deviceLabel,
      tabName: 'closed local old server',
      status: 'closed',
      revision: 4,
      createdAt: 4,
      updatedAt: 5,
      closedAt: 6,
      paneCount: 1,
      titleSetByUser: false,
      panes: [{
        paneId: 'pane-closed-local-old',
        kind: 'terminal',
        payload: {
          mode: 'codex',
          resumeSessionId: 'codex-session-closed-local-old',
          sessionRef: {
            provider: 'codex',
            sessionId: 'codex-session-closed-local-old',
            serverInstanceId: 'srv-old-local',
          },
        },
      }],
    }))

    render(
      <Provider store={store}>
        <TabsView />
      </Provider>,
    )

    const card = screen.getByText(`${deviceLabel}: closed local old server`).closest('article')
    expect(card).toBeTruthy()
    fireEvent.click(within(card as HTMLElement).getByText('Open copy'))

    const newTab = store.getState().tabs.tabs.find((tab) => tab.title === 'closed local old server')
    const layout = newTab ? (store.getState().panes.layouts[newTab.id] as any) : undefined
    expect(layout?.content?.resumeSessionId).toBeUndefined()
    expect(layout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-session-closed-local-old',
      serverInstanceId: 'srv-old-local',
    })
  })
})
