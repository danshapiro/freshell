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
})
