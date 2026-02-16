import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolBlock from '../../../../../src/components/claude-chat/ToolBlock'

describe('ToolBlock', () => {
  afterEach(() => {
    cleanup()
  })
  it('renders tool name and preview', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'ls -la' }}
        status="running"
      />
    )
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('$ ls -la')).toBeInTheDocument()
  })

  it('shows file path preview for Read tool', () => {
    render(
      <ToolBlock
        name="Read"
        input={{ file_path: '/home/user/file.ts' }}
        status="complete"
      />
    )
    expect(screen.getByText('/home/user/file.ts')).toBeInTheDocument()
  })

  it('expands to show details on click', async () => {
    const user = userEvent.setup()
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        status="complete"
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows error styling when isError is true', () => {
    render(
      <ToolBlock
        name="Result"
        output="Command failed"
        isError={true}
        status="complete"
      />
    )
    expect(screen.getByText('Result')).toBeInTheDocument()
  })

  describe('XSS sanitization', () => {
    const SCRIPT_PAYLOAD = '<script>alert("xss")</script>'

    it('escapes XSS in tool name', () => {
      const { container } = render(
        <ToolBlock
          name={SCRIPT_PAYLOAD}
          status="running"
        />
      )
      expect(screen.getByText(SCRIPT_PAYLOAD)).toBeInTheDocument()
      expect(container.querySelector('script')).toBeNull()
    })

    it('escapes XSS in tool output', async () => {
      const user = userEvent.setup()
      const { container } = render(
        <ToolBlock
          name="Bash"
          input={{ command: 'echo test' }}
          output={SCRIPT_PAYLOAD}
          status="complete"
        />
      )
      // Expand to show output
      await user.click(screen.getByRole('button', { name: 'Bash tool call' }))
      expect(screen.getByText(SCRIPT_PAYLOAD)).toBeInTheDocument()
      expect(container.querySelector('script')).toBeNull()
    })

    it('escapes XSS in command preview', () => {
      const { container } = render(
        <ToolBlock
          name="Bash"
          input={{ command: SCRIPT_PAYLOAD }}
          status="running"
        />
      )
      expect(container.querySelector('script')).toBeNull()
    })
  })
})
