import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MessageBubble from '../../../../../src/components/claude-chat/MessageBubble'

describe('MessageBubble', () => {
  afterEach(() => {
    cleanup()
  })
  it('renders user text message', () => {
    render(
      <MessageBubble
        role="user"
        content={[{ type: 'text', text: 'Hello world' }]}
      />
    )
    expect(screen.getByText('Hello world')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'user message' })).toBeInTheDocument()
  })

  it('renders assistant text message with markdown', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'text', text: '**Bold text**' }]}
      />
    )
    expect(screen.getByText('Bold text')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'assistant message' })).toBeInTheDocument()
  })

  it('renders thinking block as collapsible', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'thinking', thinking: 'Let me think...' }]}
      />
    )
    expect(screen.getByText(/Thinking/)).toBeInTheDocument()
  })

  it('renders tool use block', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }]}
      />
    )
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })

  it('renders timestamp and model', () => {
    const timestamp = new Date().toISOString()
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'text', text: 'Hi' }]}
        timestamp={timestamp}
        model="claude-sonnet-4-5"
      />
    )
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument()
  })

  describe('XSS sanitization', () => {
    const SCRIPT_PAYLOAD = '<script>alert("xss")</script>'
    const IMG_PAYLOAD = '<img src=x onerror=alert(1)>'

    it('escapes script tags in user text messages', () => {
      const { container } = render(
        <MessageBubble
          role="user"
          content={[{ type: 'text', text: SCRIPT_PAYLOAD }]}
        />
      )
      expect(screen.getByText(SCRIPT_PAYLOAD)).toBeInTheDocument()
      expect(container.querySelector('script')).toBeNull()
    })

    it('sanitizes HTML in assistant markdown messages', () => {
      const { container } = render(
        <MessageBubble
          role="assistant"
          content={[{ type: 'text', text: SCRIPT_PAYLOAD }]}
        />
      )
      // react-markdown strips script tags entirely
      expect(container.querySelector('script')).toBeNull()
    })

    it('sanitizes img onerror in assistant markdown messages', () => {
      const { container } = render(
        <MessageBubble
          role="assistant"
          content={[{ type: 'text', text: IMG_PAYLOAD }]}
        />
      )
      expect(container.querySelector('img[onerror]')).toBeNull()
    })

    it('escapes XSS in thinking blocks', () => {
      const { container } = render(
        <MessageBubble
          role="assistant"
          content={[{ type: 'thinking', thinking: SCRIPT_PAYLOAD }]}
        />
      )
      expect(container.querySelector('script')).toBeNull()
    })

    it('escapes XSS in tool result content', () => {
      const { container } = render(
        <MessageBubble
          role="assistant"
          content={[{ type: 'tool_result', tool_use_id: 't1', content: SCRIPT_PAYLOAD }]}
        />
      )
      expect(container.querySelector('script')).toBeNull()
    })
  })
})
