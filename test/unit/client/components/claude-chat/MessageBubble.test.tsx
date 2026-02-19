import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MessageBubble from '../../../../../src/components/claude-chat/MessageBubble'
import type { ChatContentBlock } from '@/store/claudeChatTypes'

describe('MessageBubble', () => {
  afterEach(() => {
    cleanup()
  })
  it('renders user text as left-aligned with orange left border', () => {
    const { container } = render(
      <MessageBubble role="user" content={[{ type: 'text', text: 'Hello world' }]} />
    )
    expect(screen.getByText('Hello world')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'user message' })).toBeInTheDocument()
    // User messages have thicker left border
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('border-l-[3px]')
  })

  it('renders assistant text with blue left border and markdown', () => {
    const { container } = render(
      <MessageBubble role="assistant" content={[{ type: 'text', text: '**Bold text**' }]} />
    )
    expect(screen.getByText('Bold text')).toBeInTheDocument()
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('border-l-2')
  })

  it('constrains content width with max-w-prose', () => {
    const { container } = render(
      <MessageBubble role="assistant" content={[{ type: 'text', text: 'Hello' }]} />
    )
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('max-w-prose')
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
    expect(screen.getByText('Bash:')).toBeInTheDocument()
  })

  it('renders timestamp and model', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'text', text: 'Hi' }]}
        timestamp="2026-02-13T10:00:00Z"
        model="claude-sonnet-4-5"
        showTimecodes={true}
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

describe('MessageBubble display toggles', () => {
  afterEach(cleanup)

  const textBlock: ChatContentBlock = { type: 'text', text: 'Hello world' }
  const thinkingBlock: ChatContentBlock = { type: 'thinking', thinking: 'Let me think about this...' }
  const toolUseBlock: ChatContentBlock = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
  const toolResultBlock: ChatContentBlock = { type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }

  it('hides thinking blocks when showThinking is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, thinkingBlock]}
        showThinking={false}
      />
    )
    expect(screen.queryByText(/Let me think/)).not.toBeInTheDocument()
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('shows thinking blocks when showThinking is true', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[thinkingBlock]}
        showThinking={true}
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
  })

  it('hides tool_use blocks when showTools is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, toolUseBlock]}
        showTools={false}
      />
    )
    expect(screen.queryByText('Bash:')).not.toBeInTheDocument()
  })

  it('hides tool_result blocks when showTools is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, toolResultBlock]}
        showTools={false}
      />
    )
    expect(screen.queryByText('Result:')).not.toBeInTheDocument()
  })

  it('shows timestamp when showTimecodes is true', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock]}
        timestamp="2026-02-13T10:00:00Z"
        showTimecodes={true}
      />
    )
    expect(screen.getByRole('article').querySelector('time')).toBeInTheDocument()
  })

  it('hides timestamp when showTimecodes is false', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock]}
        timestamp="2026-02-13T10:00:00Z"
        showTimecodes={false}
      />
    )
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })

  it('defaults to showing thinking and tools, hiding timecodes', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, thinkingBlock, toolUseBlock]}
        timestamp="2026-02-13T10:00:00Z"
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
    expect(screen.getByText('Bash:')).toBeInTheDocument()
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })
})

describe('MessageBubble system-reminder stripping', () => {
  afterEach(cleanup)

  it('strips system-reminder tags from standalone tool result content', async () => {
    const user = userEvent.setup()
    render(
      <MessageBubble
        role="assistant"
        content={[{
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'actual content\n<system-reminder>\nHidden system text\n</system-reminder>\nmore content',
        }]}
      />
    )
    // Expand the tool block to reveal content
    await user.click(screen.getByRole('button', { name: 'Result tool call' }))
    expect(screen.getByText(/actual content/)).toBeInTheDocument()
    expect(screen.queryByText(/Hidden system text/)).not.toBeInTheDocument()
  })

  it('strips system-reminder tags from paired tool_use/tool_result content', async () => {
    const user = userEvent.setup()
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'foo.ts' } },
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'file content\n<system-reminder>\nSecret metadata\n</system-reminder>\nmore',
          },
        ]}
      />
    )
    // Expand the tool block to reveal content
    await user.click(screen.getByRole('button', { name: 'Read tool call' }))
    expect(screen.getByText(/file content/)).toBeInTheDocument()
    expect(screen.queryByText(/Secret metadata/)).not.toBeInTheDocument()
  })
})
