import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CollapsedTurn from '../../../../../src/components/claude-chat/CollapsedTurn'
import type { ChatMessage } from '@/store/claudeChatTypes'

const userMsg: ChatMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'Fix the authentication bug in login flow' }],
  timestamp: '2026-02-13T10:00:00Z',
}

const assistantMsg: ChatMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'I will fix that.' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'auth.ts' } },
    { type: 'tool_result', tool_use_id: 't1', content: 'done' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_result', tool_use_id: 't2', content: 'all pass' },
    { type: 'text', text: 'Fixed!' },
  ],
  timestamp: '2026-02-13T10:01:00Z',
}

describe('CollapsedTurn', () => {
  afterEach(cleanup)

  it('renders a summary line with truncated user text and block counts', () => {
    render(<CollapsedTurn userMessage={userMsg} assistantMessage={assistantMsg} />)
    // User text truncated to ~40 chars
    expect(screen.getByText(/Fix the authentication/)).toBeInTheDocument()
    // Tool count
    expect(screen.getByText(/2 tools/)).toBeInTheDocument()
  })

  it('starts collapsed', () => {
    render(<CollapsedTurn userMessage={userMsg} assistantMessage={assistantMsg} />)
    expect(screen.getByRole('button', { name: /expand turn/i })).toBeInTheDocument()
  })

  it('expands to show full messages on click', async () => {
    const user = userEvent.setup()
    render(<CollapsedTurn userMessage={userMsg} assistantMessage={assistantMsg} />)
    await user.click(screen.getByRole('button', { name: /expand turn/i }))
    // After expanding, should show the actual message content
    expect(screen.getByText('I will fix that.')).toBeInTheDocument()
    expect(screen.getByText('Fixed!')).toBeInTheDocument()
  })
})
