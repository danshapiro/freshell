import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import EditorPane from '@/components/panes/EditorPane'
import panesReducer from '@/store/panesSlice'

// Mock Monaco to avoid loading issues in tests
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: any) => (
    <textarea
      data-testid="monaco-mock"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}))

const createMockStore = () =>
  configureStore({
    reducer: {
      panes: panesReducer,
    },
  })

describe('EditorPane', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders empty state with Open File button', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content=""
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /open file/i })).toBeInTheDocument()
  })

  it('renders Monaco editor when content is provided', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
  })

  it('renders toolbar with path input', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByPlaceholderText(/enter file path/i)).toBeInTheDocument()
  })

  it('shows view toggle for markdown files', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/readme.md"
          language="markdown"
          readOnly={false}
          content="# Hello"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /preview/i })).toBeInTheDocument()
  })

  it('hides view toggle for non-markdown/html files', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/code.ts"
          language="typescript"
          readOnly={false}
          content="const x = 1"
          viewMode="source"
        />
      </Provider>
    )

    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument()
  })

  it('renders markdown preview when viewMode is preview', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/readme.md"
          language="markdown"
          readOnly={false}
          content="# Hello World"
          viewMode="preview"
        />
      </Provider>
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
    expect(screen.queryByTestId('monaco-mock')).not.toBeInTheDocument()
  })

  it('renders HTML in iframe when viewMode is preview', () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/page.html"
          language="html"
          readOnly={false}
          content="<h1>Test</h1>"
          viewMode="preview"
        />
      </Provider>
    )

    expect(screen.getByTitle('HTML Preview')).toBeInTheDocument()
  })
})
