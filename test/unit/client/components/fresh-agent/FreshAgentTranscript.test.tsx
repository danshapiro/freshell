import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

// Render markdown bodies synchronously. The real LazyMarkdown wraps MarkdownRenderer
// in React.lazy + Suspense; mocking it to render MarkdownRenderer directly removes
// the fallback->content swap so assertions don't race the chunk load. Matches the
// mock used by the agent-chat MessageBubble tests.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

describe('FreshAgentTranscript', () => {
  afterEach(() => cleanup())

  it('renders normalized text turns', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            items: [{ id: 'item-1', kind: 'text', text: 'Hello from Fresh Agent' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('Assistant')).toBeInTheDocument()
    expect(screen.getByText('Hello from Fresh Agent')).toBeInTheDocument()
  })

  it('renders assistant text as markdown', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'markdown turn',
            items: [{
              id: 'item-1',
              kind: 'text',
              text: '## Root cause\n\nA **bold move** with `attachEpoch` and a [link](https://example.com).',
            }],
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Root cause' })).toBeInTheDocument()
    expect(screen.getByText('bold move').tagName).toBe('STRONG')
    expect(screen.getByText('attachEpoch').tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: /link/ })).toHaveAttribute('href', 'https://example.com')
  })

  it('keeps user text literal, never interpreted as markdown', () => {
    const { container } = render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'user',
            summary: 'user turn',
            items: [{ id: 'item-1', kind: 'text', text: '**not bold** and # not a heading' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('**not bold** and # not a heading')).toBeInTheDocument()
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
  })

  it('coalesces paired tool calls into the activity strip and expands details', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'used tools',
            items: [
              {
                id: 'tool-1',
                kind: 'tool_use',
                toolUseId: 'call-1',
                name: 'Bash',
                input: { command: 'find . -name "*.md"', description: 'Find markdown files' },
              },
              {
                id: 'result-1',
                kind: 'tool_result',
                toolUseId: 'call-1',
                content: 'README.md\nAGENTS.md',
                isError: false,
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('1 tool used')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bash tool call' }))
    expect(screen.getByText('find . -name "*.md"')).toBeInTheDocument()
  })

  it('merges consecutive thinking chunks into one row', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'streamed thinking',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'first fragment' },
              { id: 'think-2', kind: 'thinking', text: 'second fragment' },
              {
                id: 'tool-1',
                kind: 'tool_use',
                toolUseId: 'call-1',
                name: 'Bash',
                input: { command: 'true' },
              },
              { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              { id: 'item-1', kind: 'text', text: 'done' },
            ],
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    const thinkingRows = screen.getAllByRole('button', { name: 'Thinking' })
    expect(thinkingRows).toHaveLength(1)
    fireEvent.click(thinkingRows[0])
    expect(screen.getAllByText(/first fragment/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/second fragment/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders summary-only assistant turns as markdown', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'use `attachEpoch` to guard the close handler',
            items: [],
          },
        ]}
      />,
    )

    expect(screen.getByText('attachEpoch').tagName).toBe('CODE')
  })

  it('folds thinking into the activity strip with tools', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thought then ran',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'the race is in the close handler' },
              {
                id: 'tool-1',
                kind: 'tool_use',
                toolUseId: 'call-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
              { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              { id: 'item-1', kind: 'text', text: 'All green.' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('thought · 1 tool used')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
  })

  it('shows a live reel while a tool is running', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'running',
            items: [
              {
                id: 'tool-1',
                kind: 'tool_use',
                toolUseId: 'call-1',
                name: 'Bash',
                input: { command: 'npm run check' },
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByLabelText('running')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })

  it('treats trailing thinking in the latest turn as live activity', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thinking',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'still reasoning about the fix' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByLabelText('running')).toBeInTheDocument()
    expect(screen.getByText('Thinking')).toBeInTheDocument()
  })

  it('counts files changed in the settled summary', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'edited files',
            items: [
              {
                id: 'edit-1',
                kind: 'tool_use',
                toolUseId: 'edit-call',
                name: 'Edit',
                input: { file_path: 'README.md', old_string: 'a', new_string: 'b' },
              },
              { id: 'edit-result', kind: 'tool_result', toolUseId: 'edit-call', content: 'ok', isError: false },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: 'Activity strip' }))
      .toHaveTextContent('1 tool used · 1 file changed')
  })

  it('strips system reminders and collapses older turns', () => {
    render(
      <FreshAgentTranscript
        turns={Array.from({ length: 9 }, (_, index) => ({
          id: `turn-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          summary: `turn ${index}`,
          items: [{
            id: `item-${index}`,
            kind: 'text',
            text: index === 0
              ? 'visible <system-reminder>hidden internals</system-reminder>'
              : `message ${index}`,
          }],
        }))}
      />,
    )

    expect(screen.getByRole('button', { name: 'Expand turn' })).toHaveTextContent('visible')
    expect(screen.queryByText(/hidden internals/)).not.toBeInTheDocument()
  })

  describe('turn actions', () => {
    const TURNS = [
      {
        id: 'turn-1',
        turnId: 'turn-1',
        role: 'user' as const,
        summary: 'ask',
        items: [{ id: 'item-1', kind: 'text' as const, text: 'fix the bug' }],
      },
      {
        id: 'turn-2',
        turnId: 'turn-2',
        role: 'assistant' as const,
        summary: 'answer',
        items: [{ id: 'item-2', kind: 'text' as const, text: 'done' }],
      },
    ]

    it('renders a hover toolbar with copy and capability-gated fork', () => {
      const onFork = vi.fn()
      render(<FreshAgentTranscript turns={TURNS} canFork onForkFromTurn={onFork} />)

      const toolbars = screen.getAllByRole('toolbar', { name: 'Turn actions' })
      expect(toolbars).toHaveLength(2)
      const forkButtons = screen.getAllByRole('button', { name: 'Fork conversation from here' })
      fireEvent.click(forkButtons[0])
      expect(onFork).toHaveBeenCalledWith('turn-1')
    })

    it('hides fork affordances without the capability', () => {
      render(<FreshAgentTranscript turns={TURNS} canFork={false} />)
      expect(screen.queryByRole('button', { name: 'Fork conversation from here' })).not.toBeInTheDocument()
    })

    it('opens a context menu on right-click with fork wired to the turn', () => {
      const onFork = vi.fn()
      render(<FreshAgentTranscript turns={TURNS} canFork onForkFromTurn={onFork} />)

      fireEvent.contextMenu(screen.getByRole('article', { name: 'Assistant transcript turn' }))
      const menu = screen.getByRole('menu', { name: 'Turn context menu' })
      expect(menu).toHaveTextContent('Copy turn text')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Fork conversation from here' }))
      expect(onFork).toHaveBeenCalledWith('turn-2')
    })

    it('offers rewind only on user turns and passes the turn through', () => {
      const onRewind = vi.fn()
      render(<FreshAgentTranscript turns={TURNS} canFork={false} onRewindToTurn={onRewind} />)

      const rewindButtons = screen.getAllByRole('button', { name: 'Rewind code to here' })
      expect(rewindButtons).toHaveLength(1)
      fireEvent.click(rewindButtons[0])
      expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ id: 'turn-1', role: 'user' }))
    })

    it('disables rewind in the context menu for assistant turns', () => {
      const onRewind = vi.fn()
      render(<FreshAgentTranscript turns={TURNS} canFork={false} onRewindToTurn={onRewind} />)

      fireEvent.contextMenu(screen.getByRole('article', { name: 'Assistant transcript turn' }))
      const item = screen.getByRole('menuitem', { name: 'Rewind code to here' })
      expect(item).toBeDisabled()
    })
  })
})
