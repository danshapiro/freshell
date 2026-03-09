import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolStrip from '@/components/agent-chat/ToolStrip'
import type { ToolPair } from '@/components/agent-chat/ToolStrip'

const STORAGE_KEY = 'freshell:toolStripExpanded'

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
    localStorage.removeItem(STORAGE_KEY)
  })
  afterEach(cleanup)

  it('renders collapsed by default showing the latest tool preview', () => {
    const pairs = [
      makePair('Bash', { command: 'echo hello' }, 'hello'),
      makePair('Read', { file_path: '/path/file.ts' }, 'content'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // Collapsed: shows "2 tools used"
    expect(screen.getByText('2 tools used')).toBeInTheDocument()
  })

  it('always shows chevron button', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByRole('button', { name: /toggle tool details/i })).toBeInTheDocument()
  })

  it('uses compact spacing in collapsed mode', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    const { container } = render(<ToolStrip pairs={pairs} isStreaming={false} />)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip.className).toContain('my-0.5')

    const collapsedRow = container.querySelector('[aria-label="Tool strip"] > div') as HTMLElement
    expect(collapsedRow.className).toContain('py-0.5')
  })

  it('expands on chevron click and persists to localStorage', async () => {
    const user = userEvent.setup()
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)

    // Expanded: should show individual ToolBlock
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
    // Persisted
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
  })

  it('starts expanded when localStorage has stored preference', () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // Should show individual ToolBlock
    expect(screen.getByRole('button', { name: /Bash tool call/i })).toBeInTheDocument()
  })

  it('collapses on second chevron click and removes localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const user = userEvent.setup()
    const pairs = [makePair('Bash', { command: 'ls' }, 'file1')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /toggle tool details/i })
    await user.click(toggle)

    // Should be collapsed again
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
  })

  it('shows streaming tool activity when isStreaming is true', () => {
    const pairs = [
      makePair('Bash', { command: 'echo hello' }, 'hello'),
      makePair('Read', { file_path: '/path/to/file.ts' }),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={true} />)
    // Should show the currently running tool's info
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('shows "N tools used" when all tools are complete and not streaming', () => {
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'output'),
      makePair('Read', { file_path: 'f.ts' }, 'content'),
      makePair('Grep', { pattern: 'foo' }, 'bar'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByText('3 tools used')).toBeInTheDocument()
  })

  it('renders with error indication when any tool has isError', () => {
    const pairs = [
      makePair('Bash', { command: 'false' }, 'error output', true),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    // The strip should still render; error styling is at the ToolBlock level in expanded view
    expect(screen.getByText('1 tool used')).toBeInTheDocument()
  })

  it('shows hasErrors indicator in collapsed mode when a tool errored', () => {
    const pairs = [
      makePair('Bash', { command: 'false' }, 'error output', true),
      makePair('Read', { file_path: 'f.ts' }, 'content'),
    ]
    const { container } = render(<ToolStrip pairs={pairs} isStreaming={false} />)
    const strip = screen.getByRole('region', { name: /tool strip/i })
    expect(strip).toBeInTheDocument()
    // Collapsed row should have the error border color instead of the normal tool color
    const collapsedRow = container.querySelector('.border-l-\\[hsl\\(var\\(--claude-error\\)\\)\\]')
    expect(collapsedRow).toBeInTheDocument()
  })

  it('renders accessible region with aria-label', () => {
    const pairs = [makePair('Bash', { command: 'ls' }, 'output')]
    render(<ToolStrip pairs={pairs} isStreaming={false} />)
    expect(screen.getByRole('region', { name: /tool strip/i })).toBeInTheDocument()
  })

  it('always shows collapsed view when showTools is false, even if localStorage says expanded', () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const pairs = [
      makePair('Bash', { command: 'ls' }, 'file1\nfile2'),
      makePair('Read', { file_path: '/path/file.ts' }, 'content'),
    ]
    render(<ToolStrip pairs={pairs} isStreaming={false} showTools={false} />)
    // Should show collapsed summary text
    expect(screen.getByText('2 tools used')).toBeInTheDocument()
    // Chevron toggle should NOT be rendered
    expect(screen.queryByRole('button', { name: /toggle tool details/i })).not.toBeInTheDocument()
    // Individual ToolBlocks should NOT be rendered
    expect(screen.queryByRole('button', { name: /Bash tool call/i })).not.toBeInTheDocument()
  })

  it('passes autoExpandAbove props through to ToolBlocks in expanded mode', async () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const pairs = [
      makePair('Bash', { command: 'echo 1' }, 'output1'),
      makePair('Bash', { command: 'echo 2' }, 'output2'),
      makePair('Bash', { command: 'echo 3' }, 'output3'),
    ]
    render(
      <ToolStrip pairs={pairs} isStreaming={false} autoExpandAbove={1} completedToolOffset={0} />
    )

    const toolButtons = screen.getAllByRole('button', { name: /Bash tool call/i })
    expect(toolButtons).toHaveLength(3)
    // Tool at index 0 (globalIndex=0) should be collapsed (below autoExpandAbove=1)
    expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'false')
    // Tools at indices 1,2 (globalIndex=1,2) should be expanded (>= autoExpandAbove=1)
    expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[2]).toHaveAttribute('aria-expanded', 'true')
  })
})
