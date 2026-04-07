import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolStrip from '@/components/agent-chat/ToolStrip'
import type { ToolPair } from '@/components/agent-chat/ToolStrip'

function makePair(
  name: string,
  input: Record<string, unknown>,
  output?: string,
  isError?: boolean,
): ToolPair {
  return {
    id: `tool-${name}-${Math.random().toString(36).slice(2)}`,
    name,
    input,
    output,
    isError,
    status: output != null ? 'complete' : 'running',
  }
}

describe('ToolStrip', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(cleanup)

  it('starts expanded when showTools is true', () => {
    const pairs = [
      makePair('Bash', { command: 'echo hello' }, 'hello'),
      makePair('Read', { file_path: '/path/file.ts' }, 'content'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Read tool call/i })).toBeInTheDocument()
  })

  it('always shows chevron button when showTools is true', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('button', { name: /toggle tool details/i })).toBeInTheDocument()
  })

  it('uses compact spacing in expanded mode', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    const { container } = render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip.className).toContain('my-0.5')
  })

  it('starts collapsed when showTools is false, chevron still works', async () => {
    const user = userEvent.setup()
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={false} />)
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /toggle tool details/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })

  it('strip toggle is session-only (not persisted to localStorage)', async () => {
    const user = userEvent.setup()
    const pairs = [makePair('Bash', { command: 'ls' }, 'file1\nfile2')]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)

    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    expect(localStorage.getItem('freshell:browser-preferences')).toBeNull()
  })

  it('collapses on second chevron click', async () => {
    const user = userEvent.setup()
    const pairs = [makePair('Bash', { command: 'ls' }, 'file1')]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)

    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })

  it('ToolBlocks start expanded when showTools is true', () => {
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'output'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)

    const toolButton = screen.getByRole('button', { name: /Bash tool call/i })
    expect(toolButton).toBeInTheDocument()
    expect(toolButton).toHaveAttribute('aria-expanded', 'true')
  })

  it('ToolBlocks are not visible when showTools is false', () => {
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'output'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={false} />)

    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()
  })

  it('individual ToolBlock toggles work independently', async () => {
    const user = userEvent.setup()
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'output1'),
      makePair('Read', { file_path: 'f.ts' }, 'output2'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)

    const toolButtons = screen.getAllByRole('button', { name: /tool call/i })
    expect(toolButtons).toHaveLength(2)
    expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'true')

    await user.click(toolButtons[0])
    expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows streaming tool activity when isStreaming is true', () => {
    const pairs = [
      makePair('Bash', { command: 'echo hello' }, 'hello'),
      makePair('Read', { file_path: '/path/to/file.ts' }),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={true} showTools={true} />)
    expect(screen.getByRole('button', { name: /Read tool call/i })).toBeInTheDocument()
  })

  it('shows all tools when complete', () => {
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'output'),
      makePair('Read', { file_path: 'f.ts' }, 'content'),
      makePair('Grep', { pattern: 'foo' }, 'bar'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Read tool call/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Grep tool call/i })).toBeInTheDocument()
  })

  it('renders with error indication when any tool has isError', () => {
    const pairs = [
      makePair('Bash', { command: 'false' }, 'error output', true),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })

  it('shows hasErrors indicator in collapsed mode when a tool errored', () => {
    const pairs = [
      makePair('Bash', { command: 'false' }, 'error output', true),
      makePair('Read', { file_path: 'f.ts' }, 'content'),
    ]
    const { container } = render(<ToolStrip pairs={pairs} isStreaming={false} showTools={false} />)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip).toBeInTheDocument()
    const collapsedRow = container.querySelector('.border-l-\\[hsl\\(var\\(--claude-error\\)\\)\\]')
    expect(collapsedRow).toBeInTheDocument()
  })

  it('renders accessible region with aria-label', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('region', { name: /tool strip/i })).toBeInTheDocument()
  })

  it('shows collapsed view by default when showTools is false, chevron still works', async () => {
    const user = userEvent.setup()
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
      makePair('Read', { file_path: '/path/file.ts' }, 'content'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={false} />)
    expect(screen.getByText('2 tools used')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /toggle tool details/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })

  it('resets to showTools default when component remounts', async () => {
    const user = userEvent.setup()
    const pairs = [makePair('Bash', { command: 'ls' }, 'file1')]

    const { unmount } = render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    unmount()

    cleanup()

    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={true} />)
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })

  it('defaults to showTools=false when not specified', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()
  })
})
