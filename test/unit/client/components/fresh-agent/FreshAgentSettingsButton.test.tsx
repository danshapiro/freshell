import { configureStore } from '@reduxjs/toolkit'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { useAppSelector } from '@/store/hooks'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function StoreBackedFreshAgentSettingsButton({
  tabId,
  paneId,
}: {
  tabId: string
  paneId: string
}) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentSettingsButton tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

beforeEach(() => {
  saveServerSettingsPatchSpy.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentSettingsButton', () => {
  it('persists model changes as fresh-agent provider model selections', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-model-settings',
        sessionId: 'thread-model-settings',
        status: 'idle',
        model: 'gpt-5.5',
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'GPT-5.4 Flash' }))

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'GPT-5.4 Flash' })).toBeChecked()
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: {
            modelSelection: { kind: 'exact', modelId: 'gpt-5.4-flash' },
            effort: 'high',
          },
        },
      },
    })
  })
})
