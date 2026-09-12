import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import { getEditorActions } from '@/lib/pane-action-registry'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'

vi.mock('@monaco-editor/react', () => ({ default: () => <textarea aria-label="Editor" />, Editor: () => <textarea aria-label="Editor" /> }))

function store() {
  const value = configureStore({ reducer: { panes: panesReducer, settings: settingsReducer, connection: connectionReducer } })
  value.dispatch(setStatus('ready'))
  return value
}

describe('EditorPane Rust baseline actions', () => {
  it('does not register external editor or reveal actions while retaining save', () => {
    const value = store()
    render(<Provider store={value}><EditorPane paneId="editor" tabId="tab" filePath="/tmp/a.md" language="markdown" content="# hi" /></Provider>)
    expect(screen.getByRole('textbox', { name: 'Editor' })).toBeInTheDocument()
    const actions = getEditorActions('editor') as Record<string, unknown>
    expect(actions.saveNow).toBeTypeOf('function')
    expect(actions.openInEditor).toBeUndefined()
    expect(actions.revealInExplorer).toBeUndefined()
  })
})
