import { describe, expect, it, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabContent from '@/components/TabContent'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { createPerfAuditBridge, installPerfAuditBridge } from '@/lib/perf-audit-bridge'

describe('TabContent perf audit milestone', () => {
  afterEach(() => {
    cleanup()
    installPerfAuditBridge(null)
  })

  it('marks tab.selected_surface_visible when a background tab becomes the selected visible tab', async () => {
    const bridge = createPerfAuditBridge()
    installPerfAuditBridge(bridge)

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{ id: 'tab-1', title: 'Tab 1', mode: 'shell', createRequestId: 'tab-1', status: 'running' }],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
        },
        settings: {
          settings: defaultSettings,
          loaded: true,
          lastSavedAt: undefined,
        },
      },
    })

    const view = render(
      <Provider store={store}>
        <TabContent tabId="tab-1" hidden />
      </Provider>,
    )

    view.rerender(
      <Provider store={store}>
        <TabContent tabId="tab-1" hidden={false} />
      </Provider>,
    )

    expect(bridge.snapshot().milestones['tab.selected_surface_visible']).toBeTypeOf('number')
  })
})
