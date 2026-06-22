import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

// Render markdown bodies synchronously. The real LazyMarkdown wraps MarkdownRenderer
// in React.lazy + Suspense; mocking it to render MarkdownRenderer directly removes
// the fallback->content swap so assertions don't race the chunk load. Matches the
// mock used by older transcript markdown tests.
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

  it('renders load-older controls and retries older history errors', () => {
    const onLoadOlder = vi.fn()

    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            items: [{ id: 'item-1', kind: 'text', text: 'Newest visible turn' }],
          },
        ]}
        hasOlderHistory
        historyError="Older history cursor expired"
        onLoadOlder={onLoadOlder}
      />,
    )

    expect(screen.getByText('Older history cursor expired')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('renders initial history loading before restored turns arrive', () => {
    render(<FreshAgentTranscript turns={[]} isInitialLoading />)

    expect(screen.getByRole('status')).toHaveTextContent('Restoring history')
  })

  it('can label expired older-history recovery as refresh', () => {
    const onLoadOlder = vi.fn()

    render(
      <FreshAgentTranscript
        turns={[]}
        hasOlderHistory
        historyError="Older history cursor expired"
        historyErrorActionLabel="Refresh"
        onLoadOlder={onLoadOlder}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('uses the pane agent label for assistant turns when provided', () => {
    render(
      <FreshAgentTranscript
        agentLabel="Freshcodex"
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            model: 'gpt-5.4-flash',
            items: [{ id: 'item-1', kind: 'text', text: 'Label check' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('Freshcodex')).toBeInTheDocument()
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Freshcodex transcript turn')).toBeInTheDocument()
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
    expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
  })

  it('hides thinking rows when showThinking is false', () => {
    render(
      <FreshAgentTranscript
        showThinking={false}
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thought then ran',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'hidden reasoning' },
              {
                id: 'tool-1',
                kind: 'tool_use',
                toolUseId: 'call-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('1 tool used')
    expect(screen.queryByText(/thought/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
  })

  it('opens activity details by default when showTools is true', () => {
    render(
      <FreshAgentTranscript
        showTools
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
                input: { command: 'npm run check' },
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('npm run check')).toBeInTheDocument()
  })

  it('shows timestamp and model when showTimecodes is true', () => {
    render(
      <FreshAgentTranscript
        showTimecodes
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            timestamp: '2026-06-15T12:34:56.000Z',
            model: 'gpt-5.4-flash',
            summary: 'model metadata',
            items: [{ id: 'item-1', kind: 'text', text: 'Done.' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('gpt-5.4-flash')).toBeInTheDocument()
    expect(screen.getByText(new Date('2026-06-15T12:34:56.000Z').toLocaleTimeString())).toBeInTheDocument()
  })

  it('shows a live reel while a tool is running', () => {
    const { container } = render(
      <FreshAgentTranscript
        isStreaming
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
    expect(container.querySelector('[data-testid="fresh-agent-activity-status-slot"]')).toBeTruthy()
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
    expect(screen.queryByText('still reasoning about the fix')).not.toBeInTheDocument()
  })

  it('keeps the latest completed tool in the live reel while the turn is still streaming', () => {
    render(
      <FreshAgentTranscript
        isStreaming
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'streaming after tool',
            items: [
              {
                id: 'tool-1',
                kind: 'tool_use',
                toolUseId: 'call-1',
                name: 'Read',
                input: { file_path: 'src/App.tsx' },
              },
              { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              { id: 'item-1', kind: 'text', text: 'I found the relevant file.' },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByLabelText('running')).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.queryByText('1 tool used')).not.toBeInTheDocument()
  })

  it('shows only the latest activity block as running while an assistant response streams across turns', () => {
    render(
      <FreshAgentTranscript
        isStreaming
        turns={[
          {
            id: 'turn-user-1',
            role: 'user',
            summary: 'request',
            items: [{ id: 'item-user-1', kind: 'text', text: 'Check these files' }],
          },
          {
            id: 'turn-agent-read-1',
            role: 'assistant',
            summary: 'Read',
            items: [
              {
                id: 'tool-read-1',
                kind: 'tool_use',
                toolUseId: 'call-read-1',
                name: 'Read',
                input: { file_path: 'src/one.ts' },
              },
            ],
          },
          {
            id: 'turn-agent-text-1',
            role: 'assistant',
            summary: 'first note',
            items: [{ id: 'item-agent-1', kind: 'text', text: 'I checked the first file.' }],
          },
          {
            id: 'turn-agent-read-2',
            role: 'assistant',
            summary: 'Read',
            items: [
              {
                id: 'tool-read-2',
                kind: 'tool_use',
                toolUseId: 'call-read-2',
                name: 'Read',
                input: { file_path: 'src/two.ts' },
              },
            ],
          },
          {
            id: 'turn-agent-text-2',
            role: 'assistant',
            summary: 'second note',
            items: [{ id: 'item-agent-2', kind: 'text', text: 'Still checking.' }],
          },
        ]}
      />,
    )

    const strips = screen.getAllByRole('region', { name: 'Activity strip' })
    expect(strips).toHaveLength(2)
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
    expect(strips[0]).toHaveTextContent('1 tool used')
  })

  it('keeps consecutive activity-only assistant turns separate while marking only the latest live', () => {
    render(
      <FreshAgentTranscript
        isStreaming
        turns={[
          {
            id: 'turn-user-1',
            role: 'user',
            summary: 'request',
            items: [{ id: 'item-user-1', kind: 'text', text: 'Read these files' }],
          },
          {
            id: 'turn-agent-read-1',
            role: 'assistant',
            summary: 'Read',
            items: [{
              id: 'tool-read-1',
              kind: 'tool_use',
              toolUseId: 'call-read-1',
              name: 'Read',
              input: { file_path: 'src/one.ts' },
            }],
          },
          {
            id: 'turn-agent-read-2',
            role: 'assistant',
            summary: 'Read',
            items: [{
              id: 'tool-read-2',
              kind: 'tool_use',
              toolUseId: 'call-read-2',
              name: 'Read',
              input: { file_path: 'src/two.ts' },
            }],
          },
          {
            id: 'turn-agent-read-3',
            role: 'assistant',
            summary: 'Read',
            items: [{
              id: 'tool-read-3',
              kind: 'tool_use',
              toolUseId: 'call-read-3',
              name: 'Read',
              input: { file_path: 'src/three.ts' },
            }],
          },
        ]}
      />,
    )

    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(3)
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
    expect(screen.getByText('src/three.ts')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[2])
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[0])
    expect(screen.getAllByLabelText('complete').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the speaker label once for consecutive turns from the same role', () => {
    const { container } = render(
      <FreshAgentTranscript
        agentLabel="freshclaude"
        turns={[
          {
            id: 'turn-user-1',
            role: 'user',
            items: [{ id: 'item-user-1', kind: 'text', text: 'First request' }],
          },
          {
            id: 'turn-agent-1',
            role: 'assistant',
            items: [{ id: 'item-agent-1', kind: 'text', text: 'First response line' }],
          },
          {
            id: 'turn-agent-2',
            role: 'assistant',
            items: [{ id: 'item-agent-2', kind: 'text', text: 'Second response line' }],
          },
          {
            id: 'turn-agent-3',
            role: 'assistant',
            items: [{ id: 'item-agent-3', kind: 'text', text: 'Third response line' }],
          },
          {
            id: 'turn-user-2',
            role: 'user',
            items: [{ id: 'item-user-2', kind: 'text', text: 'Follow-up' }],
          },
          {
            id: 'turn-agent-4',
            role: 'assistant',
            items: [{ id: 'item-agent-4', kind: 'text', text: 'Fresh response group' }],
          },
        ]}
      />,
    )

    const visibleHeaders = Array.from(container.querySelectorAll('.fresh-agent-turn-header'))
      .map((node) => node.textContent)
    expect(visibleHeaders.filter((text) => text === 'freshclaude')).toHaveLength(2)
    expect(container.querySelectorAll('[data-turn-continuation="true"]')).toHaveLength(2)
  })

  it('keeps completed long transcripts expanded instead of replacing older turns with summary rows', () => {
    const turns = Array.from({ length: 10 }, (_, index) => ({
      id: `turn-${index}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      items: [{
        id: `item-${index}`,
        kind: 'text' as const,
        text: index % 2 === 0 ? `User note ${index}` : `Agent reply ${index}`,
      }],
    }))

    const { container } = render(
      <FreshAgentTranscript
        agentLabel="freshclaude"
        turns={turns}
      />,
    )

    for (let index = 0; index < turns.length; index += 1) {
      expect(screen.getByText(index % 2 === 0 ? `User note ${index}` : `Agent reply ${index}`)).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Expand turn' })).not.toBeInTheDocument()
    expect(container.querySelector('.fresh-agent-collapsed-turn')).toBeNull()
    expect(container.querySelectorAll('.fresh-agent-turn')).toHaveLength(10)
  })

  it('tolerates duplicate provider turn ids without duplicate React keys', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'provider-duplicate',
              role: 'user',
              items: [{ id: 'item-user', kind: 'text', text: 'First duplicate id turn' }],
            },
            {
              id: 'provider-duplicate',
              role: 'assistant',
              items: [{ id: 'item-agent', kind: 'text', text: 'Second duplicate id turn' }],
            },
          ]}
        />,
      )

      expect(screen.getByText('First duplicate id turn')).toBeInTheDocument()
      expect(screen.getByText('Second duplicate id turn')).toBeInTheDocument()
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining('Encountered two children with the same key'),
        expect.anything(),
        expect.anything(),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps auto-scroll enabled for streamed text when already at the bottom', () => {
    let scrollHeight = 1000
    const turns = [{
      id: 'turn-1',
      role: 'assistant' as const,
      summary: 'streaming',
      items: [{ id: 'item-1', kind: 'text' as const, text: 'first line' }],
    }]
    const { container, rerender } = render(<FreshAgentTranscript turns={turns} />)
    const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    scroller.scrollTop = 800
    fireEvent.scroll(scroller)

    scrollHeight = 1200
    rerender(
      <FreshAgentTranscript
        turns={[{
          ...turns[0],
          items: [{ id: 'item-1', kind: 'text', text: 'first line\nsecond streamed line' }],
        }]}
      />,
    )

    expect(scroller.scrollTop).toBe(1200)
  })

  it('shows and clears the new-message badge when fresh-agent updates arrive away from the bottom', async () => {
    let scrollHeight = 1000
    const { container, rerender } = render(
      <FreshAgentTranscript
        turns={[{
          id: 'turn-1',
          role: 'assistant',
          summary: 'first',
          items: [{ id: 'item-1', kind: 'text', text: 'first line' }],
        }]}
      />,
    )
    const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })

    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    scrollHeight = 1200
    rerender(
      <FreshAgentTranscript
        turns={[{
          id: 'turn-1',
          role: 'assistant',
          summary: 'first',
          items: [{ id: 'item-1', kind: 'text', text: 'first line\nsecond line' }],
        }]}
      />,
    )

    const button = await screen.findByRole('button', { name: 'Scroll to bottom' })
    await waitFor(() => expect(button).toHaveTextContent('2 new'))
    fireEvent.click(button)
    expect(scroller.scrollTop).toBe(1200)
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument()
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

  it('keeps adjacent activity-only display turns distinct and actionable', () => {
    const onFork = vi.fn()
    render(
      <FreshAgentTranscript
        canFork
        onForkFromTurn={onFork}
        turns={[
          {
            id: 'native-turn',
            turnId: 'display-activity-1',
            role: 'assistant',
            summary: 'first activity',
            items: [{ id: 'think-1', kind: 'thinking', text: 'first thought' }],
          },
          {
            id: 'native-turn',
            turnId: 'display-activity-2',
            role: 'assistant',
            summary: 'second activity',
            items: [{ id: 'think-2', kind: 'thinking', text: 'second thought' }],
          },
        ]}
      />,
    )

    expect(screen.getAllByRole('article', { name: 'Assistant transcript turn' })).toHaveLength(2)
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)

    const forkButtons = screen.getAllByRole('button', { name: 'Fork conversation from here' })
    fireEvent.click(forkButtons[1])
    expect(onFork).toHaveBeenCalledWith('display-activity-2')
  })

  it('strips system reminders without collapsing older turns', () => {
    render(
      <FreshAgentTranscript
        turns={Array.from({ length: 9 }, (_, index) => ({
          id: `turn-${index}`,
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          summary: `turn ${index}`,
          items: [{
            id: `item-${index}`,
            kind: 'text' as const,
            text: index === 0
              ? 'visible <system-reminder>hidden internals</system-reminder>'
              : `message ${index}`,
          }],
        }))}
      />,
    )

    expect(screen.getByText('visible')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Expand turn' })).not.toBeInTheDocument()
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
