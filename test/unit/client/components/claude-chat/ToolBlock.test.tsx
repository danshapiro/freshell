import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolBlock from '../../../../../src/components/claude-chat/ToolBlock'

describe('ToolBlock', () => {
  afterEach(cleanup)

  it('renders tool name and preview', () => {
    render(<ToolBlock name="Bash" input={{ command: 'ls -la' }} status="running" />)
    expect(screen.getByText('Bash:')).toBeInTheDocument()
    expect(screen.getByText('$ ls -la')).toBeInTheDocument()
  })

  it('shows file path preview for Read tool', () => {
    render(<ToolBlock name="Read" input={{ file_path: '/home/user/file.ts' }} status="complete" />)
    expect(screen.getByText('/home/user/file.ts')).toBeInTheDocument()
  })

  it('expands to show details on click', async () => {
    const user = userEvent.setup()
    render(<ToolBlock name="Bash" input={{ command: 'echo hello' }} status="complete" />)
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows error styling when isError is true', () => {
    render(<ToolBlock name="Result" output="Command failed" isError={true} status="complete" />)
    expect(screen.getByText('Result:')).toBeInTheDocument()
  })

  // --- New: smart header tests ---

  it('shows Bash description field when available', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'npm install --save-dev vitest', description: 'Install test runner' }}
        status="running"
      />
    )
    expect(screen.getByText('Install test runner')).toBeInTheDocument()
  })

  it('shows Grep pattern in preview', () => {
    render(
      <ToolBlock
        name="Grep"
        input={{ pattern: 'useState', path: 'src/' }}
        status="running"
      />
    )
    expect(screen.getByText(/useState/)).toBeInTheDocument()
  })

  it('shows Edit file path with old/new string indicator', () => {
    render(
      <ToolBlock
        name="Edit"
        input={{ file_path: 'src/App.tsx', old_string: 'foo', new_string: 'bar' }}
        status="running"
      />
    )
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
  })

  it('appends result summary for completed Read tool', () => {
    const output = Array(50).fill('line of code').join('\n')
    render(
      <ToolBlock name="Read" input={{ file_path: 'src/App.tsx' }} output={output} status="complete" />
    )
    // Should show line count summary
    expect(screen.getByText(/50 lines/)).toBeInTheDocument()
  })

  it('appends result summary for completed Bash tool with exit code', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'false' }}
        output="error output"
        isError={true}
        status="complete"
      />
    )
    expect(screen.getByText(/error/i)).toBeInTheDocument()
  })

  it('appends result summary for completed Grep tool', () => {
    const output = 'file1.ts\nfile2.ts\nfile3.ts'
    render(
      <ToolBlock
        name="Grep"
        input={{ pattern: 'foo' }}
        output={output}
        status="complete"
      />
    )
    expect(screen.getByText(/3 match/)).toBeInTheDocument()
  })

  it('uses tool-colored left border', () => {
    const { container } = render(
      <ToolBlock name="Bash" input={{ command: 'ls' }} status="running" />
    )
    const wrapper = container.firstElementChild!
    expect(wrapper.className).toContain('border-l')
  })

  // --- data-* attribute tests for context menu ---

  describe('data attributes for context menu', () => {
    it('tags tool input with data-tool-input and data-tool-name', () => {
      render(<ToolBlock name="Bash" input={{ command: 'ls' }} status="complete" output="files" initialExpanded />)
      const inputEl = document.querySelector('[data-tool-input]')
      expect(inputEl).not.toBeNull()
      expect(inputEl?.getAttribute('data-tool-name')).toBe('Bash')
    })

    it('tags tool output with data-tool-output', () => {
      render(<ToolBlock name="Bash" input={{ command: 'ls' }} status="complete" output="file1\nfile2" initialExpanded />)
      const outputEl = document.querySelector('[data-tool-output]')
      expect(outputEl).not.toBeNull()
    })
  })
})
