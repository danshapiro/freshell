import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MessageBubble } from '../../../../../src/components/session/MessageBubble'
import type { NormalizedEvent } from '../../../../../src/lib/coding-cli-types'

afterEach(() => cleanup())

describe('MessageBubble', () => {
  it('renders text content', () => {
    const event: NormalizedEvent = {
      type: 'message.assistant',
      timestamp: new Date().toISOString(),
      sessionId: 'provider-session',
      provider: 'claude',
      raw: {},
      message: {
        role: 'assistant',
        content: 'Hello, world!',
      },
    }

    render(<MessageBubble event={event} />)
    expect(screen.getByText('Hello, world!')).toBeInTheDocument()
  })

  it('renders multiple paragraphs as single block', () => {
    const event: NormalizedEvent = {
      type: 'message.assistant',
      timestamp: new Date().toISOString(),
      sessionId: 'provider-session',
      provider: 'claude',
      raw: {},
      message: {
        role: 'assistant',
        content: 'First paragraph\nSecond paragraph',
      },
    }

    render(<MessageBubble event={event} />)
    expect(screen.getByText(/First paragraph/)).toBeInTheDocument()
    expect(screen.getByText(/Second paragraph/)).toBeInTheDocument()
  })

  it('applies assistant styling for assistant messages', () => {
    const event: NormalizedEvent = {
      type: 'message.assistant',
      timestamp: new Date().toISOString(),
      sessionId: 'provider-session',
      provider: 'claude',
      raw: {},
      message: { role: 'assistant', content: 'Hi' },
    }

    const { container } = render(<MessageBubble event={event} />)
    expect(container.firstChild).toHaveClass('bg-muted')
  })

  it('applies user styling for user messages', () => {
    const event: NormalizedEvent = {
      type: 'message.user',
      timestamp: new Date().toISOString(),
      sessionId: 'provider-session',
      provider: 'claude',
      raw: {},
      message: { role: 'user', content: 'Hi' },
    }

    const { container } = render(<MessageBubble event={event} />)
    expect(container.firstChild).toHaveClass('bg-primary')
  })
})
