import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

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

  it('renders blank space instead of placeholder text for an empty transcript', () => {
    const { container } = render(<FreshAgentTranscript turns={[]} />)

    expect(screen.queryByText(/No transcript available yet/i)).not.toBeInTheDocument()
    expect(container.querySelector('[data-context="fresh-agent-transcript"]')).toBeInTheDocument()
  })

  it('coalesces paired tool calls into a rolling strip and expands details', () => {
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

    expect(screen.getByRole('region', { name: 'Tool strip' })).toHaveTextContent('1 tool used')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle tool details' }))
    expect(screen.getByRole('button', { name: 'Bash tool call' })).toHaveTextContent('Bash:')
    fireEvent.click(screen.getByRole('button', { name: 'Bash tool call' }))
    expect(screen.getByText('find . -name "*.md"')).toBeInTheDocument()
    expect(screen.getByText(/README.md/)).toBeInTheDocument()
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

  it('renders reasoning and thinking in disclosures and shows edit diffs', () => {
    render(
      <FreshAgentTranscript
        turns={[
          {
            id: 'turn-1',
            role: 'assistant',
            summary: 'thinking and editing',
            items: [
              { id: 'thinking-1', kind: 'thinking', text: 'private chain' },
              { id: 'reason-1', kind: 'reasoning', summary: ['summary'], content: ['detail'] },
              {
                id: 'edit-1',
                kind: 'tool_use',
                toolUseId: 'edit-call',
                name: 'Edit',
                input: { file_path: 'README.md', old_string: 'old', new_string: 'new' },
              },
              { id: 'edit-result', kind: 'tool_result', toolUseId: 'edit-call', content: 'ok', isError: false },
            ],
          },
        ]}
      />,
    )

    expect(screen.getByText('Thinking')).toBeInTheDocument()
    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle tool details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit tool call' }))
    expect(screen.getByRole('figure', { name: 'diff view' })).toHaveAttribute('data-file-path', 'README.md')
  })
})
