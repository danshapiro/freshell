import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FreshAgentTranscript, type FreshAgentTranscriptHandle } from '@/components/fresh-agent/FreshAgentTranscript'
import type { FreshAgentTranscriptItem, FreshAgentTurn } from '@shared/fresh-agent-contract'

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

    const userMessage = screen.getByText('**not bold** and # not a heading')
    expect(userMessage).toBeInTheDocument()
    expect(userMessage.className).not.toContain('text-sm')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
  })

  it('coalesces paired tool calls into the activity strip and expands details', () => {
    const { container } = render(
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
              {
                id: 'tool-2',
                kind: 'tool_use',
                toolUseId: 'call-2',
                name: 'Bash',
                input: { command: 'find . -name "*.ts"', description: 'Find TypeScript files' },
              },
              {
                id: 'result-2',
                kind: 'tool_result',
                toolUseId: 'call-2',
                content: 'src/App.tsx',
                isError: false,
              },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(container.querySelector('[data-tool-input]')).not.toBeInTheDocument()
    const toolButtons = screen.getAllByRole('button', { name: 'Bash tool call' })
    expect(toolButtons).toHaveLength(2)
    fireEvent.click(toolButtons[0])
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

  it('collapses consecutive activity-only assistant turns into one live strip', () => {
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

    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    expect(screen.getAllByLabelText('running')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByText('src/one.ts')).toBeInTheDocument()
    expect(screen.getByText('src/two.ts')).toBeInTheDocument()
    expect(screen.getByText('src/three.ts')).toBeInTheDocument()
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
  })

  it('folds Claude user-role tool results into the assistant activity instead of attributing them to You', () => {
    const { container } = render(
      <FreshAgentTranscript
        agentLabel="Freshclaude"
        turns={[
          {
            id: 'turn-user-1',
            role: 'user',
            summary: 'request',
            items: [{ id: 'item-user-1', kind: 'text', text: 'Check the plan file' }],
          },
          {
            id: 'turn-agent-tool',
            role: 'assistant',
            summary: 'reading',
            items: [
              { id: 'item-agent-1', kind: 'text', text: 'Let me check that.' },
              {
                id: 'tool-read-1',
                kind: 'tool_use',
                toolUseId: 'call-read-1',
                name: 'Read',
                input: { file_path: 'docs/plan.md' },
              },
            ],
          },
          {
            id: 'turn-tool-result',
            role: 'user',
            summary: 'Tool result',
            items: [
              { id: 'result-read-1', kind: 'tool_result', toolUseId: 'call-read-1', content: '# Plan', isError: false },
            ],
          },
          {
            id: 'turn-agent-final',
            role: 'assistant',
            summary: 'done',
            items: [{ id: 'item-agent-2', kind: 'text', text: 'Plan file checked.' }],
          },
        ]}
      />,
    )

    const visibleHeaders = Array.from(container.querySelectorAll('.fresh-agent-turn-header'))
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
    expect(visibleHeaders).toEqual(['You', 'Freshclaude'])
    expect(container.querySelectorAll('[data-turn-role="user"] .fresh-agent-activity-strip')).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('1 tool used')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByText('docs/plan.md')).toBeInTheDocument()
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent('# Plan')
  })

  it('coalesces adjacent Claude tool-use/result exchanges without rendering synthetic You turns', () => {
    const { container } = render(
      <FreshAgentTranscript
        agentLabel="Freshclaude"
        turns={[
          {
            id: 'turn-user-1',
            role: 'user',
            summary: 'request',
            items: [{ id: 'item-user-1', kind: 'text', text: 'Read both files' }],
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
            id: 'turn-tool-result-1',
            role: 'user',
            summary: 'Tool result',
            items: [{ id: 'result-read-1', kind: 'tool_result', toolUseId: 'call-read-1', content: 'one', isError: false }],
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
            id: 'turn-tool-result-2',
            role: 'user',
            summary: 'Tool result',
            items: [{ id: 'result-read-2', kind: 'tool_result', toolUseId: 'call-read-2', content: 'two', isError: false }],
          },
          {
            id: 'turn-agent-final',
            role: 'assistant',
            summary: 'done',
            items: [{ id: 'item-agent-final', kind: 'text', text: 'Both files are checked.' }],
          },
        ]}
      />,
    )

    const visibleHeaders = Array.from(container.querySelectorAll('.fresh-agent-turn-header'))
      .map((node) => node.textContent?.trim())
      .filter(Boolean)
    expect(visibleHeaders).toEqual(['You', 'Freshclaude'])
    expect(container.querySelectorAll('[data-turn-role="user"] .fresh-agent-activity-strip')).toHaveLength(0)
    // The two exchanges are adjacent same-role activity-only turns after
    // synthetic-result coalescing: one accumulating line, '2 tools used'.
    const strips = screen.getAllByRole('region', { name: 'Activity strip' })
    expect(strips).toHaveLength(1)
    expect(strips[0]).toHaveTextContent('2 tools used')
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

  it('does not let a deferred initial auto-scroll clobber an imperative page scroll', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    const afterImperativeScroll: number[] = []

    function Harness() {
      const transcriptRef = useRef<FreshAgentTranscriptHandle | null>(null)

      useLayoutEffect(() => {
        // Model a consumer scroll that happens after DOM commit but before the
        // transcript's passive effects flush.
        const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
        scroller.scrollTop = 100

        transcriptRef.current?.scrollByPage(1)
        afterImperativeScroll.push(scroller.scrollTop)
      }, [])

      return (
        <FreshAgentTranscript
          ref={transcriptRef}
          turns={[
            { id: 'turn-0', role: 'user', items: [{ id: 'item-0', kind: 'text', text: 'User message' }] },
            { id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Assistant reply' }] },
          ]}
        />
      )
    }

    flushSync(() => {
      root = createRoot(container)
      root.render(<Harness />)
    })

    try {
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      expect(afterImperativeScroll).toEqual([260])
      expect(scroller.scrollTop).toBe(260)

      await act(async () => {})

      expect(scroller.scrollTop).toBe(260)
    } finally {
      await act(async () => {
        root?.unmount()
      })
      container.remove()
    }
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

  it('merges adjacent activity-only display turns into one line actionable from the line end', () => {
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
            summary: 'first thought',
            items: [{ id: 'think-1', kind: 'thinking', text: 'first thought' }],
          },
          {
            id: 'native-turn',
            turnId: 'display-activity-2',
            role: 'assistant',
            summary: 'second thought',
            items: [{ id: 'think-2', kind: 'thinking', text: 'second thought' }],
          },
        ]}
      />,
    )

    expect(screen.getAllByRole('article', { name: 'Assistant transcript turn' })).toHaveLength(1)
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)

    // Fork protection is preserved at line granularity: the merged article's
    // fork resolves to the line's last contributing turn.
    const forkButtons = screen.getAllByRole('button', { name: 'Fork conversation from here' })
    fireEvent.click(forkButtons[0])
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

  describe('tool notification polish (5kxd)', () => {
    it('drops the vertical line from the activity summary while keeping left padding', () => {
      const { container } = render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'used a tool',
              items: [
                { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'true' } },
                { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              ],
            },
          ]}
        />,
      )
      const summary = container.querySelector('.fresh-agent-activity-summary') as HTMLElement
      expect(summary).toBeTruthy()
      expect(summary.className).not.toContain('border-l-2')
      expect(summary.className).not.toContain('border-l-[')
      expect(summary.className).toContain('px-2')
    })

    it('expands a single-tool activity strip body in one click', () => {
      const { container } = render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'used a tool',
              items: [
                { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'echo hi' } },
                { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'hi', isError: false },
              ],
            },
          ]}
        />,
      )
      expect(container.querySelector('[data-tool-input]')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(container.querySelector('[data-tool-input]')).toHaveTextContent('echo hi')
      expect(container.querySelector('[data-tool-output]')).toHaveTextContent('hi')
    })

    it('keeps multi-tool strip headers collapsed until individually expanded', () => {
      const { container } = render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'used two tools',
              items: [
                { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'echo first' } },
                { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'first', isError: false },
                { id: 'tool-2', kind: 'tool_use', toolUseId: 'call-2', name: 'Bash', input: { command: 'echo second' } },
                { id: 'result-2', kind: 'tool_result', toolUseId: 'call-2', content: 'second', isError: false },
              ],
            },
          ]}
        />,
      )
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(container.querySelector('[data-tool-input]')).not.toBeInTheDocument()
      const toolButtons = screen.getAllByRole('button', { name: 'Bash tool call' })
      expect(toolButtons).toHaveLength(2)
      fireEvent.click(toolButtons[0])
      expect(container.querySelector('[data-tool-input]')).toHaveTextContent('echo first')
      expect(container.querySelectorAll('[data-tool-input]')).toHaveLength(1)
    })

    it('preserves error state on the activity strip without the vertical line', () => {
      render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'tool failed',
              items: [
                { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'false' } },
                { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'boom', isError: true },
              ],
            },
          ]}
        />,
      )
      const summary = screen.getByRole('region', { name: 'Activity strip' }).querySelector('.fresh-agent-activity-summary') as HTMLElement
      expect(summary).toBeTruthy()
      expect(summary.className).not.toContain('border-l-')
      expect(screen.getByLabelText('error')).toBeInTheDocument()
    })

    it('drops the vertical line from the thinking row in the activity strip', () => {
      const { container } = render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'thought',
              items: [
                { id: 'think-1', kind: 'thinking', text: 'a thought' },
              ],
            },
          ]}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const thinkingRow = container.querySelector('.fresh-agent-thinking-row') as HTMLElement
      expect(thinkingRow).toBeTruthy()
      expect(thinkingRow.className).not.toContain('border-l-2')
      expect(thinkingRow.className).not.toContain('border-l-[')
    })

    it('keeps the thinking row trigger left padding unchanged', () => {
      const { container } = render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'thought',
              items: [
                { id: 'think-1', kind: 'thinking', text: 'a thought' },
              ],
            },
          ]}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const trigger = container.querySelector('.fresh-agent-thinking-trigger') as HTMLElement
      expect(trigger).toBeTruthy()
      expect(trigger.className).toContain('px-2')
    })
  })

  describe('streaming height stability (jp70)', () => {
    const thinkingOnly = (turnId: string, thinkId: string, text: string) => ({
      id: turnId,
      role: 'assistant' as const,
      summary: 'thinking',
      items: [{ id: thinkId, kind: 'thinking' as const, text }],
    })

    const withTool = (turnId: string, thinkId: string, text: string, toolId: string, callId: string) => ({
      id: turnId,
      role: 'assistant' as const,
      summary: 'thinking + tool',
      items: [
        { id: thinkId, kind: 'thinking' as const, text },
        { id: toolId, kind: 'tool_use' as const, toolUseId: callId, name: 'Bash', input: { command: 'true' } },
      ],
    })

    it('keeps the streaming last turn even when all items are filtered out', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[thinkingOnly('turn-1', 'think-1', 'hidden reasoning')]}
        />,
      )

      expect(screen.getByRole('article', { name: 'Assistant transcript turn' })).toBeInTheDocument()
    })

    it('renders a live activity strip placeholder when no displayable rows exist during streaming', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[thinkingOnly('turn-1', 'think-1', 'hidden reasoning')]}
        />,
      )

      const strip = screen.getByRole('region', { name: 'Activity strip' })
      expect(strip).toBeInTheDocument()
      expect(strip.className).toContain('my-0.5')
      expect(screen.getByLabelText('running')).toBeInTheDocument()
    })

    it('keeps the live activity strip present across empty/non-empty displayRows transitions', () => {
      const { rerender } = render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[thinkingOnly('turn-1', 'think-1', 'reasoning')]}
        />,
      )

      const assertStripPresent = () => {
        const strip = screen.getByRole('region', { name: 'Activity strip' })
        expect(strip).toBeInTheDocument()
        expect(strip.className).toContain('my-0.5')
        expect(screen.getByLabelText('running')).toBeInTheDocument()
      }

      assertStripPresent()

      rerender(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[withTool('turn-1', 'think-1', 'reasoning', 'tool-1', 'call-1')]}
        />,
      )
      assertStripPresent()

      rerender(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[thinkingOnly('turn-2', 'think-2', 'more reasoning')]}
        />,
      )
      assertStripPresent()

      rerender(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[withTool('turn-2', 'think-2', 'more reasoning', 'tool-2', 'call-2')]}
        />,
      )
      assertStripPresent()
    })

    it('does not show a second running indicator on an earlier turn when the streaming last turn has no displayable items', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[
            {
              id: 'turn-1',
              role: 'assistant',
              summary: 'used a tool',
              items: [
                {
                  id: 'tool-1',
                  kind: 'tool_use',
                  toolUseId: 'call-1',
                  name: 'Bash',
                  input: { command: 'true' },
                },
                { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              ],
            },
            thinkingOnly('turn-2', 'think-2', 'hidden reasoning'),
          ]}
        />,
      )

      // The final turn has a visible summary, so it closes the line and
      // renders its own article (summary + injected live strip) instead of
      // handing liveness to the earlier line — the earlier turn completed
      // before the final turn started, so its line settles. Exactly one
      // running indicator remains, on the live strip, and none on the
      // earlier turn.
      expect(screen.getAllByLabelText('running')).toHaveLength(1)
      const strips = screen.getAllByRole('region', { name: 'Activity strip' })
      expect(strips).toHaveLength(2)
      expect(strips[0]).toHaveTextContent('1 tool used')
      expect(screen.getByText('thinking')).toBeInTheDocument()
    })

    it('drops a non-streaming turn when all items are filtered out', () => {
      render(
        <FreshAgentTranscript
          showThinking={false}
          turns={[thinkingOnly('turn-1', 'think-1', 'hidden reasoning')]}
        />,
      )

      expect(screen.queryByRole('article', { name: 'Assistant transcript turn' })).not.toBeInTheDocument()
    })

    it('does not resnap autoscroll when re-rendering with the same streaming items', () => {
      let scrollHeight = 1000
      const turn = thinkingOnly('turn-1', 'think-1', 'hidden reasoning')
      const { container, rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turn]} />,
      )
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
      scroller.scrollTop = 1000
      fireEvent.scroll(scroller)

      expect(scroller.scrollTop).toBe(1000)

      scrollHeight = 1200
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turn]} />)

      expect(scroller.scrollTop).toBe(1000)
    })
  })

  describe('user turn glom chip', () => {
    const TRANSCRIPT = [
      {
        id: 'u1',
        role: 'user' as const,
        summary: 'First user message here',
        items: [{ id: 'i1', kind: 'text' as const, text: 'First user message here' }],
      },
      {
        id: 'a1',
        role: 'assistant' as const,
        summary: 'reply 1',
        items: [{ id: 'i2', kind: 'text' as const, text: 'A'.repeat(200) }],
      },
      {
        id: 'u2',
        role: 'user' as const,
        summary: 'Second user message here',
        items: [{ id: 'i3', kind: 'text' as const, text: 'Second user message here' }],
      },
      {
        id: 'a2',
        role: 'assistant' as const,
        summary: 'reply 2',
        items: [{ id: 'i4', kind: 'text' as const, text: 'B'.repeat(200) }],
      },
      {
        id: 'u3',
        role: 'user' as const,
        summary: 'Third user message here',
        items: [{ id: 'i5', kind: 'text' as const, text: 'Third user message here' }],
      },
      {
        id: 'a3',
        role: 'assistant' as const,
        summary: 'reply 3',
        items: [{ id: 'i6', kind: 'text' as const, text: 'C'.repeat(200) }],
      },
    ]

    function mockScroll(scroller: HTMLElement, scrollTop: number, scrollHeight: number, clientHeight: number) {
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
      scroller.scrollTop = scrollTop
    }

    function mockRect(el: Element, top: number) {
      el.getBoundingClientRect = () => ({
        top,
        bottom: top + 50,
        left: 0,
        right: 800,
        width: 800,
        height: 50,
        x: 0,
        y: top,
        toJSON: () => ({}),
      })
    }

    function setupScrolledTranscript() {
      const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} />)
      const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      mockScroll(scroller, 400, 1000, 200)
      const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
      mockRect(scroller, 0)
      mockRect(userTurns[0], -400)
      mockRect(userTurns[1], -100)
      mockRect(userTurns[2], 50)
      fireEvent.scroll(scroller)
      return { ...utils, scroller, userTurns }
    }

    it('shows the most-recent offscreen-above user turn when scrolled', () => {
      setupScrolledTranscript()

      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      expect(chip).toBeInTheDocument()
      expect(chip).toHaveTextContent('Second user message here')
      expect(chip).toHaveAttribute('title', 'Second user message here')
      const chipText = chip.querySelector('span')
      expect(chipText).toHaveClass('truncate')
    })

    it('does not render the chip when no user turns are above the viewport', () => {
      const { container } = render(<FreshAgentTranscript turns={TRANSCRIPT} />)
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      mockScroll(scroller, 0, 1000, 200)
      const userTurns = container.querySelectorAll('[data-turn-role="user"]')
      mockRect(scroller, 0)
      mockRect(userTurns[0], 10)
      mockRect(userTurns[1], 100)
      mockRect(userTurns[2], 200)
      fireEvent.scroll(scroller)

      expect(screen.queryByRole('button', { name: /Jump to your message/ })).not.toBeInTheDocument()
    })

    it('clicking the chip scrolls the target user turn into view and leaves autoscroll paused', () => {
      const { userTurns } = setupScrolledTranscript()
      const scrollIntoViewSpy = vi.fn()
      userTurns[1].scrollIntoView = scrollIntoViewSpy

      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      fireEvent.click(chip)

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
      expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument()
    })

    it('does not resnap to bottom when new agent output arrives after clicking the chip', () => {
      const { scroller, rerender: rerenderFn } = setupScrolledTranscript()
      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      fireEvent.click(chip)

      const scrollTopBefore = scroller.scrollTop

      rerenderFn(
        <FreshAgentTranscript
          turns={[...TRANSCRIPT, {
            id: 'a4',
            role: 'assistant' as const,
            summary: 'new output',
            items: [{ id: 'i7', kind: 'text' as const, text: 'D'.repeat(200) }],
          }]}
        />,
      )

      expect(scroller.scrollTop).toBe(scrollTopBefore)
    })

    it('is a button with aria-label containing the full text and a title tooltip', () => {
      setupScrolledTranscript()

      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      expect(chip.tagName).toBe('BUTTON')
      expect(chip).toHaveAttribute('aria-label', 'Jump to your message: Second user message here')
      expect(chip).toHaveAttribute('title', 'Second user message here')
    })

    it('coexists with the scroll-to-bottom button without overlapping', () => {
      setupScrolledTranscript()

      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      const scrollBottom = screen.getByRole('button', { name: 'Scroll to bottom' })
      expect(chip).toBeInTheDocument()
      expect(scrollBottom).toBeInTheDocument()
      expect(chip.className).toContain('top-0')
      expect(scrollBottom.className).toContain('bottom-')
    })

    it('recomputes the glom target when transcript content changes', () => {
      const { container, rerender: rerenderFn } = render(<FreshAgentTranscript turns={TRANSCRIPT} />)
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      mockScroll(scroller, 0, 1000, 200)
      const userTurns = container.querySelectorAll('[data-turn-role="user"]')
      mockRect(scroller, 0)
      mockRect(userTurns[0], 10)
      mockRect(userTurns[1], 100)
      mockRect(userTurns[2], 200)
      fireEvent.scroll(scroller)
      expect(screen.queryByRole('button', { name: /Jump to your message/ })).not.toBeInTheDocument()

      mockRect(userTurns[0], -100)
      rerenderFn(<FreshAgentTranscript
        turns={[...TRANSCRIPT, {
          id: 'a4',
          role: 'assistant' as const,
          summary: 'more',
          items: [{ id: 'i7', kind: 'text' as const, text: 'more output' }],
        }]}
      />)

      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      expect(chip).toHaveTextContent('First user message here')
    })
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

  describe('activity line collapse', () => {
    const toolTurn = (turnId: string, calls: Array<[string, string]>): FreshAgentTurn => ({
      id: turnId,
      turnId,
      role: 'assistant',
      summary: '',
      items: calls.flatMap(([callId, filePath]): FreshAgentTranscriptItem[] => [
        { id: `tool-${callId}`, kind: 'tool_use', toolUseId: callId, name: 'Read', input: { file_path: filePath } },
        { id: `result-${callId}`, kind: 'tool_result', toolUseId: callId, content: 'ok', isError: false },
      ]),
    })

    it('collapses adjacent same-role tool-only turns into one accumulating strip line', () => {
      render(
        <FreshAgentTranscript
          turns={[
            { id: 'turn-user', turnId: 'turn-user', role: 'user', summary: 'req',
              items: [{ id: 'item-user', kind: 'text', text: 'read five files' }] },
            toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts'],['c3','src/c.ts']]),
            toolTurn('turn-b', [['c4','src/d.ts'],['c5','src/e.ts']]),
          ]}
        />,
      )
      const strips = screen.getAllByRole('region', { name: 'Activity strip' })
      expect(strips).toHaveLength(1)
      expect(strips[0]).toHaveTextContent('5 tools used')
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getAllByText(/^src\/[a-e]\.ts$/)).toHaveLength(5)
      expect(screen.getByText('src/e.ts')).toBeInTheDocument()
    })

    it('keeps tool lines separate when a message renders between them', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1','src/a.ts']]),
            { id: 'turn-msg', turnId: 'turn-msg', role: 'assistant', summary: 'note',
              items: [{ id: 'item-msg', kind: 'text', text: 'First file read.' }] },
            toolTurn('turn-b', [['c2','src/b.ts']]),
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('does not collapse tool lines across a role change', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1','src/a.ts']]),
            { ...toolTurn('turn-b', [['c2','src/b.ts']]), role: 'tool' },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      // the role change renders a header between the lines
      expect(screen.getByText('Tool')).toBeInTheDocument()
    })

    it('a trailing text card in the earlier turn keeps the lines separate', () => {
      render(
        <FreshAgentTranscript
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: 'work',
              items: [
                { id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } },
                { id: 'item-msg', kind: 'text', text: 'done with a' },
              ] },
            toolTurn('turn-b', [['c2','src/b.ts']]),
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('merges a chain of three adjacent tool-only turns', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts']]),
            toolTurn('turn-b', [['c3','src/c.ts'],['c4','src/d.ts']]),
            toolTurn('turn-c', [['c5','src/e.ts'],['c6','src/f.ts']]),
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('6 tools used')
    })

    it('fully absorbed turns render no article and fork targets the line end', () => {
      const onFork = vi.fn()
      render(
        <FreshAgentTranscript
          canFork
          onForkFromTurn={onFork}
          turns={[
            { id: 'turn-a', turnId: 'native-a', role: 'assistant', summary: '',
              items: [{ id: 't1', kind: 'thinking', text: 'first thought' }] },
            { id: 'turn-b', turnId: 'native-b', role: 'assistant', summary: '',
              items: [{ id: 't2', kind: 'thinking', text: 'second thought' }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('article', { name: 'Assistant transcript turn' })).toHaveLength(1)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      // merged thinking-only line settles to 'thought'
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByText('Thinking')).toBeInTheDocument()
      const forkButtons = screen.getAllByRole('button', { name: 'Fork conversation from here' })
      fireEvent.click(forkButtons[0])
      expect(onFork).toHaveBeenCalledWith('native-b')
    })

    it('treats a zero-item turn as a boundary between tool lines', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1','src/a.ts']]),
            { id: 'turn-empty', turnId: 'turn-empty', role: 'assistant', summary: '', items: [] },
            toolTurn('turn-b', [['c2','src/b.ts']]),
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('renders both tools when TS-claude duplicate item ids collide across merged turns', () => {
      render(
        <FreshAgentTranscript
          turns={[
            { id: 'turn-a', turnId: 'turn:msg-1', role: 'assistant', summary: '',
              items: [{ id: 'turn:msg-1:item:0', kind: 'tool_use', toolUseId: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-b', turnId: 'turn:msg-1', role: 'assistant', summary: '',
              items: [{ id: 'turn:msg-1:item:0', kind: 'tool_use', toolUseId: 'toolu_2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByText('src/a.ts')).toBeInTheDocument()
      expect(screen.getByText('src/b.ts')).toBeInTheDocument()
    })

    it('extends the open line in place as adjacent tool turns stream in (same DOM node, no regroup)', () => {
      const userTurn = {
        id: 'turn-user', turnId: 'turn-user', role: 'user' as const, summary: 'req',
        items: [{ id: 'item-user', kind: 'text' as const, text: 'read five files' }],
      }
      const turnA = toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts'],['c3','src/c.ts']])
      const { rerender } = render(<FreshAgentTranscript turns={[userTurn, turnA]} />)
      const first = screen.getByRole('region', { name: 'Activity strip' })
      expect(first).toHaveTextContent('3 tools used')

      rerender(<FreshAgentTranscript turns={[userTurn, turnA, toolTurn('turn-b', [['c4','src/d.ts'],['c5','src/e.ts']])]} />)
      const merged = screen.getByRole('region', { name: 'Activity strip' })
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(merged).toBe(first)
      expect(merged).toHaveTextContent('5 tools used')
    })

    it('keeps two same-turn lines distinct when a message splits them (tool → text → tool)', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-mixed', turnId: 'turn-mixed', role: 'assistant', summary: '',
            items: [
              { id: 'tool-a', kind: 'tool_use', toolUseId: 'ca', name: 'Read', input: { file_path: 'src/a.ts' } },
              { id: 'item-note', kind: 'text', text: 'first pass done' },
              { id: 'tool-b', kind: 'tool_use', toolUseId: 'cb', name: 'Read', input: { file_path: 'src/b.ts' } },
            ],
          }]}
        />,
      )
      const strips = screen.getAllByRole('region', { name: 'Activity strip' })
      expect(strips).toHaveLength(2)
      expect(strips[0]).toHaveTextContent('1 tool used')
      expect(strips[1]).toHaveTextContent('1 tool used')
    })

    it('an invisible (whitespace-only) text item does not split the line', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1','src/a.ts']]),
            { id: 'turn-empty-text', turnId: 'turn-empty-text', role: 'assistant', summary: '',
              items: [{ id: 'item-empty', kind: 'text', text: '   ' }] },
            toolTurn('turn-b', [['c2','src/b.ts']]),
          ]}
        />,
      )
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
    })

    it('hands liveness to the merged line across an absorbed previous turn while the last turn streams empty', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1','src/a.ts']]),
            toolTurn('turn-b', [['c2','src/b.ts']]),
            { id: 'turn-streaming', turnId: 'turn-streaming', role: 'assistant', summary: '', items: [] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.getAllByLabelText('running')).toHaveLength(1)
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('Read')
      expect(screen.queryByText('2 tools used')).not.toBeInTheDocument()
    })

    it('keeps a summary-only streaming turn and its injected live strip visible after an activity line', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-summary', turnId: 'turn-summary', role: 'assistant', summary: 'Wrapping up shortly', items: [] },
          ]}
        />,
      )
      expect(screen.getByText('Wrapping up shortly')).toBeInTheDocument()
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.getAllByLabelText('running')).toHaveLength(1)
    })

    it('closes the line across a role change even when the message body is invisible', () => {
      render(
        <FreshAgentTranscript
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-user-invisible', turnId: 'turn-user-invisible', role: 'user', summary: '',
              items: [{ id: 'item-invisible', kind: 'text', text: '   ' }] },
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: '',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.getByText('You')).toBeInTheDocument()
    })

    it('permanently separates tool runs when the follower turn carries a summary that is not an item echo', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-c', turnId: 'turn-c', role: 'assistant', summary: 'Wrapping up shortly',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      // The summary is authored content (no item says "Wrapping up shortly"), so
      // the tool run behind it can never join the previous line — even after the
      // base fallback stops painting the summary once blocks exist.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('still merges a follower whose summary merely echoes one of its own items (codex tool preview)', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-c', turnId: 'turn-c', role: 'assistant', summary: 'Read',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('pins the streaming summary cadence: an authored summary permanently keeps the following tool run on its own line', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnCEmpty = {
        id: 'turn-c', turnId: 'turn-c', role: 'assistant' as const,
        summary: 'Wrapping up shortly', items: [],
      }
      // Frame 1: summary-only streaming tail renders its summary plus the injected
      // live strip (matches the pre-change summary-fallback behavior).
      const { rerender } = render(<FreshAgentTranscript isStreaming turns={[turnA, turnCEmpty]} />)
      expect(screen.getByText('Wrapping up shortly')).toBeInTheDocument()
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)

      // Frame 2: the tool arrives in the same turn. The authored summary rendered
      // between the two tool runs, so they are permanently separated — the base
      // fallback still hides the summary once blocks exist, but the run keeps its
      // own line and never retro-merges into the previous one.
      const turnCWithTool = {
        ...turnCEmpty,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      rerender(<FreshAgentTranscript isStreaming turns={[turnA, turnCWithTool]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.getByText('Read')).toBeInTheDocument()
    })

    it('merges a follower whose coalesced summary carries the Rust claude [tool result] label', () => {
      // The production Rust claude snapshot summarizer emits '[tool result]'
      // (claude_snapshot.rs), not the TS normalizer's 'Tool result'. Synthetic
      // result coalescing joins it to the tool echo with a blank line.
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read\n\n[tool result]',
              items: [
                { id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
                { id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('merges a follower whose live summary space-joins several item echoes', () => {
      // The live freshAgent.assistant path summarizes a turn by space-joining
      // every content block (summarizeFreshAgentItems), so a two-Read batch is
      // 'Read Read' — not contained in any single item echo, but fully composed
      // of them.
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read Read',
              items: [
                { id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
                { id: 'tool-c3', kind: 'tool_use', toolUseId: 'c3', name: 'Read', input: { file_path: 'src/c.ts' } },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('merges a codex image-generation follower whose summary echoes its result', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'cat.png',
              items: [
                { id: 'img-1', kind: 'image_generation', status: 'complete', revisedPrompt: null, result: 'cat.png' },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('pins the hidden-thinking cadence: a summary that rendered as a distinct turn permanently separates the surrounding tool runs', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const thinkingTurn = {
        id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
        summary: 'Considering options',
        items: [{ id: 'think-1', kind: 'thinking' as const, text: 'Considering options' }],
      }
      // Frame 1 (showThinking=false, the production default): the thinking-only
      // streaming tail keeps its summary rendered.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn]} />,
      )
      expect(screen.getByText('Considering options')).toBeInTheDocument()

      // Frame 2: the next tool arrives in a NEW turn. The thinking turn is no
      // longer the streaming tail, so hidden thinking drops out of view — but
      // its summary rendered between the two tool runs, so the runs stay
      // permanently separated instead of retro-collapsing into one line.
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read',
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('keeps the hidden-thinking boundary after the session goes idle (isStreaming flips false)', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const thinkingTurn = {
        id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
        summary: 'Considering options',
        items: [{ id: 'think-1', kind: 'thinking' as const, text: 'Considering options' }],
      }
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read',
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      // The thinking turn's summary paints as the streaming tail...
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn]} />,
      )
      expect(screen.getByText('Considering options')).toBeInTheDocument()
      // ...then the next tool arrives in a new turn: separated lines.
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      // The session completes (FreshAgentView passes isStreaming=isBusy). The
      // summary rendered between the two tool runs in this view, so the runs
      // must not retro-collapse now that streaming is over.
      rerender(<FreshAgentTranscript isStreaming={false} showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('collapses freely across hidden-thinking turns whose summary never painted (settled history)', () => {
      // A transcript mounted already-settled never rendered the hidden thinking
      // turn's summary, so nothing stood between the tool runs in this view.
      render(
        <FreshAgentTranscript
          isStreaming={false}
          showThinking={false}
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant',
              summary: 'Considering options',
              items: [{ id: 'think-1', kind: 'thinking', text: 'Considering options' }] },
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('merges a mixed thinking-plus-tool turn whose hidden thinking is part of the summary (live claude shape)', () => {
      // Production default showThinking=false: the thinking item is filtered
      // out, and the summary ('Considering Read', space-joined by the live
      // summarizer) never renders — the article renders its activity block.
      // Echo classification must still see the hidden items, or the common
      // claude thinking→tool turn can never merge.
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Considering Read',
              items: [
                { id: 'think-1', kind: 'thinking', text: 'Considering' },
                { id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('merges a mixed thinking-plus-tool turn whose summary is the hidden thinking text (Rust snapshot shape)', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Considering',
              items: [
                { id: 'think-1', kind: 'thinking', text: 'Considering' },
                { id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('keeps a painted summary boundary when the same turn later gains items that echo it', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnBEmpty = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const,
        summary: 'Wrapping up shortly', items: [],
      }
      // Frame 1: the summary-only streaming tail paints its summary.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking turns={[turnA, turnBEmpty]} />,
      )
      expect(screen.getByText('Wrapping up shortly')).toBeInTheDocument()

      // Frame 2: the same turn gains a thinking item echoing the summary plus
      // a tool. The summary is now classifiable as an echo, but it RENDERED
      // between the two tool runs, so the new activity keeps its own line.
      const turnBWithItems = {
        ...turnBEmpty,
        items: [
          { id: 'think-1', kind: 'thinking' as const, text: 'Wrapping up shortly' },
          { id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
        ],
      }
      rerender(<FreshAgentTranscript isStreaming showThinking turns={[turnA, turnBWithItems]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('does not let a painted summary mark a different turn that shares its turnId', () => {
      const thinkingTurn = (summary: string, itemId: string) => ({
        id: `turn-dup-${itemId}`, turnId: 'turn-dup', role: 'assistant' as const,
        summary,
        items: [{ id: itemId, kind: 'thinking' as const, text: summary }],
      })
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read',
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      // Frame 1: one display turn with turnId 'turn-dup' paints its summary.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[thinkingTurn('First thought', 'think-1')]} />,
      )
      expect(screen.getByText('First thought')).toBeInTheDocument()

      // Frame 2: a DIFFERENT display turn reuses turnId 'turn-dup' with a
      // different summary that never painted (validated claude data permits
      // duplicate display keys across JSONL rows). It must not inherit the
      // painted boundary — the tool runs still collapse.
      rerender(
        <FreshAgentTranscript
          isStreaming={false}
          showThinking={false}
          turns={[turnA, thinkingTurn('Second thought', 'think-2'), turnB]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('keeps the painted boundary when a streaming summary grows after painting', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      // Frame 1: the streaming tail paints its summary 'Considering'.
      const turnBEmpty = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const,
        summary: 'Considering', items: [],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking turns={[turnA, turnBEmpty]} />,
      )
      expect(screen.getByText('Considering')).toBeInTheDocument()

      // Frame 2: the same turn's reasoning accumulated — the summary grew to
      // 'Considering options' and the turn now carries items echoing it
      // (repeatedly fetched OpenCode reasoning parts have this shape). The
      // painted text rendered between the tool runs; the new activity must
      // keep its own line even though the summary text mutated.
      const turnBGrown = {
        ...turnBEmpty,
        summary: 'Considering options',
        items: [
          { id: 'think-1', kind: 'thinking' as const, text: 'Considering options' },
          { id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
        ],
      }
      rerender(<FreshAgentTranscript isStreaming showThinking turns={[turnA, turnBGrown]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })
  })
})
