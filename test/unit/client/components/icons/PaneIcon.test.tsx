import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PaneIcon from '@/components/icons/PaneIcon'
import type { PaneContent } from '@/store/paneTypes'

// Mock provider-icons to return testable elements
vi.mock('@/components/icons/provider-icons', () => ({
  ProviderIcon: ({ provider, ...props }: any) => (
    <svg data-testid={`provider-icon-${provider}`} {...props} />
  ),
  FreshclaudeIcon: (props: any) => (
    <svg data-testid="freshclaude-icon" {...props} />
  ),
}))

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Terminal: (props: any) => <svg data-testid="terminal-icon" {...props} />,
  Globe: (props: any) => <svg data-testid="globe-icon" {...props} />,
  FileText: (props: any) => <svg data-testid="file-text-icon" {...props} />,
  LayoutGrid: (props: any) => <svg data-testid="layout-grid-icon" {...props} />,
}))

function makeTerminal(mode: string, shell?: string): PaneContent {
  return {
    kind: 'terminal',
    mode: mode as any,
    shell: (shell ?? 'system') as any,
    createRequestId: 'req-1',
    status: 'running',
  }
}

describe('PaneIcon', () => {
  afterEach(cleanup)

  it('renders provider icon for claude mode', () => {
    render(<PaneIcon content={makeTerminal('claude')} />)
    expect(screen.getByTestId('provider-icon-claude')).toBeInTheDocument()
  })

  it('renders provider icon for codex mode', () => {
    render(<PaneIcon content={makeTerminal('codex')} />)
    expect(screen.getByTestId('provider-icon-codex')).toBeInTheDocument()
  })

  it('renders provider icon for opencode mode', () => {
    render(<PaneIcon content={makeTerminal('opencode')} />)
    expect(screen.getByTestId('provider-icon-opencode')).toBeInTheDocument()
  })

  it('renders provider icon for gemini mode', () => {
    render(<PaneIcon content={makeTerminal('gemini')} />)
    expect(screen.getByTestId('provider-icon-gemini')).toBeInTheDocument()
  })

  it('renders provider icon for kimi mode', () => {
    render(<PaneIcon content={makeTerminal('kimi')} />)
    expect(screen.getByTestId('provider-icon-kimi')).toBeInTheDocument()
  })

  it('renders terminal icon for shell mode', () => {
    render(<PaneIcon content={makeTerminal('shell')} />)
    expect(screen.getByTestId('terminal-icon')).toBeInTheDocument()
  })

  it('renders globe icon for browser panes', () => {
    render(<PaneIcon content={{ kind: 'browser', url: '', devToolsOpen: false }} />)
    expect(screen.getByTestId('globe-icon')).toBeInTheDocument()
  })

  it('renders file-text icon for editor panes', () => {
    render(
      <PaneIcon
        content={{
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        }}
      />
    )
    expect(screen.getByTestId('file-text-icon')).toBeInTheDocument()
  })

  it('renders freshclaude icon for claude-chat panes', () => {
    render(
      <PaneIcon
        content={{
          kind: 'claude-chat',
          createRequestId: 'req-1',
          status: 'idle',
        }}
      />
    )
    expect(screen.getByTestId('freshclaude-icon')).toBeInTheDocument()
  })

  it('renders layout-grid icon for picker panes', () => {
    render(<PaneIcon content={{ kind: 'picker' }} />)
    expect(screen.getByTestId('layout-grid-icon')).toBeInTheDocument()
  })

  it('passes className through to the rendered icon', () => {
    render(<PaneIcon content={makeTerminal('shell')} className="h-4 w-4 text-red-500" />)
    const icon = screen.getByTestId('terminal-icon')
    expect(icon.getAttribute('class')).toContain('h-4')
    expect(icon.getAttribute('class')).toContain('text-red-500')
  })
})
