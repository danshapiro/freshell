import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ExtensionPane from '@/components/panes/ExtensionPane'
import extensionsReducer from '@/store/extensionsSlice'
import type { ClientExtensionEntry } from '@shared/extension-types'

function renderPane(entry: ClientExtensionEntry) {
  const store = configureStore({ reducer: { extensions: extensionsReducer }, preloadedState: { extensions: { entries: [entry] } } })
  return render(<Provider store={store}><ExtensionPane tabId="tab" paneId="pane" content={{ kind: 'extension', extensionName: entry.name, props: {} }} /></Provider>)
}

describe('ExtensionPane Rust baseline', () => {
  it.each(['server', 'client'] as const)('renders an accessible unsupported panel for %s extensions', (category) => {
    cleanup()
    renderPane({ name: `${category}-extension`, version: '1', label: 'Example extension', description: '', category })
    expect(screen.getByRole('status', { name: 'Unsupported extension pane' })).toHaveTextContent('This extension pane is unavailable with the Rust server baseline.')
    expect(screen.queryByTitle('Example extension')).toBeNull()
  })
})
