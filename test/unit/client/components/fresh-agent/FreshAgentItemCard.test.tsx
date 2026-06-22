import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentItemCard, FreshAgentToolBlock, stripSystemReminders } from '@/components/fresh-agent/FreshAgentItemCard'

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

describe('FreshAgentItemCard', () => {
  afterEach(() => cleanup())

  it('renders markdown text while preserving XSS defenses through the markdown renderer', () => {
    const { container } = render(
      <FreshAgentItemCard
        markdown
        item={{
          id: 'text-1',
          kind: 'text',
          text: '## Result\n\n<script>alert("XSS")</script>\n\n`safe`',
        }}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Result' })).toBeInTheDocument()
    expect(screen.getByText('safe').tagName).toBe('CODE')
    expect(container.querySelector('script')).toBeNull()
  })

  it('strips system reminders before rendering user-visible text', () => {
    expect(stripSystemReminders('Hello\n<system-reminder>secret</system-reminder>\nworld')).toBe('Hello\n\nworld')
  })

  it('renders Bash tool input/output with copy-target data attributes', () => {
    const { container } = render(
      <FreshAgentToolBlock
        initialExpanded
        tool={{
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'npm test' },
          output: 'PASS fresh-agent',
          status: 'complete',
        }}
      />,
    )

    expect(container.querySelector('[data-tool-input]')).toHaveTextContent('npm test')
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent('PASS fresh-agent')
  })

  it('can collapse and expand tool details without losing the preview', () => {
    const { container } = render(
      <FreshAgentToolBlock
        initialExpanded
        tool={{
          id: 'tool-2',
          name: 'Bash',
          input: { command: 'echo collapse' },
          output: 'done',
          status: 'complete',
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Bash tool call' })
    expect(container.querySelector('[data-tool-output]')).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(container.querySelector('[data-tool-output]')).not.toBeInTheDocument()
    expect(screen.getByText(/echo collapse/)).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(container.querySelector('[data-tool-output]')).toBeInTheDocument()
  })

  describe('tool notification polish (5kxd)', () => {
    it('drops the vertical line from the tool block while keeping trigger padding', () => {
      const { container } = render(
        <FreshAgentToolBlock
          tool={{
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'true' },
            status: 'complete',
          }}
        />,
      )
      const toolBlock = container.querySelector('.fresh-agent-tool-block') as HTMLElement
      expect(toolBlock).toBeTruthy()
      expect(toolBlock.className).not.toContain('border-l-2')
      expect(toolBlock.className).not.toContain('border-l-[')
      const trigger = screen.getByRole('button', { name: 'Bash tool call' })
      expect(trigger.className).toContain('px-2')
    })

    it('preserves error state on the tool block without the vertical line', () => {
      const { container } = render(
        <FreshAgentToolBlock
          tool={{
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'false' },
            output: 'boom',
            isError: true,
            status: 'complete',
          }}
        />,
      )
      const toolBlock = container.querySelector('.fresh-agent-tool-block') as HTMLElement
      expect(toolBlock).toBeTruthy()
      expect(toolBlock.className).not.toContain('border-l-')
      expect(screen.getByLabelText('error')).toBeInTheDocument()
      const summary = screen.getByText('(error)')
      expect(summary.className).toContain('text-destructive')
    })

    it('drops the vertical line from the thinking disclosure', () => {
      const { container } = render(
        <FreshAgentItemCard
          item={{ id: 'think-1', kind: 'thinking', text: 'a thought' }}
        />,
      )
      const disclosure = container.querySelector('.fresh-agent-thinking-details') as HTMLElement
      expect(disclosure).toBeTruthy()
      expect(disclosure.className).not.toContain('border-l-2')
      expect(disclosure.className).not.toContain('border-l-[')
    })

    it('drops the vertical line from the tool result card', () => {
      const { container } = render(
        <FreshAgentItemCard
          item={{ id: 'result-1', kind: 'tool_result', content: 'ok', isError: false }}
        />,
      )
      const card = container.querySelector('.fresh-agent-tool-result') as HTMLElement
      expect(card).toBeTruthy()
      expect(card.className).not.toContain('border-l-2')
      expect(card.className).not.toContain('border-l-')
      expect(card.className).toContain('px-2')
    })
  })
})
