import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FreshAgentTranscript, type FreshAgentTranscriptHandle } from '@/components/fresh-agent/FreshAgentTranscript'
import { getFreshAgentTurnItemsBuilder } from '@/lib/pane-action-registry'
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

  it('shows native asynchronous choices when the agent message has no text body', () => {
    render(<FreshAgentTranscript turns={[{ id: 'choices', turnId: 'choices', role: 'assistant', summary: '', items: [{ id: 'choice-item', kind: 'text', text: '', extensions: { codex: { questions: [{ title: 'Choose next step', options: ['Inspect', 'Verify'] }] } } }] }]} />)
    expect(screen.getByText('Choose next step')).toBeVisible()
    expect(screen.getByText('Inspect')).toBeVisible()
    expect(screen.getByText('Verify')).toBeVisible()
  })

  it.each(['running', 'completed', 'failed', 'declined'] as const)('preserves %s command and file outcomes in the transcript', (status) => {
    render(<FreshAgentTranscript expandTools isStreaming={status === 'running'} turns={[{ id: 'native', turnId: 'native', role: 'assistant', summary: '', items: [
      { id: 'command', kind: 'command', command: 'check files', status, output: 'Command output', exitCode: status === 'failed' ? 17 : null },
      { id: 'patch', kind: 'file_change', status, changes: [{ path: '/tmp/result.txt' }] },
    ] }]} />)
    const label = { running: 'running', completed: 'complete', failed: 'error', declined: 'declined' }[status]
    expect(screen.getAllByLabelText(label)).toHaveLength(2)
    if (status !== 'completed') expect(screen.queryByLabelText('complete')).not.toBeInTheDocument()
    const command = screen.getByRole('button', { name: 'Bash tool call' })
    if (command.getAttribute('aria-expanded') !== 'true') fireEvent.click(command)
    expect(screen.getByText('Command output')).toBeVisible()
    if (status === 'failed') expect(screen.getByText('Exit code: 17')).toBeVisible()
  })

  it.each([
    [{ provenance: 'saved', diagnostic: 'interrupted', refreshPending: false }, 'Only saved output remains.'],
    [{ provenance: 'retained', diagnostic: 'unsaved', refreshPending: false }, 'Saved output could not be confirmed.'],
    [{ provenance: 'saved-and-retained', diagnostic: 'provider-truncated', refreshPending: false }, 'Codex shortened the saved tool output.'],
    [{ provenance: 'preview', refreshPending: false }, 'Native preview.'],
    [{ provenance: 'retained', refreshPending: true }, 'Waiting for saved history.'],
  ] as const)('renders finite output provenance %j', (outputState, text) => {
    render(<FreshAgentTranscript showTranscriptMinimap={false} turns={[{ id: 't', turnId: 't', role: 'assistant', summary: '', items: [{ id: 'a', kind: 'text', text: 'Available output' }], outputState }]} />)
    expect(screen.getByRole('note', { name: 'Output persistence' })).toHaveTextContent(text)
    expect(screen.getAllByText('Available output')).toHaveLength(1)
  })

  it('keeps richer retained output in a disclosure within the saved turn group', async () => {
    render(<FreshAgentTranscript showTranscriptMinimap={false} turns={[{ id: 't', turnId: 't', role: 'assistant', summary: '', items: [{ id: 'a', kind: 'text', text: 'Saved body' }], outputState: { provenance: 'saved-and-retained', diagnostic: 'interrupted', refreshPending: false, retainedItems: [{ id: 'retained', kind: 'text', text: 'Unfinished retained body' }] } }]} />)
    expect(screen.getAllByLabelText('Assistant transcript turn')).toHaveLength(1)
    fireEvent.click(screen.getByText('Retained output', { selector: 'summary' }))
    expect(await screen.findByText('Unfinished retained body')).toBeVisible()
    expect(screen.getByText('Saved body')).toBeVisible()
  })

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
    // Collapsed tool-bearing line: the summary is the strip's ONLY row —
    // the thinking is absorbed into the 'thought' segment, with no hoisted
    // disclosure.
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
    // Expanding the strip reveals the thinking row AND the tool row.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Bash tool call' })).toBeInTheDocument()
  })

  it('collapses an interleaved thinking-and-tool line to the single summary', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thought and ran',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'first stretch of reasoning' },
              { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'npm test' } },
              { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              { id: 'think-2', kind: 'thinking', text: 'second stretch of reasoning' },
              { id: 'tool-2', kind: 'tool_use', toolUseId: 'call-2', name: 'Read', input: { file_path: 'src/a.ts' } },
              { id: 'result-2', kind: 'tool_result', toolUseId: 'call-2', content: 'ok', isError: false },
            ],
          },
        ]}
      />,
    )

    const strip = screen.getByRole('region', { name: 'Activity strip' })
    expect(strip).toHaveTextContent('thought · 2 tools used')
    // The collapsed tool-bearing line is the summary ALONE: both thinking
    // stretches are absorbed into the 'thought' segment — no hoisted
    // disclosures, no visible thinking text.
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText('first stretch of reasoning')).not.toBeInTheDocument()
    expect(screen.queryByText('second stretch of reasoning')).not.toBeInTheDocument()
    // Expanding the strip reveals BOTH thinking rows (kept separate by the
    // intervening tool rows) plus the two tool rows, in item order.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getAllByRole('button', { name: 'Thinking' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Bash tool call' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read tool call' })).toBeInTheDocument()
  })

  it('starts the strip expanded when expandTools is true', () => {
    render(
      <FreshAgentTranscript
        expandTools
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thought then ran',
            items: [
              { id: 'think-1', kind: 'thinking', text: 'reasoning before the run' },
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
    // Thinking rows render in the expanded detail regardless of the setting.
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
  })

  describe('expansion defaults (mount-only)', () => {
    const mixedTurn = {
      id: 'turn-1',
      role: 'assistant' as const,
      summary: 'thought then ran',
      items: [
        { id: 'think-1', kind: 'thinking' as const, text: 'the race is in the close handler' },
        { id: 'tool-1', kind: 'tool_use' as const, toolUseId: 'call-1', name: 'Bash', input: { command: 'npm test' } },
      ],
    }

    it('gates thinking rows behind the strip toggle on tool-bearing lines', () => {
      const first = render(<FreshAgentTranscript turns={[mixedTurn]} />)
      // Compact mount (expandTools unset): the single summary line only.
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Expanding the strip reveals the thinking row; the body stays gated
      // behind its own click.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const thinking = screen.getByRole('button', { name: 'Thinking' })
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
      fireEvent.click(thinking)
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
      // Collapse the strip: the thinking row hides behind the single
      // summary line again.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      first.unmount()

      // Same line with expandThinking on: the setting governs the row's
      // starting body state inside the expanded strip, never its presence.
      render(<FreshAgentTranscript expandThinking turns={[mixedTurn]} />)
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
    })

    it('starts thinking rows expanded when expandThinking is true', () => {
      const { container } = render(<FreshAgentTranscript expandThinking turns={[mixedTurn]} />)
      // Compact mount: the thinking row is not rendered at all.
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Expanding the strip: the thinking body is ALREADY open — the
      // setting set the row's start state at its mount.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(container.querySelector('.fresh-agent-thinking-body')).toBeTruthy()
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
    })

    it('starts thinking rows collapsed by default', () => {
      const { container } = render(<FreshAgentTranscript turns={[mixedTurn]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const thinking = screen.getByRole('button', { name: 'Thinking' })
      expect(thinking).toHaveAttribute('aria-expanded', 'false')
      expect(container.querySelector('.fresh-agent-thinking-body')).toBeNull()
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
    })

    it('a user-expanded thinking row stays expanded across the tool-disclosure toggle', () => {
      render(<FreshAgentTranscript turns={[mixedTurn]} />)
      // Defaults off: expand the strip, then open the thinking body by hand.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
      // Collapse the strip: the row hides behind the single summary line.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Re-expand: the row's user-opened body is STILL open (the per-row
      // override survives the strip toggle in the never-unmounted strip).
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
    })

    it('a user-collapsed thinking row stays collapsed across the tool-disclosure toggle with expandThinking on', () => {
      render(<FreshAgentTranscript expandThinking turns={[mixedTurn]} />)
      // "Expand thinking" on: expanding the strip shows the body ALREADY
      // open (the setting set the row's start state); the user collapses it.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getAllByText('the race is in the close handler').length).toBeGreaterThanOrEqual(1)
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
      // Toggle the strip (collapsed and back): the body stays hidden — the
      // setting never re-asserts itself mid-session.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('the race is in the close handler')).not.toBeInTheDocument()
    })

    it('mounts the strip collapsed by default (expandTools unset)', () => {
      render(<FreshAgentTranscript turns={[mixedTurn]} />)
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('thought · 1 tool used')
      // Tool rows, captions, and — on this tool-bearing line — thinking
      // rows render only when the strip is expanded.
      expect(screen.queryByRole('button', { name: 'Bash tool call' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    })

    it('expansion is per-mount state, never re-synced from props', () => {
      const thinkingTurnA = {
        id: 'turn-think-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'think-a', kind: 'thinking' as const, text: 'first stretch of reasoning' }],
      }
      const messageTurn = {
        id: 'turn-msg', role: 'assistant' as const, summary: 'note',
        items: [{ id: 'item-msg', kind: 'text' as const, text: 'Between the two lines.' }],
      }
      const thinkingTurnB = {
        id: 'turn-think-b', role: 'assistant' as const, summary: '',
        items: [{ id: 'think-b', kind: 'thinking' as const, text: 'second stretch of reasoning' }],
      }
      const turns = [thinkingTurnA, messageTurn, thinkingTurnB]

      // Two strips, each with its own thinking row, mounted with the compact
      // defaults and left UNTOUCHED. A boolean flip alone cannot distinguish
      // mount-only from re-sync (the user's toggle always converges with the
      // new prop value), so the discriminator is untouched instances.
      const { rerender, unmount } = render(<FreshAgentTranscript turns={turns} />)
      expect(screen.getAllByRole('button', { name: 'Toggle activity details' })).toHaveLength(2)
      expect(screen.getAllByRole('button', { name: 'Thinking' })).toHaveLength(2)

      // Rerender with both expand props flipped on: mount-only keeps BOTH
      // strips and BOTH thinking rows collapsed (a re-sync effect would
      // expand them).
      rerender(<FreshAgentTranscript expandTools expandThinking turns={turns} />)
      for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
      }
      for (const row of screen.getAllByRole('button', { name: 'Thinking' })) {
        expect(row).toHaveAttribute('aria-expanded', 'false')
      }
      expect(screen.queryByText('first stretch of reasoning')).not.toBeInTheDocument()
      expect(screen.queryByText('second stretch of reasoning')).not.toBeInTheDocument()

      // Remount with the props on: the new defaults apply at mount.
      unmount()
      render(<FreshAgentTranscript expandTools expandThinking turns={turns} />)
      for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
      }
      expect(screen.getByText('first stretch of reasoning')).toBeInTheDocument()
      expect(screen.getByText('second stretch of reasoning')).toBeInTheDocument()
    })

    it('the expanded state swaps the summary for detail behind the persistent toggle', () => {
      render(<FreshAgentTranscript turns={[mixedTurn]} />)
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      // Collapsed: the settled summary is the strip's one line, and it is
      // the ONLY row (no hoisted thinking disclosure on a tool-bearing
      // line).
      expect(strip).toHaveTextContent('thought · 1 tool used')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
      // Expand: the toggle row persists and the summary text is REPLACED by
      // the detail rows — including the thinking row.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'true')
      expect(strip).not.toHaveTextContent('1 tool used')
      expect(screen.getByRole('button', { name: 'Bash tool call' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
      // Collapse: the summary returns and the thinking row hides again.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(strip).toHaveTextContent('thought · 1 tool used')
      expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    })

    it('renders a live thinking row disclosure while streaming with the strip collapsed', () => {
      const { container } = render(
        <FreshAgentTranscript
          isStreaming
          turns={[{
            id: 'turn-1',
            role: 'assistant',
            summary: '',
            items: [{ id: 'think-1', kind: 'thinking', text: 'actively reasoning mid-stream' }],
          }]}
        />,
      )
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
      // The reel still shows 'Thinking' in the status slot while the row
      // streams (the reel is the status slot; the hoisted row is the
      // expandable affordance).
      expect(screen.getByLabelText('running')).toBeInTheDocument()
      expect(container.querySelector('[data-slot="name"]')).toHaveTextContent('Thinking')
      // The live thinking row renders its disclosure while the strip is
      // collapsed: the body is absent until click and expandable mid-stream.
      const thinking = screen.getByRole('button', { name: 'Thinking' })
      expect(thinking).toBeInTheDocument()
      expect(screen.queryByText('actively reasoning mid-stream')).not.toBeInTheDocument()
      fireEvent.click(thinking)
      expect(screen.getAllByText('actively reasoning mid-stream').length).toBeGreaterThanOrEqual(1)
    })
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
    // Local time h:mm AM/PM — no seconds, never UTC.
    const expectedTimecode = new Date('2026-06-15T12:34:56.000Z')
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    const timecodeEl = screen.getByText(expectedTimecode)
    expect(timecodeEl.tagName).toBe('TIME')
    expect(timecodeEl.textContent).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)
  })

  it('renders no timecode for a malformed timestamp', () => {
    const { container } = render(
      <FreshAgentTranscript
        showTimecodes
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            timestamp: 'not-a-date',
            summary: 'malformed timestamp turn',
            items: [{ id: 'item-1', kind: 'text', text: 'No clock here.' }],
          },
        ]}
      />,
    )

    expect(screen.getByText('Assistant')).toBeInTheDocument()
    expect(screen.getByText('No clock here.')).toBeInTheDocument()
    expect(container.querySelector('time')).toBeNull()
    expect(screen.queryByText('not-a-date')).toBeNull()
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
    // The reel's status slot carries the 'Thinking' chip. (The hoisted
    // thinking row renders its own 'Thinking' label alongside it — scope
    // the query to the reel's status element so the two text nodes can
    // never collide in a strict getByText.)
    const reel = screen.getByRole('status')
    expect(within(reel).getByText('Thinking')).toBeInTheDocument()
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
            summaryKind: 'echo',
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
            summaryKind: 'echo',
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
            summaryKind: 'echo',
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
            summaryKind: 'echo',
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
            summaryKind: 'echo',
            items: [{ id: 'result-read-1', kind: 'tool_result', toolUseId: 'call-read-1', content: 'one', isError: false }],
          },
          {
            id: 'turn-agent-read-2',
            role: 'assistant',
            summary: 'Read',
            summaryKind: 'echo',
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
            summaryKind: 'echo',
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
            summaryKind: 'echo' as const,
            items: [{ id: 'think-1', kind: 'thinking', text: 'first thought' }],
          },
          {
            id: 'native-turn',
            turnId: 'display-activity-2',
            role: 'assistant',
            summary: 'second thought',
            summaryKind: 'echo' as const,
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

  describe('durable turn errors (opencode projection)', () => {
    const deadlineRaw = '{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}'

    it('renders the durable error module after the turn items', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: 'partial reply', summaryKind: 'echo',
            error: { name: 'UnknownError', message: deadlineRaw },
            items: [{ id: 'item-1', kind: 'text', text: 'partial reply' }],
          }]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveAttribute('role', 'note')
      expect(module).toHaveAttribute('aria-label', 'Agent error')
      expect(module).not.toHaveAttribute('aria-live')
      expect(module).toBeVisible()
      expect(module).toHaveTextContent('request deadline exceeded after 1195s before the response completed')
      expect(module).toHaveTextContent('request_deadline_exceeded')
      const article = module.closest('article')
      expect(article).not.toBeNull()
      const text = article?.textContent ?? ''
      expect(text.indexOf('partial reply')).toBeGreaterThanOrEqual(0)
      expect(text.indexOf('partial reply')).toBeLessThan(text.indexOf('Agent error'))
    })

    it('renders the module for an activity-only errored turn in the absorbed shape (LB-2)', () => {
      render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', summaryKind: 'echo',
              items: [{
                id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
                status: 'completed', arguments: { command: 'true' }, contentItems: ['ok'], success: true,
              }],
            },
            {
              id: 'turn-2', turnId: 'turn-2', role: 'assistant', summary: '', summaryKind: 'echo',
              error: { name: 'UnknownError', message: deadlineRaw },
              items: [{
                id: 'reason-1', kind: 'reasoning',
                summary: ['the provider never answered'], content: ['the provider never answered'],
                text: 'the provider never answered',
              }],
            },
          ]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveTextContent('request deadline exceeded after 1195s before the response completed')
      // The errored turn is a hard boundary: it mounts its own article. Pre-fix
      // this turn was absorbed into turn-1's activity line and skipped entirely.
      expect(screen.getAllByRole('article', { name: 'Assistant transcript turn' })).toHaveLength(2)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('renders a zero-item errored assistant turn as a visible module (the persisted deadline shape)', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', items: [],
            error: { name: 'UnknownError', message: deadlineRaw },
          }]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveAttribute('role', 'note')
      expect(module).toHaveAttribute('aria-label', 'Agent error')
      expect(module).not.toHaveAttribute('aria-live')
      expect(module).toBeVisible()
      expect(module).toHaveTextContent(deadlineRaw)
    })

    it('keeps a zero-item errored last turn visible while the transcript is streaming', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            {
              id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', summaryKind: 'echo',
              items: [{
                id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
                status: 'completed', arguments: { command: 'true' }, contentItems: ['ok'], success: true,
              }],
            },
            {
              id: 'turn-2', turnId: 'turn-2', role: 'assistant', summary: '', summaryKind: 'echo',
              error: { name: 'UnknownError', message: deadlineRaw },
              items: [],
            },
          ]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveAttribute('role', 'note')
      expect(module).toHaveAttribute('aria-label', 'Agent error')
      expect(module).not.toHaveAttribute('aria-live')
      expect(module).toBeVisible()
      expect(module).toHaveTextContent('request deadline exceeded after 1195s before the response completed')
    })

    it('renders MessageAbortedError as a muted interrupted marker, never an error module', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', items: [],
            error: { name: 'MessageAbortedError', message: 'Aborted' },
          }]}
        />,
      )

      const marker = screen.getByTestId('fresh-agent-turn-interrupted')
      expect(marker).toHaveTextContent('interrupted')
      expect(within(marker.closest('article')!).queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
    })

    it('renders the muted interrupted marker for an activity-only aborted turn after an activity turn', () => {
      render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', summaryKind: 'echo',
              items: [{
                id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
                status: 'completed', arguments: { command: 'true' }, contentItems: ['ok'], success: true,
              }],
            },
            {
              id: 'turn-2', turnId: 'turn-2', role: 'assistant', summary: '', summaryKind: 'echo',
              error: { name: 'MessageAbortedError', message: 'Aborted' },
              items: [{
                id: 'reason-1', kind: 'reasoning',
                summary: ['stopped mid-flight'], content: ['stopped mid-flight'],
                text: 'stopped mid-flight',
              }],
            },
          ]}
        />,
      )

      const marker = screen.getByTestId('fresh-agent-turn-interrupted')
      expect(marker).toHaveTextContent('interrupted')
      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
      expect(within(marker.closest('article')!).queryByRole('alert')).not.toBeInTheDocument()
    })

    it('renders no error chrome for a turn without an error (regression)', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: 'ok',
            items: [{ id: 'item-1', kind: 'text', text: 'ok' }],
          }]}
        />,
      )

      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
      expect(screen.queryByTestId('fresh-agent-turn-interrupted')).not.toBeInTheDocument()
    })

    it('re-runs signature-driven auto-scroll when an incremental snapshot adds a turn error', () => {
      let scrollHeight = 1000
      const baseTurn = {
        id: 'turn-1', turnId: 'turn-1', role: 'assistant' as const, summary: 'partial reply', summaryKind: 'echo' as const,
        items: [{ id: 'item-1', kind: 'text' as const, text: 'partial reply' }],
      }
      const { container, rerender } = render(<FreshAgentTranscript turns={[baseTurn]} />)
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
      scroller.scrollTop = 800
      fireEvent.scroll(scroller)

      scrollHeight = 1200
      rerender(
        <FreshAgentTranscript
          turns={[{ ...baseTurn, error: { name: 'UnknownError', message: deadlineRaw } }]}
        />,
      )

      expect(scroller.scrollTop).toBe(1200)
    })

    it('increments the new-message badge when an incremental snapshot adds a dynamic tool error', async () => {
      let scrollHeight = 1000
      const baseItem = {
        id: 'tool-1', kind: 'dynamic_tool' as const, namespace: 'opencode', tool: 'bash',
        status: 'failed' as const, arguments: { command: 'false' }, contentItems: ['nope'], success: false,
      }
      const baseTurn = {
        id: 'turn-1', turnId: 'turn-1', role: 'assistant' as const, summary: 'ran a tool', summaryKind: 'authored' as const,
        items: [baseItem],
      }
      const { container, rerender } = render(<FreshAgentTranscript turns={[baseTurn]} />)
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })

      scroller.scrollTop = 100
      fireEvent.scroll(scroller)
      const button = await screen.findByRole('button', { name: 'Scroll to bottom' })
      await waitFor(() => expect(button).toHaveTextContent('1 new'))

      scrollHeight = 1200
      rerender(
        <FreshAgentTranscript
          turns={[{ ...baseTurn, items: [{ ...baseItem, error: 'boom: request failed' }] }]}
        />,
      )

      await waitFor(() => expect(button).toHaveTextContent('2 new'))
    })
  })

  describe('streaming height stability (jp70)', () => {
    const thinkingOnly = (turnId: string, thinkId: string, text: string) => ({
      id: turnId,
      role: 'assistant' as const,
      summary: 'thinking',
      items: [{ id: thinkId, kind: 'thinking' as const, text }],
    })

    it('renders a live activity strip placeholder when a streaming turn has no items', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[{ id: 'turn-1', role: 'assistant', summary: '', items: [] }]}
        />,
      )

      const strip = screen.getByRole('region', { name: 'Activity strip' })
      expect(strip).toBeInTheDocument()
      expect(strip.className).toContain('my-0.5')
      expect(screen.getByLabelText('running')).toBeInTheDocument()
    })

    it('keeps the live activity strip present across zero-item/tool transitions', () => {
      const zeroItem = (turnId: string) => ({
        id: turnId,
        role: 'assistant' as const,
        summary: '',
        items: [] as FreshAgentTranscriptItem[],
      })
      const withTool = (turnId: string, toolId: string, callId: string) => ({
        id: turnId,
        role: 'assistant' as const,
        summary: '',
        items: [{
          id: toolId,
          kind: 'tool_use' as const,
          toolUseId: callId,
          name: 'Bash',
          input: { command: 'true' },
        }],
      })

      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[zeroItem('turn-1')]} />,
      )

      const assertStripPresent = () => {
        const strip = screen.getByRole('region', { name: 'Activity strip' })
        expect(strip).toBeInTheDocument()
        expect(strip.className).toContain('my-0.5')
        expect(screen.getAllByLabelText('running')).toHaveLength(1)
      }

      assertStripPresent()

      rerender(
        <FreshAgentTranscript isStreaming turns={[withTool('turn-1', 'tool-1', 'call-1')]} />,
      )
      assertStripPresent()

      rerender(
        <FreshAgentTranscript isStreaming turns={[zeroItem('turn-2')]} />,
      )
      assertStripPresent()

      rerender(
        <FreshAgentTranscript isStreaming turns={[withTool('turn-2', 'tool-2', 'call-2')]} />,
      )
      assertStripPresent()
    })

    it('does not show a second running indicator on an earlier line while a thinking-only tail streams visibly', () => {
      render(
        <FreshAgentTranscript
          isStreaming
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
            {
              id: 'turn-note',
              role: 'assistant',
              summary: 'note',
              items: [{ id: 'item-note', kind: 'text', text: 'Interim note.' }],
            },
            thinkingOnly('turn-2', 'think-2', 'live reasoning tail'),
          ]}
        />,
      )

      // The message closes the first line, so the thinking-only tail streams
      // on its own visible line: exactly one running indicator, on the live
      // tail; the earlier line settles with its summary.
      expect(screen.getAllByLabelText('running')).toHaveLength(1)
      const strips = screen.getAllByRole('region', { name: 'Activity strip' })
      expect(strips).toHaveLength(2)
      expect(strips[0]).toHaveTextContent('1 tool used')
      // The thinking-only tail renders visibly (hoisted row + 'Thinking'
      // reel), never filtered away.
      expect(strips[1]).toHaveTextContent('Thinking')
      expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    })

    it('renders a thinking-only turn as an activity strip (never dropped)', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1',
            role: 'assistant',
            summary: '',
            items: [{ id: 'think-1', kind: 'thinking', text: 'deliberating quietly' }],
          }]}
        />,
      )

      // The turn keeps its article and renders an activity strip — a
      // thinking-only turn is never dropped, and its row is always present.
      expect(screen.getByRole('article', { name: 'Assistant transcript turn' })).toBeInTheDocument()
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      expect(strip).toBeInTheDocument()
      expect(strip).toHaveTextContent('Thinking')
      expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    })

    it('does not resnap autoscroll when re-rendering with the same streaming items', () => {
      let scrollHeight = 1000
      const turn = thinkingOnly('turn-1', 'think-1', 'streaming reasoning')
      const { container, rerender } = render(
        <FreshAgentTranscript isStreaming turns={[turn]} />,
      )
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
      scroller.scrollTop = 1000
      fireEvent.scroll(scroller)

      expect(scroller.scrollTop).toBe(1000)

      scrollHeight = 1200
      rerender(<FreshAgentTranscript isStreaming turns={[turn]} />)

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

    it('shows only the first line of a multi-line user message, with the full text as tooltip', () => {
      const MULTILINE = [
        {
          id: 'u1',
          role: 'user' as const,
          summary: 'First line of command\nSecond line of command\nThird line',
          items: [{
            id: 'i1',
            kind: 'text' as const,
            text: 'First line of command\nSecond line of command\nThird line',
          }],
        },
        {
          id: 'a1',
          role: 'assistant' as const,
          summary: 'reply',
          items: [{ id: 'i2', kind: 'text' as const, text: 'A'.repeat(200) }],
        },
      ]
      const { container } = render(<FreshAgentTranscript turns={MULTILINE} />)
      const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      mockScroll(scroller, 400, 1000, 200)
      const userTurns = container.querySelectorAll('[data-turn-role="user"]')
      mockRect(scroller, 0)
      mockRect(userTurns[0], -100)
      fireEvent.scroll(scroller)

      const chip = screen.getByRole('button', { name: /Jump to your message/ })
      expect(chip).toHaveTextContent('First line of command')
      expect(chip).not.toHaveTextContent('Second line of command')
      expect(chip).toHaveAttribute('title', 'First line of command\nSecond line of command\nThird line')
      expect(chip).toHaveAttribute('aria-label', 'Jump to your message: First line of command\nSecond line of command\nThird line')
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

    it('registers a pane-scoped turn-items builder for the unified context menu and no local menu of its own', () => {
      const onFork = vi.fn()
      const { unmount } = render(
        <FreshAgentTranscript paneId="pane-test" turns={TURNS} canFork onForkFromTurn={onFork} />,
      )

      // Fine-pointer right-click: the transcript yields the gesture to the
      // global ContextMenuProvider — no preventDefault, no transcript-rendered
      // menu. The provider builds the visible menu from the registry below.
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      act(() => {
        screen.getByRole('article', { name: 'Assistant transcript turn' }).dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(false)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()

      // The registered builder resolves an article index to that article's
      // action turn and returns the SAME items the touch action sheet shows
      // (buildTurnActionItems is the single builder for both surfaces).
      const build = getFreshAgentTurnItemsBuilder('pane-test')
      expect(build).toBeDefined()
      const items = build!(1)
      expect(items?.map((item) => item.label)).toEqual([
        'Copy turn text',
        'Fork conversation from here',
        'Undo to here',
        'Rewind code to here',
      ])
      items![1].run()
      expect(onFork).toHaveBeenCalledWith('turn-2')

      // Unknown/out-of-range article indexes yield no turn rows.
      expect(build!(42)).toBeNull()

      unmount()
      expect(getFreshAgentTurnItemsBuilder('pane-test')).toBeUndefined()
    })

    it('yields to the provider menu for a fine-pointer right-click on a code block inside a turn', () => {
      const { container } = render(
        <FreshAgentTranscript
          canFork={false}
          turns={[{
            id: 'turn-code',
            turnId: 'turn-code',
            role: 'assistant' as const,
            summary: 'code answer',
            items: [{
              id: 'item-code',
              kind: 'text' as const,
              text: 'Here is the fix:\n\n```ts\nconst x: number = 1\n```',
            }],
          }]}
        />,
      )

      // Assistant text renders as markdown: the fenced code block produces the
      // specialized `.prose pre code` sub-region.
      const codeEl = container.querySelector('article .prose pre code') as HTMLElement | null
      expect(codeEl, 'assistant fenced code block renders .prose pre code').not.toBeNull()

      // The transcript article yields WITHOUT preventDefault and without its
      // turn menu — the provider's capture-phase handler already opened the
      // context-sensitive fresh-agent menu for this gesture.
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      act(() => {
        codeEl!.dispatchEvent(event)
      })

      expect(event.defaultPrevented).toBe(false)
      expect(screen.queryByRole('menu', { name: 'Turn context menu' })).not.toBeInTheDocument()
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('offers rewind only on user turns and passes the turn through', () => {
      const onRewind = vi.fn()
      render(<FreshAgentTranscript turns={TURNS} canFork={false} onRewindToTurn={onRewind} />)

      const rewindButtons = screen.getAllByRole('button', { name: 'Rewind code to here' })
      expect(rewindButtons).toHaveLength(1)
      fireEvent.click(rewindButtons[0])
      expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ id: 'turn-1', role: 'user' }))
    })

    it('shows unavailable rewind state and disables the action on the affected turn', () => {
      const reason = 'Select a project folder to save code rewind.'
      const onRewind = vi.fn()
      render(
        <FreshAgentTranscript
          paneId="pane-unavailable-rewind"
          turns={TURNS}
          canFork={false}
          onRewindToTurn={onRewind}
          getRewindAvailability={(turn) => turn.turnId === 'turn-1' ? { status: 'unavailable', reason } : undefined}
        />,
      )

      const userArticle = screen.getByRole('article', { name: 'You transcript turn' })
      expect(within(userArticle).getByRole('note', { name: 'Code rewind unavailable for this message' }))
        .toHaveTextContent(`Code rewind unavailable for this message: ${reason}`)
      expect(within(userArticle).getByRole('button', { name: 'Rewind unavailable for this message' })).toBeDisabled()

      const build = getFreshAgentTurnItemsBuilder('pane-unavailable-rewind')
      const rewindItem = build!(0)!.find((item) => item.label.startsWith('Rewind unavailable:'))
      expect(rewindItem).toMatchObject({ label: `Rewind unavailable: ${reason}`, disabled: true })
      expect(onRewind).not.toHaveBeenCalled()
    })

    it('gates fork/rollback/rewind per capability and role through the registered builder', () => {
      const onRewind = vi.fn()
      render(
        <FreshAgentTranscript
          paneId="pane-test"
          turns={TURNS}
          canFork={false}
          canRollback
          onRollbackToTurn={vi.fn()}
          onRewindToTurn={onRewind}
        />,
      )

      const build = getFreshAgentTurnItemsBuilder('pane-test')
      expect(build).toBeDefined()
      const userItems = build!(0)!
      const assistantItems = build!(1)!

      // User turn: fork needs the capability stamp; rewind is offered.
      expect(userItems.find((item) => item.label === 'Fork conversation from here')?.disabled).toBe(true)
      expect(userItems.find((item) => item.label === 'Rewind code to here')?.disabled).toBeFalsy()
      expect(userItems.find((item) => item.label === 'Undo to here')?.disabled).toBeFalsy()

      // Assistant turn: undo and rewind stay role-gated off, fork disabled.
      expect(assistantItems.find((item) => item.label === 'Rewind code to here')?.disabled).toBe(true)
      expect(assistantItems.find((item) => item.label === 'Undo to here')?.disabled).toBe(true)
      expect(assistantItems.find((item) => item.label === 'Fork conversation from here')?.disabled).toBe(true)
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

    it('permanently separates tool runs when the follower turn carries an untagged (unknown-provenance) summary', () => {
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
      // Conservative rule: a server that does not emit summaryKind leaves every non-blank summary authored — no absorb, no folding.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('still merges a follower whose summary merely echoes one of its own items (codex tool preview)', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-c', turnId: 'turn-c', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('treats an explicit authored summary as a boundary even when its text echoes an item', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-c', turnId: 'turn-c', role: 'assistant', summary: 'Read', summaryKind: 'authored',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('pins the streaming summary cadence: an authored summary permanently keeps the following tool run on its own line', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnCEmpty = {
        id: 'turn-c', turnId: 'turn-c', role: 'assistant' as const,
        summary: 'Wrapping up shortly', summaryKind: 'authored' as const, items: [],
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

    it('keeps a coalesced synthetic tool-result turn echo when both sides are echo', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-x', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
            { id: 'turn-r', turnId: 'turn-r', role: 'user', summary: 'Tool result', summaryKind: 'echo',
              items: [{ id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false }] },
          ]}
        />,
      )
      // turn-r coalesces into turn-b (echo + echo stays echo), which absorbs
      // into turn-x's line.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
    })

    it('tags a coalesced synthetic tool-result turn authored when either side is authored', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-x', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
            { id: 'turn-r', turnId: 'turn-r', role: 'user', summary: 'Tool result', summaryKind: 'authored',
              items: [{ id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false }] },
          ]}
        />,
      )
      // echo + authored -> authored: the coalesced turn is a boundary and
      // keeps its own line.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('merges a mixed thinking-plus-tool turn whose summary mixes thinking and tool (live claude shape)', () => {
      // Thinking always renders now; the turn merges into the open line
      // because its activity items chain — the thinking row and the tool row
      // both join the line, and the space-joined echo summary never paints
      // in-stream (the article renders its activity block).
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Considering Read', summaryKind: 'echo',
              items: [
                { id: 'think-1', kind: 'thinking', text: 'Considering' },
                { id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('merges a mixed thinking-plus-tool turn whose summary is the thinking text (Rust snapshot shape)', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Considering', summaryKind: 'echo',
              items: [
                { id: 'think-1', kind: 'thinking', text: 'Considering' },
                { id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
              ] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('stashes a superseded tail caption into the line expansion when the next turn absorbs', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const,
        summary: 'Wrapping up shortly', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      // Frame 1: turnB is the tail of the final open line — its echo caption
      // paints in-stream after the line.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[turnA, turnB]} />,
      )
      expect(screen.getByTestId('fresh-agent-tail-caption')).toHaveTextContent('Wrapping up shortly')
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)

      // Frame 2: turnC absorbs into the line; turnB is superseded — the
      // caption leaves the stream and stashes into the expansion.
      const turnC = {
        id: 'turn-c', turnId: 'turn-c', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c3', kind: 'tool_use' as const, toolUseId: 'c3', name: 'Read', input: { file_path: 'src/c.ts' } }],
      }
      rerender(<FreshAgentTranscript isStreaming turns={[turnA, turnB, turnC]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Wrapping up shortly')).not.toBeInTheDocument()
      // This is the POSITIVE fully-visible case: all turns are item-bearing
      // and thinking always renders, so nothing is filtered out and the
      // caption stashes.
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const caption = screen.getByTestId('fresh-agent-activity-caption')
      expect(caption).toHaveTextContent('Wrapping up shortly')
      // The stash anchors where turnB entered the line: after turnA's row,
      // before turnB's tool row.
      const toolB = screen.getByText('src/b.ts')
      expect(caption.compareDocumentPosition(toolB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    describe('foldable echo captions', () => {
      it('stashes a superseded echo caption from a thinking-bearing turn', () => {
        const thinkingToolTurn = {
          id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
          summary: 'Considering options', summaryKind: 'echo' as const,
          items: [
            { id: 'think-1', kind: 'thinking' as const, text: 'Considering options' },
            { id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
          ],
        }
        render(
          <FreshAgentTranscript
            isStreaming
            turns={[
              toolTurn('turn-a', [['c1', 'src/a.ts']]),
              thinkingToolTurn,
              toolTurn('turn-z', [['c3', 'src/d.ts']]),
            ]}
          />,
        )
        // One merged line; the blank-captioned turn-z is the tail, so the
        // superseded caption paints nothing in-stream.
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
        expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
        // The caption stashes into the line's expansion, and the thinking row
        // renders alongside it — thinking-bearing turns are fully visible.
        fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
        const caption = screen.getByTestId('fresh-agent-activity-caption')
        expect(caption).toHaveTextContent('Considering options')
        const thinking = screen.getByRole('button', { name: 'Thinking' })
        expect(thinking).toBeInTheDocument()
        fireEvent.click(thinking)
        expect(screen.getAllByText('Considering options').length).toBeGreaterThanOrEqual(1)
      })

      it('stashes superseded echo captions from a thinking-bearing turn (claude lane)', () => {
        // Claude lane: [thinking "secret plans", tool_use] plus a visible
        // echo control turn. Under always-visible semantics every item-bearing
        // turn is fully visible, so BOTH superseded echo captions stash — the
        // old hidden-item no-leak gate died with the display filter, and the
        // thinking row renders with its own expandable body.
        const secretTurn = {
          id: 'turn-secret', turnId: 'turn-secret', role: 'assistant' as const,
          summary: 'secret plans', summaryKind: 'echo' as const,
          items: [
            { id: 'think-secret', kind: 'thinking' as const, text: 'secret plans' },
            { id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
          ],
        }
        const visibleTurn = {
          id: 'turn-visible', turnId: 'turn-visible', role: 'assistant' as const,
          summary: 'Read', summaryKind: 'echo' as const,
          items: [{ id: 'tool-c3', kind: 'tool_use' as const, toolUseId: 'c3', name: 'Read', input: { file_path: 'src/c.ts' } }],
        }
        render(
          <FreshAgentTranscript
            isStreaming
            turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), secretTurn, visibleTurn, toolTurn('turn-z', [['c4', 'src/d.ts']])]}
          />,
        )
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
        // turn-z is the blank-captioned tail, so nothing paints in-stream…
        expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
        const captions = screen.getAllByTestId('fresh-agent-activity-caption')
        expect(captions).toHaveLength(2)
        expect(captions[0]).toHaveTextContent('secret plans')
        expect(captions[1]).toHaveTextContent('Read')
        // The thinking row renders, visible by contract — its body carries
        // the same text the caption echoes.
        const thinking = screen.getByRole('button', { name: 'Thinking' })
        expect(thinking).toBeInTheDocument()
        fireEvent.click(thinking)
        expect(screen.getAllByText('secret plans').length).toBeGreaterThanOrEqual(1)
        // The visible items from the thinking-bearing turn still absorbed.
        expect(screen.getByText('src/b.ts')).toBeInTheDocument()
        expect(screen.getByText('src/c.ts')).toBeInTheDocument()
      })

      it('stashes superseded echo captions from a reasoning-bearing turn (codex lane)', () => {
        // Codex lane: [reasoning{summary: []}, command] plus a visible echo
        // control turn — reasoning rows are always visible now, so BOTH
        // superseded echo captions stash and the reasoning row renders.
        const secretTurn = {
          id: 'turn-secret', turnId: 'turn-secret', role: 'assistant' as const,
          summary: 'secret plans', summaryKind: 'echo' as const,
          items: [
            { id: 'reason-secret', kind: 'reasoning' as const, summary: [] as string[], content: ['secret plans'], text: 'secret plans' },
            { id: 'cmd-c2', kind: 'command' as const, command: 'ls src', status: 'completed' as const },
          ],
        }
        const visibleTurn = {
          id: 'turn-visible', turnId: 'turn-visible', role: 'assistant' as const,
          summary: 'ls test', summaryKind: 'echo' as const,
          items: [{ id: 'cmd-c3', kind: 'command' as const, command: 'ls test', status: 'completed' as const }],
        }
        render(
          <FreshAgentTranscript
            isStreaming
            turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), secretTurn, visibleTurn, toolTurn('turn-z', [['c4', 'src/d.ts']])]}
          />,
        )
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
        fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
        const captions = screen.getAllByTestId('fresh-agent-activity-caption')
        expect(captions).toHaveLength(2)
        expect(captions[0]).toHaveTextContent('secret plans')
        expect(captions[1]).toHaveTextContent('ls test')
        const thinking = screen.getByRole('button', { name: 'Thinking' })
        expect(thinking).toBeInTheDocument()
        fireEvent.click(thinking)
        expect(screen.getAllByText('secret plans').length).toBeGreaterThanOrEqual(1)
      })

      it('treats a zero-item blank-summary turn as a benign line boundary (opencode structural-message shape)', () => {
        // Routine in opencode (LB-4): a message whose parts are all structural
        // (step-start/step-finish) arrives as a turn with items: [] and
        // summary: ''. It renders nothing, stashes nothing, and still
        // hard-closes the open line.
        render(
          <FreshAgentTranscript
            isStreaming
            turns={[
              toolTurn('turn-a', [['c1', 'src/a.ts']]),
              { id: 'turn-empty', turnId: 'turn-empty', role: 'assistant', summary: '', summaryKind: 'echo', items: [] },
              toolTurn('turn-b', [['c2', 'src/b.ts']]),
            ]}
          />,
        )
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
        for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
          fireEvent.click(toggle)
        }
        expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
      })

      it('a zero-item structural turn closes the line and folds its last member caption into the expansion', () => {
        // Supersede semantics (fresh-eyes round 2, Finding 3): the zero-item
        // opencode structural turn contributes nothing itself — but its ARRIVAL
        // is a later-activity boundary that closes the open line, so the closing
        // line's last member is superseded and its gated echo caption stashes.
        // Without this, a caption painted moments ago would vanish with nowhere
        // to go — the exact failure the fold feature exists to fix.
        const captionTurn = {
          id: 'turn-caption', turnId: 'turn-caption', role: 'assistant' as const,
          summary: 'Considering options', summaryKind: 'echo' as const,
          items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
        }
        render(
          <FreshAgentTranscript
            isStreaming
            turns={[
              toolTurn('turn-a', [['c1', 'src/a.ts']]),
              captionTurn,
              { id: 'turn-empty', turnId: 'turn-empty', role: 'assistant' as const, summary: '', summaryKind: 'echo' as const, items: [] },
              toolTurn('turn-b', [['c3', 'src/c.ts']]),
            ]}
          />,
        )
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
        expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
        expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
        fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[0])
        expect(screen.getByTestId('fresh-agent-activity-caption')).toHaveTextContent('Considering options')
      })

      it('a multi-line echo turn paints/stashes its caption in exactly ONE place (caption transfer)', () => {
        // Real producer shape (fresh-eyes round 3, Finding 1): one assistant turn
        // interleaves [tool, visible text, tool], which spans TWO activity lines.
        // The turn's caption must transfer to the turn's next line at the text
        // boundary, never appearing in two places in one frame.
        const multiLineTurn = {
          id: 'turn-multi', turnId: 'turn-multi', role: 'assistant' as const,
          summary: 'Reading the config files', summaryKind: 'echo' as const,
          items: [
            { id: 'tool-m1', kind: 'tool_use' as const, toolUseId: 'm1', name: 'Read', input: { file_path: 'src/a.ts' } },
            { id: 'text-mid', kind: 'text' as const, text: 'Both files read fine.' },
            { id: 'tool-m2', kind: 'tool_use' as const, toolUseId: 'm2', name: 'Read', input: { file_path: 'src/b.ts' } },
          ],
        }
        const { rerender } = render(
          <FreshAgentTranscript isStreaming turns={[multiLineTurn]} />,
        )
        // Live frame: the caption paints ONCE, as the tail caption of the turn's
        // SECOND line (the final open line) — not in the first line's expansion.
        const streamMatches = screen.getAllByText('Reading the config files')
        expect(streamMatches).toHaveLength(1)
        expect(screen.getByTestId('fresh-agent-tail-caption')).toHaveTextContent('Reading the config files')
        for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
          fireEvent.click(toggle)
        }
        expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
        // Reset both strips to COLLAPSED: line ids (`line:N`) are stable per
        // frame, so the strip's `expanded` state survives the rerender below —
        // the frame-2 "not in the document" assertion and toggle directions
        // require both strips collapsed again.
        for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
          fireEvent.click(toggle)
        }

        // A later turn supersedes the second line: the caption folds into THAT
        // line's expansion — still exactly one visible place.
        rerender(
          <FreshAgentTranscript
            isStreaming
            turns={[multiLineTurn, toolTurn('turn-z', [['c9', 'src/z.ts']])]}
          />,
        )
        expect(screen.queryByText('Reading the config files')).not.toBeInTheDocument()
        const strips = screen.getAllByRole('region', { name: 'Activity strip' })
        expect(strips).toHaveLength(2)
        expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
        fireEvent.click(strips[1].querySelector('button[aria-label="Toggle activity details"]')!)
        const caption = screen.getByTestId('fresh-agent-activity-caption')
        expect(caption).toHaveTextContent('Reading the config files')
        // First line's expansion stays caption-free (the transfer happened).
        fireEvent.click(strips[0].querySelector('button[aria-label="Toggle activity details"]')!)
        expect(screen.getAllByTestId('fresh-agent-activity-caption')).toHaveLength(1)
      })

      it('never folds authored prose: it stays painted and keeps the lines separate', () => {
        const proseTurn = {
          id: 'turn-prose', turnId: 'turn-prose', role: 'assistant' as const,
          summary: 'Pausing to plan the next step', summaryKind: 'authored' as const, items: [],
        }
        const { rerender } = render(
          <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), proseTurn]} />,
        )
        expect(screen.getByText('Pausing to plan the next step')).toBeInTheDocument()
        rerender(
          <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), proseTurn, toolTurn('turn-b', [['c2', 'src/b.ts']])]} />,
        )
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
        expect(screen.getByText('Pausing to plan the next step')).toBeInTheDocument()
        fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[1])
        expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
      })

      it('keeps liveness pinned to the last non-caption row when a stashed caption trails a merged thinking row', () => {
        // Task-004 review finding M1 (caption-skip liveness guards). Shape:
        // turn-a ([tool, thinking] member) + turn-b entering on a THINKING item
        // that MERGES into turn-a's thinking row (rowStartItemIndexes keeps the
        // FIRST contributing index), carrying a fully-visible echo caption
        // anchored at the line's final item index; turn-c (blank echo)
        // supersedes turn-b, so turn-b's caption stashes AFTER the merged
        // thinking row — the line's last ROW is a caption, and both liveness
        // paths must judge the last NON-caption row instead.
        const turnA = {
          id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
          items: [
            { id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } },
            { id: 'result-c1', kind: 'tool_result' as const, toolUseId: 'c1', content: 'ok', isError: false },
            { id: 'think-a', kind: 'thinking' as const, text: 'Mapping the layout' },
          ],
        }
        const turnB = {
          id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const,
          summary: 'Weighing the next file', summaryKind: 'echo' as const,
          items: [{ id: 'think-b', kind: 'thinking' as const, text: 'Weighing the next file' }],
        }
        const turnC = {
          id: 'turn-c', turnId: 'turn-c', role: 'assistant' as const,
          summary: '', summaryKind: 'echo' as const,
          items: [{ id: 'think-c', kind: 'thinking' as const, text: 'Final deliberation' }],
        }
        const { rerender } = render(
          <FreshAgentTranscript isStreaming turns={[turnA, turnB, turnC]} />,
        )
        // Streaming: one merged line; the strip stays live on the merged
        // THINKING row — the spinner and the 'Thinking' reel survive even
        // though the line's final row is the stashed caption. (While this
        // tool-bearing line is collapsed there is no hoisted Thinking row;
        // the reel's status element carries the only 'Thinking' text —
        // scope the query to it so the text nodes can't collide if the
        // strip is ever expanded.)
        expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
        expect(screen.getByLabelText('running')).toBeInTheDocument()
        expect(within(screen.getByRole('status')).getByText('Thinking')).toBeInTheDocument()
        // The superseded caption is folded: nothing paints in the stream.
        expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
        expect(screen.queryByText('Weighing the next file')).not.toBeInTheDocument()

        // Settled flip: the trailing merged thinking row still settles the
        // strip live (matching the existing trailing-thinking settled pin) —
        // the caption at the end of the line's rows must not confuse the
        // settled branch's candidate either.
        rerender(<FreshAgentTranscript isStreaming={false} turns={[turnA, turnB, turnC]} />)
        expect(screen.getByLabelText('running')).toBeInTheDocument()
        expect(within(screen.getByRole('status')).getByText('Thinking')).toBeInTheDocument()
        expect(screen.queryByText('Weighing the next file')).not.toBeInTheDocument()

        // The stashed caption lives inside the expansion, AFTER the merged
        // thinking row (its anchor item index trails every row's first
        // contributing item index, so buildActivity appends it last).
        fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
        const captions = screen.getAllByTestId('fresh-agent-activity-caption')
        expect(captions).toHaveLength(1)
        expect(captions[0]).toHaveTextContent('Weighing the next file')
        const thinkingRow = screen.getByRole('button', { name: 'Thinking' })
        expect(captions[0].compareDocumentPosition(thinkingRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
      })

      it('strips system-reminders from painted and stashed echo captions (delta review R1-F1)', () => {
        // R1-F1: foldCaption copied turn.summary verbatim into both caption
        // copies, bypassing the stripSystemReminders sanitation every other
        // summary render path uses. A fully-visible echo turn whose summary
        // projects an item containing <system-reminder>…</system-reminder>
        // (routine in claude lanes — reminders hide in text/tool-result
        // blocks and never render as items) would expose the hidden text as
        // a visible caption, both painted at the tail and stashed in the
        // expansion after supersede.
        const captionTurn = {
          id: 'turn-caption', turnId: 'turn-caption', role: 'assistant' as const,
          summary: 'Reading setup<system-reminder>hidden internals</system-reminder> for the merge',
          summaryKind: 'echo' as const,
          items: [
            { id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } },
            { id: 'result-c1', kind: 'tool_result' as const, toolUseId: 'c1', content: 'ok', isError: false },
          ],
        }
        const { rerender } = render(
          <FreshAgentTranscript isStreaming turns={[captionTurn]} />,
        )
        // Paint position: the tail caption shows only the sanitized text.
        const tailCaption = screen.getByTestId('fresh-agent-tail-caption')
        expect(tailCaption).toHaveTextContent('Reading setup for the merge')
        expect(tailCaption.textContent).not.toContain('hidden internals')
        expect(screen.queryByText(/hidden internals/)).not.toBeInTheDocument()

        // Superseded by a later same-role activity turn: the caption folds
        // into the line's expansion — still sanitized, reminder still absent.
        rerender(
          <FreshAgentTranscript isStreaming turns={[captionTurn, toolTurn('turn-z', [['c9', 'src/z.ts']])]} />,
        )
        expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
        expect(screen.queryByText(/hidden internals/)).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
        const stashed = screen.getByTestId('fresh-agent-activity-caption')
        expect(stashed).toHaveTextContent('Reading setup for the merge')
        expect(stashed.textContent).not.toContain('hidden internals')
      })
    })
  })
})

describe('rolled-back section (kata 1wxv decision 6)', () => {
  afterEach(() => cleanup())

  function markerTurns(restorable?: boolean): FreshAgentTurn[] {
    // Two undone STEPS = four marker ROWS (a user row and an assistant row each).
    // `restorable` omitted ⇒ the older-server payload shape (no key ⇒ all
    // markers historical); passed ⇒ the server-stamped shape (true while the
    // step is still restorable, false once redo is destroyed).
    const stamp = restorable === undefined ? {} : { restorable }
    return [
      { id: 'u2', turnId: 'u2', role: 'user', summary: 'second prompt', items: [{ id: 'u2-i1', kind: 'text', text: 'second prompt' }], rolledBack: true, ...stamp },
      { id: 'a2', turnId: 'a2', role: 'assistant', summary: 'second answer', items: [{ id: 'a2-i1', kind: 'text', text: 'second answer' }], rolledBack: true, ...stamp },
      { id: 'u3', turnId: 'u3', role: 'user', summary: 'third prompt', items: [{ id: 'u3-i1', kind: 'text', text: 'third prompt' }], rolledBack: true, ...stamp },
      { id: 'a3', turnId: 'a3', role: 'assistant', summary: 'third answer', items: [{ id: 'a3-i1', kind: 'text', text: 'third answer' }], rolledBack: true, ...stamp },
    ]
  }

  it('renders nothing when rolledBackTurns is empty', () => {
    render(
      <FreshAgentTranscript
        turns={[{ id: 'u1', turnId: 'u1', role: 'user', summary: 'first prompt', items: [{ id: 'u1-i1', kind: 'text', text: 'first prompt' }] }]}
        rolledBackTurns={[]}
      />,
    )

    expect(screen.getByText('first prompt')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Rolled back turns' })).toBeNull()
  })

  it('renders restorable marker rows expanded with the USER-STEP count label (r3 correction 5)', () => {
    // The label matches the server's rollback.undoneDepth: steps (user-role
    // marker groups), never the raw marker-row count (4) and never entries.len().
    render(<FreshAgentTranscript turns={[]} rolledBackTurns={markerTurns(true)} />)

    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    expect(screen.getByText('Rolled back (2) — gone from the conversation; redo to restore.')).toBeInTheDocument()
    expect(section).not.toHaveTextContent('Rolled back (4)')
    expect(within(section).getByText('second prompt')).toBeInTheDocument()
    expect(within(section).getByText('second answer')).toBeInTheDocument()
    expect(within(section).getByText('third prompt')).toBeInTheDocument()
    expect(within(section).getByText('third answer')).toBeInTheDocument()
    // No historical rows ⇒ no disclosure line at all.
    expect(screen.queryByRole('button', { name: /Toggle rolled-back history/ })).toBeNull()
  })

  it('collapses non-restorable markers behind the history line with the historical step count', () => {
    // Older-server shape: no `restorable` key anywhere ⇒ every marker is
    // historical ⇒ nothing renders expanded; the quiet line is the only surface.
    render(<FreshAgentTranscript turns={[]} rolledBackTurns={markerTurns()} />)

    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    const toggle = within(section).getByRole('button', { name: /Toggle rolled-back history/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Rolled back (2) — kept in history')
    // Label-in-name (WCAG 2.5.3): the ACCESSIBLE NAME must contain the visible
    // label — a speech-input user saying "Rolled back two kept in history" has
    // to reach this control. Querying by the visible-label portion of the name
    // is the red/green pin for the aria-label repair: a bare action-only
    // aria-label ("Toggle rolled-back history") would fail this query.
    expect(within(section).getByRole('button', { name: /Rolled back \(2\) — kept in history/ })).toBe(toggle)
    expect(screen.queryByText('second prompt')).toBeNull()
    expect(screen.queryByText('second answer')).toBeNull()
    expect(screen.queryByText('third prompt')).toBeNull()
    expect(screen.queryByText('third answer')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(section).getByText('second prompt')).toBeInTheDocument()
    expect(within(section).getByText('second answer')).toBeInTheDocument()
    expect(within(section).getByText('third prompt')).toBeInTheDocument()
    expect(within(section).getByText('third answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()
  })

  it('per-row Redo to here fires onRedoToTurn only on redoable user rows when canRedo', () => {
    const onRedoToTurn = vi.fn()
    render(
      <FreshAgentTranscript
        turns={[]}
        rolledBackTurns={markerTurns(true)}
        canRedo
        redoableTurnIds={['u2', 'u3']}
        onRedoToTurn={onRedoToTurn}
      />,
    )

    // Only the two redoable USER rows expose the button; assistant rows never do.
    const redoButtons = screen.getAllByRole('button', { name: 'Redo to here' })
    expect(redoButtons).toHaveLength(2)
    fireEvent.click(redoButtons[0])
    expect(onRedoToTurn).toHaveBeenCalledWith('u2')
    fireEvent.click(redoButtons[1])
    expect(onRedoToTurn).toHaveBeenCalledWith('u3')
  })

  it('delta-r1 F6: frozen prior-epoch markers (absent from redoableTurnIds) expose NO Redo to here', () => {
    // undo → send destroys redo → a NEW epoch's undos land behind the frozen
    // ones: the union is [frozen u2/a2 rows (no restorable stamp), current
    // u3/a3 rows (restorable)] — only the current epoch's tail renders
    // expanded with its redo affordance; the frozen pair collapses behind
    // the history line.
    const onRedoToTurn = vi.fn()
    const frozenRows = markerTurns().slice(0, 2)
    const currentRows = markerTurns(true).slice(2)
    render(
      <FreshAgentTranscript
        turns={[]}
        rolledBackTurns={[...frozenRows, ...currentRows]}
        canRedo
        redoableTurnIds={['u3']}
        onRedoToTurn={onRedoToTurn}
      />,
    )

    expect(screen.getByRole('region', { name: 'Rolled back turns' })).toBeInTheDocument()
    expect(screen.getByText('Rolled back (1) — gone from the conversation; redo to restore.')).toBeInTheDocument()
    expect(screen.getByText('Rolled back (1) — kept in history')).toBeInTheDocument()
    // The all-time union count (2 steps) is never presented as live state.
    expect(screen.queryByText(/Rolled back \(2\)/)).toBeNull()
    const redoButtons = screen.getAllByRole('button', { name: 'Redo to here' })
    expect(redoButtons).toHaveLength(1)
    fireEvent.click(redoButtons[0])
    expect(onRedoToTurn).toHaveBeenCalledWith('u3')
    expect(onRedoToTurn).toHaveBeenCalledTimes(1)
    // The frozen rows stay hidden behind the collapsed line until toggled…
    expect(screen.queryByText('second prompt')).toBeNull()
    expect(screen.queryByText('second answer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Toggle rolled-back history/ }))
    expect(screen.getByText('second prompt')).toBeInTheDocument()
    expect(screen.getByText('second answer')).toBeInTheDocument()
    // …and they never grow a redo button (still exactly one, on the current row).
    expect(screen.getAllByRole('button', { name: 'Redo to here' })).toHaveLength(1)
    expect(screen.getByText('second prompt').closest('div.flex.items-start')?.querySelector('button[aria-label="Redo to here"]')).toBeNull()
  })

  it('delta-r1 F6 legacy harmlessness: an absent redoableTurnIds (legacy server surface) exposes NO per-marker redo, even with canRedo', () => {
    render(
      <FreshAgentTranscript
        turns={[]}
        rolledBackTurns={markerTurns()}
        canRedo
        onRedoToTurn={vi.fn()}
      />,
    )

    // A legacy server also omits `restorable` ⇒ the whole bucket is historical
    // ⇒ the collapsed line is the only surface; expanding reveals the rows.
    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    const toggle = within(section).getByRole('button', { name: /Toggle rolled-back history/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()
    fireEvent.click(toggle)
    expect(within(section).getByText('second prompt')).toBeInTheDocument()
    expect(within(section).getByText('third answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()
  })

  it('exposes no Redo to here affordance when canRedo is false', () => {
    // The realistic server shape when a new submission destroys redo: the
    // markers are stamped restorable:false ⇒ born collapsed behind the line.
    render(
      <FreshAgentTranscript
        turns={[]}
        rolledBackTurns={markerTurns(false)}
        canRedo={false}
        redoableTurnIds={['u2', 'u3']}
        onRedoToTurn={vi.fn()}
      />,
    )

    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    const toggle = within(section).getByRole('button', { name: /Toggle rolled-back history/ })
    expect(toggle).toHaveTextContent('Rolled back (2) — kept in history')
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()
    fireEvent.click(toggle)
    expect(within(section).getByText('second prompt')).toBeInTheDocument()
    expect(within(section).getByText('third answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()
  })

  it('the disclosure toggle resets when the pane switches conversations (same component, new session)', () => {
    // Leak regression pin: PaneContainer keys the view by paneId only and
    // startNewConversation swaps the snapshot WITHOUT remounting the transcript,
    // so the toggle must re-collapse on a session id change by itself.
    const historyA: FreshAgentTurn[] = [
      { id: 'u2', turnId: 'u2', role: 'user', summary: 'conversation a marker', items: [{ id: 'u2-i1', kind: 'text', text: 'conversation a marker' }], rolledBack: true },
    ]
    const historyB: FreshAgentTurn[] = [
      { id: 'v2', turnId: 'v2', role: 'user', summary: 'conversation b marker', items: [{ id: 'v2-i1', kind: 'text', text: 'conversation b marker' }], rolledBack: true },
    ]
    const { rerender } = render(
      <FreshAgentTranscript sessionId="ses-a" turns={[]} rolledBackTurns={historyA} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Toggle rolled-back history/ }))
    expect(screen.getByText('conversation a marker')).toBeInTheDocument()

    // Same component instance, NEW conversation: collapsed again, no leak.
    rerender(<FreshAgentTranscript sessionId="ses-b" turns={[]} rolledBackTurns={historyB} />)
    const toggleB = screen.getByRole('button', { name: /Toggle rolled-back history/ })
    expect(toggleB).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('conversation a marker')).toBeNull()
    expect(screen.queryByText('conversation b marker')).toBeNull()

    // Toggling works per conversation, and within one conversation the
    // expansion survives a snapshot refresh (same session id, new markers).
    fireEvent.click(toggleB)
    expect(screen.getByText('conversation b marker')).toBeInTheDocument()
    rerender(
      <FreshAgentTranscript
        sessionId="ses-b"
        turns={[]}
        rolledBackTurns={[...historyB, { id: 'v3', turnId: 'v3', role: 'user', summary: 'conversation b second marker', items: [{ id: 'v3-i1', kind: 'text', text: 'conversation b second marker' }], rolledBack: true }]}
      />,
    )
    expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('conversation b second marker')).toBeInTheDocument()
  })
})

describe('FreshAgentTranscript task delegation + retry folding', () => {
  afterEach(() => cleanup())

  const delegationTurn = {
    id: 't_deleg',
    turnId: 't_deleg',
    role: 'assistant' as const,
    summary: '',
    items: [
      { id: 'r1', kind: 'reasoning' as const, summary: ['planning'], content: ['planning'], durationMs: 3400 },
      {
        id: 'task1',
        kind: 'task_delegation' as const,
        status: 'running' as const,
        title: 'General Task — Fix the flaky harness',
        description: 'Fix the flaky harness',
        childSessionId: 'ses_child_1',
        activity: [
          { tool: 'bash', status: 'completed' as const, preview: 'sed -n 92,112p src/store/paneTypes.ts' },
          { tool: 'grep', status: 'failed' as const, preview: 'reasoningEffort' },
        ],
      },
      { id: 'rr1', kind: 'retry' as const, attempt: 2, error: 'stream disconnected' },
    ],
  }

  describe('task delegation + retry folding', () => {
    it('folds a delegation turn into a single activity line with a live Task slot', () => {
      // Plan-review round 2, Finding 13: this turn must NOT include the retry item —
      // the retry-last reel precedence (its own test below) would otherwise name
      // "Retrying" instead of the running delegation on the live line.
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[{ ...delegationTurn, items: [delegationTurn.items[0], delegationTurn.items[1]] }]}
        />,
      )
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      // One collapsed line: the SlotReel names the running thing.
      expect(within(strip).getByText('Task')).toBeInTheDocument()
      expect(within(strip).getByText('General Task — Fix the flaky harness')).toBeInTheDocument()
      // Nothing renders as a standalone article between assistant messages while
      // the strip is collapsed (queryAllByTestId — getAllBy* throws on zero
      // matches and cannot assert absence).
      expect(screen.queryAllByTestId('fresh-agent-delegation-block')).toHaveLength(0)
    })

    it('expands to the delegation block and the retry row', () => {
      render(<FreshAgentTranscript turns={[delegationTurn]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      // The delegation block and retry row are STRIP members: they render inside
      // the expanded strip, never as standalone articles between messages.
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      expect(within(strip).getByTestId('fresh-agent-delegation-block')).toBeInTheDocument()
      expect(within(strip).getByText(/sed -n 92,112p src\/store\/paneTypes\.ts/)).toBeInTheDocument()
      expect(within(strip).getByText('(failed)')).toBeInTheDocument()
      expect(within(strip).getByTestId('fresh-agent-retry-row')).toHaveTextContent('Retrying (attempt 2) — stream disconnected')
    })

    it('shows a running delegation on the collapsed line even while the parent session is idle', () => {
      // Plan-review round 3, Finding 16: background delegations outlive the parent
      // turn — the strip's `live` flag (parent-session streaming) must not gate a
      // running delegation row. No streaming path is needed for this turn.
      render(
        <FreshAgentTranscript
          turns={[{ ...delegationTurn, items: [delegationTurn.items[1]] }]}
        />,
      )
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      expect(within(strip).getByText('Task')).toBeInTheDocument()
      expect(within(strip).getByText('General Task — Fix the flaky harness')).toBeInTheDocument()
      expect(within(strip).getByLabelText('running')).toBeInTheDocument() // the status-slot spinner
    })

    it('keeps a heading-only streaming reasoning row so the live strip still shows Thinking', () => {
      // Plan-review round 3, Finding 18: `**Planning**` arrives before its body;
      // the empty text must not drop the row or the strip falls back to an
      // unnamed spinner instead of the required Thinking behavior.
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[{
            id: 't_h', turnId: 't_h', role: 'assistant', summary: '',
            items: [{ id: 'r_h', kind: 'reasoning', summary: [], content: [], text: '', title: 'Planning' }],
          }]}
        />,
      )
      expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    })

    it('settled delegation turns summarize like other tool lines', () => {
      render(
        <FreshAgentTranscript
          turns={[{ ...delegationTurn, items: [{ ...delegationTurn.items[1], status: 'completed' as const }] }]}
        />,
      )
      // settledSummary counts the delegation as one used tool: "1 tool used".
      expect(screen.getByText(/1 tool used/)).toBeInTheDocument()
    })

    it('names Retrying on the live line when a retry is the last activity', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[{
            ...delegationTurn,
            items: [{ ...delegationTurn.items[1], status: 'completed' as const }, delegationTurn.items[2]],
          }]}
        />,
      )
      const strip = screen.getByRole('region', { name: 'Activity strip' })
      // The settled delegation must not mask the between-attempts retry marker (LB-4).
      expect(within(strip).getByText('Retrying')).toBeInTheDocument()
      expect(within(strip).getByText('attempt 2')).toBeInTheDocument()
      expect(within(strip).queryByText('Task')).not.toBeInTheDocument()
    })
  })

  describe('thought duration labels', () => {
    it('labels a settled reasoning row with its duration', () => {
      render(
        <FreshAgentTranscript
          turns={[{ id: 't1', turnId: 't1', role: 'assistant', summary: '', items: [delegationTurn.items[0]] }]}
        />,
      )
      expect(screen.getByRole('button', { name: 'Thought · 3.4s' })).toBeInTheDocument()
      expect(screen.getByText('Thought · 3.4s')).toBeInTheDocument()
    })

    it('keeps the Thinking label for rows without a duration', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 't1', turnId: 't1', role: 'assistant', summary: '',
            items: [{ id: 'r0', kind: 'reasoning', summary: ['x'], content: ['x'] }],
          }]}
        />,
      )
      expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    })
  })
})

describe('PTY notification display role (opencode-pty plugin turns)', () => {
  afterEach(() => cleanup())

  const PTY_BLOCK = '<pty_exited>\nID: pty_d75e6fa9\nExit Code: 0\nTimed Out: no\nOutput Lines: 5\nLast Line: SYNC_EXIT=0\n</pty_exited>\n\nUse pty_read to check the full output.'

  it('renders a <pty_exited> user-role turn as agent text, never You', () => {
    const { container } = render(
      <FreshAgentTranscript
        turns={[
          { id: 'u1', turnId: 'u1', role: 'user', summary: 'please run the gate', items: [{ id: 'u1-i', kind: 'text', text: 'please run the gate' }] },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }] },
          { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'gate done', items: [{ id: 'a1-i', kind: 'text', text: 'gate done' }] },
        ]}
      />,
    )

    // The real human prompt is still user text: exactly one user article.
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(container.querySelectorAll('article[data-turn-role="user"]')).toHaveLength(1)

    // The PTY notification renders as agent text: assistant article, no You
    // header inside it, and an Assistant header (preceded by a user turn).
    // exact:false because the block renders as markdown paragraphs whose text
    // is 'Last Line: SYNC_EXIT=0', not the bare token.
    const ptyArticle = screen.getByText('SYNC_EXIT=0', { exact: false }).closest('article')
    expect(ptyArticle).not.toBeNull()
    expect(ptyArticle?.getAttribute('data-turn-role')).toBe('assistant')
    expect(within(ptyArticle as HTMLElement).queryByText('You')).not.toBeInTheDocument()
    expect(within(ptyArticle as HTMLElement).getByText('Assistant')).toBeInTheDocument()
  })

  it('renders <pty_exited> turn text through the markdown path, not as literal user text', () => {
    const text = '<pty_exited>\n**sync finished**\n</pty_exited>'
    const { container } = render(
      <FreshAgentTranscript
        turns={[{ id: 'pty1', turnId: 'pty1', role: 'user', summary: text, items: [{ id: 'pty1-i', kind: 'text', text }] }]}
      />,
    )

    // markdown={!isUser}: the reclassified turn's **…** renders as <strong>.
    expect(container.querySelector('article[data-turn-role="assistant"] strong')).not.toBeNull()
  })

  it('folds a <pty_exited> turn as a continuation of a preceding assistant turn', () => {
    const { container } = render(
      <FreshAgentTranscript
        agentLabel="Freshopencode"
        turns={[
          { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'first answer', items: [{ id: 'a1-i', kind: 'text', text: 'first answer' }] },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }] },
        ]}
      />,
    )

    // One speaker header for the whole assistant run; no You anywhere; both
    // articles carry the assistant role.
    expect(screen.getAllByText('Freshopencode')).toHaveLength(1)
    expect(screen.queryByText('You')).not.toBeInTheDocument()
    expect(container.querySelectorAll('article[data-turn-role="assistant"]')).toHaveLength(2)
  })

  it('gives a <pty_exited> turn the same toolbar affordances as any assistant turn (no Rewind button)', () => {
    // Agent-text parity pin: the hover toolbar's 'Rewind code to here' button
    // renders only for user-role turns. After reclassification the PTY turn
    // gets the identical (absent) toolbar affordance as any assistant turn.
    // The context menu / touch action sheet keep their disabled Undo/Rewind
    // entries for the reclassified turn — unchanged by design, exactly as for
    // every other assistant turn; that surface is out of scope.
    const onRewind = vi.fn()
    render(
      <FreshAgentTranscript
        canFork={false}
        onRewindToTurn={onRewind}
        turns={[
          { id: 'u1', turnId: 'u1', role: 'user', summary: 'run the gate', items: [{ id: 'u1-i', kind: 'text', text: 'run the gate' }] },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }] },
          { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'done', items: [{ id: 'a1-i', kind: 'text', text: 'done' }] },
        ]}
      />,
    )

    const rewindButtons = screen.getAllByRole('button', { name: 'Rewind code to here' })
    expect(rewindButtons).toHaveLength(1)
    fireEvent.click(rewindButtons[0])
    expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', role: 'user' }))
  })

  it('counts a rolled-back <pty_exited> marker row as a user step (raw rule: the classifier never feeds the stepper)', () => {
    // Constraint guard, not new behavior: rolledBackTurns is a raw prop that
    // never passes through the displayTurns memo. A <pty_exited> marker row
    // MUST still count toward the step label pinned to the server's
    // rollback.undoneDepth (see the rolled-back section tests at :2891).
    render(
      <FreshAgentTranscript
        turns={[{ id: 'u1', turnId: 'u1', role: 'user', summary: 'live prompt', items: [{ id: 'u1-i', kind: 'text', text: 'live prompt' }] }]}
        rolledBackTurns={[
          { id: 'u2', turnId: 'u2', role: 'user', summary: 'second prompt', items: [{ id: 'u2-i', kind: 'text', text: 'second prompt' }], rolledBack: true, restorable: true },
          { id: 'a2', turnId: 'a2', role: 'assistant', summary: 'second answer', items: [{ id: 'a2-i', kind: 'text', text: 'second answer' }], rolledBack: true, restorable: true },
          { id: 'pty1', turnId: 'pty1', role: 'user', summary: PTY_BLOCK, items: [{ id: 'pty1-i', kind: 'text', text: PTY_BLOCK }], rolledBack: true, restorable: true },
        ]}
      />,
    )

    // Two USER-role marker rows (real prompt + PTY notification) => (2), not (1):
    // routing marker rows through the classifier would break the sum-to-undoneDepth pin.
    expect(screen.getByText('Rolled back (2) — gone from the conversation; redo to restore.')).toBeInTheDocument()
  })
})
