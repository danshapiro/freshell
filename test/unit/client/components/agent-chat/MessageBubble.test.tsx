import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MessageBubble from '../../../../../src/components/agent-chat/MessageBubble'
import type { ChatContentBlock } from '@/store/agentChatTypes'

const STORAGE_KEY = 'freshell:toolStripExpanded'

// Render MarkdownRenderer synchronously to avoid React.lazy timing issues
// when running in the full test suite (dynamic import may not resolve in time)
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

describe('MessageBubble', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
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

  it('renders assistant text with blue left border and markdown', async () => {
    const { container } = render(
      <MessageBubble role="assistant" content={[{ type: 'text', text: '**Bold text**' }]} />
    )
    await vi.dynamicImportSettled()
    await waitFor(() => {
      const strong = container.querySelector('strong')
      expect(strong).toBeInTheDocument()
      expect(strong).toHaveTextContent('Bold text')
    }, { timeout: 5000 })
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

  it('uses compact vertical padding for denser FreshClaude messages', () => {
    const { container } = render(
      <MessageBubble role="assistant" content={[{ type: 'text', text: 'Hello' }]} />
    )
    const article = container.querySelector('[role="article"]')!
    expect(article.className).toContain('pl-2.5')
    expect(article.className).toContain('py-0.5')
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

  it('renders tool use block inside a tool strip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }]}
      />
    )
    // Tool is now inside a strip in collapsed mode
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })

  it('renders timestamp and model', async () => {
    render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'text', text: 'Hi' }]}
        timestamp="2026-02-13T10:00:00Z"
        model="claude-sonnet-4-5"
        showTimecodes={true}
      />
    )
    await screen.findByText('Hi')
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
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  const textBlock: ChatContentBlock = { type: 'text', text: 'Hello world' }
  const thinkingBlock: ChatContentBlock = { type: 'thinking', thinking: 'Let me think about this...' }
  const toolUseBlock: ChatContentBlock = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
  const toolResultBlock: ChatContentBlock = { type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }

  it('hides thinking blocks when showThinking is false', async () => {
    render(
      <MessageBubble
        role="assistant"
        content={[textBlock, thinkingBlock]}
        showThinking={false}
      />
    )
    expect(screen.queryByText(/Let me think/)).not.toBeInTheDocument()
    expect(await screen.findByText('Hello world')).toBeInTheDocument()
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

  it('shows collapsed tool strip when showTools is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[textBlock, toolUseBlock]}
        showTools={false}
      />
    )
    // Tool strip should still be visible (collapsed summary)
    expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
    // But no expand chevron should be available
    expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
  })

  it('shows collapsed tool strip for tool_result when showTools is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[textBlock, toolResultBlock]}
        showTools={false}
      />
    )
    // Tool strip should still be visible (collapsed summary)
    expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
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
    // Tool is now in a strip
    expect(screen.getByRole('region', { name: /tool strip/i })).toBeInTheDocument()
    expect(screen.getByRole('article').querySelector('time')).not.toBeInTheDocument()
  })
})

describe('MessageBubble empty message hiding', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  it('shows collapsed strip when all content is tools and showTools is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
        showTools={false}
      />
    )
    // Message should still render (collapsed strip is visible content)
    expect(container.querySelector('[role="article"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
  })

  it('hides entire message when all content is thinking and showThinking is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[{ type: 'thinking', thinking: 'Internal thoughts...' }]}
        showThinking={false}
      />
    )
    expect(container.querySelector('[role="article"]')).not.toBeInTheDocument()
  })

  it('shows collapsed strip when mixed tools+thinking and both toggles are off', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'thinking', thinking: 'thoughts' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        ]}
        showThinking={false}
        showTools={false}
      />
    )
    // Message should still render because the collapsed tool strip is visible
    expect(container.querySelector('[role="article"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
  })

  it('still shows message when it has text alongside hidden tools', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'text', text: 'Here is some text' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        ]}
        showTools={false}
      />
    )
    expect(screen.getByRole('article')).toBeInTheDocument()
    expect(screen.getByText('Here is some text')).toBeInTheDocument()
  })
})

describe('MessageBubble system-reminder stripping', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
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
    // First expand the strip, then click the individual tool
    await user.click(screen.getByRole('button', { name: /toggle tool details/i }))
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
    // First expand the strip, then click the individual tool
    await user.click(screen.getByRole('button', { name: /toggle tool details/i }))
    await user.click(screen.getByRole('button', { name: 'Read tool call' }))
    expect(screen.getByText(/file content/)).toBeInTheDocument()
    expect(screen.queryByText(/Secret metadata/)).not.toBeInTheDocument()
  })
})

describe('MessageBubble tool strip grouping', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  it('groups contiguous tool blocks into a single ToolStrip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'text', text: 'Here is some text' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } },
          { type: 'tool_result', tool_use_id: 't2', content: 'content' },
          { type: 'text', text: 'More text' },
        ]}
      />
    )
    // Should render a single ToolStrip (with "2 tools used"), not individual ToolBlocks
    expect(screen.getByText('2 tools used')).toBeInTheDocument()
    // Both text blocks should still be visible outside the strip
    expect(screen.getByText('Here is some text')).toBeInTheDocument()
    expect(screen.getByText('More text')).toBeInTheDocument()
  })

  it('creates separate strips for non-contiguous tool groups', async () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo 1' } },
          { type: 'tool_result', tool_use_id: 't1', content: '1' },
          { type: 'text', text: 'Middle text' },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo 2' } },
          { type: 'tool_result', tool_use_id: 't2', content: '2' },
        ]}
      />
    )
    // Two separate strips, each with 1 tool
    const strips = container.querySelectorAll('[aria-label="Tool strip"]')
    expect(strips).toHaveLength(2)
    expect(screen.getByText('Middle text')).toBeInTheDocument()
  })

  it('renders a single tool as a strip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
      />
    )
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })

  it('shows collapsed strips when showTools is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
        showTools={false}
      />
    )
    // Tool strip should be visible (collapsed summary)
    expect(container.querySelectorAll('[aria-label="Tool strip"]')).toHaveLength(1)
    // But no expand button
    expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('includes running tool_use without result in the strip', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo 1' } },
          { type: 'tool_result', tool_use_id: 't1', content: '1' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } },
        ]}
        isLastMessage={true}
      />
    )
    // The strip should contain 2 tools (one complete, one running)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip).toBeInTheDocument()
  })

  it('renders orphaned tool_result as standalone strip named "Result"', async () => {
    const user = userEvent.setup()
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_result', tool_use_id: 'orphan-1', content: 'orphaned data' },
        ]}
      />
    )
    // Should render as a ToolStrip
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip).toBeInTheDocument()
    // Expand the strip and then the "Result" tool block to verify content
    await user.click(screen.getByRole('button', { name: /toggle tool details/i }))
    const resultButton = screen.getByRole('button', { name: 'Result tool call' })
    expect(resultButton).toBeInTheDocument()
    await user.click(resultButton)
    expect(screen.getByText('orphaned data')).toBeInTheDocument()
  })

  it('handles thinking block between text and tools', () => {
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is the answer' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
      />
    )
    expect(screen.getByText(/Let me think/)).toBeInTheDocument()
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })
})

describe('MessageBubble tool strip visual behavior', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  it('renders collapsed strip with summary text when showTools is false', () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'text', text: 'Let me check that for you.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'file1.ts\nfile2.ts' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'file1.ts' } },
          { type: 'tool_result', tool_use_id: 't2', content: 'export const x = 1' },
          { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'TODO' } },
          { type: 'tool_result', tool_use_id: 't3', content: 'No matches found' },
          { type: 'text', text: 'All looks good!' },
        ]}
        showTools={false}
      />
    )

    // The message renders
    expect(screen.getByRole('article')).toBeInTheDocument()
    // Text blocks are visible
    expect(screen.getByText('Let me check that for you.')).toBeInTheDocument()
    expect(screen.getByText('All looks good!')).toBeInTheDocument()
    // Tool strip is visible with collapsed summary
    const strips = container.querySelectorAll('[aria-label="Tool strip"]')
    expect(strips).toHaveLength(1)
    expect(screen.getByText('3 tools used')).toBeInTheDocument()
    // No expand chevron
    expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
    // No individual tool blocks visible
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Read tool call/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Grep tool call/i })).not.toBeInTheDocument()
  })

  it('renders expandable strip with chevron when showTools is true', async () => {
    const user = userEvent.setup()
    render(
      <MessageBubble
        role="assistant"
        content={[
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
        ]}
        showTools={true}
      />
    )

    // Collapsed by default with chevron
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    const chevron = screen.getByRole('button', { name: /toggle tool details/i })
    expect(chevron).toBeInTheDocument()

    // Click to expand
    await user.click(chevron)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })
})
