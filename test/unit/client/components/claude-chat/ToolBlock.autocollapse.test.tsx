import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolBlock from '../../../../../src/components/claude-chat/ToolBlock'

describe('ToolBlock auto-collapse', () => {
  afterEach(cleanup)

  it('starts collapsed by default (no initialExpanded)', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        output="hello"
        status="complete"
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('starts expanded when initialExpanded is true', () => {
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        output="hello"
        status="complete"
        initialExpanded={true}
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('can be collapsed after starting expanded', async () => {
    const user = userEvent.setup()
    render(
      <ToolBlock
        name="Bash"
        input={{ command: 'echo hello' }}
        output="hello"
        status="complete"
        initialExpanded={true}
      />
    )
    const button = screen.getByRole('button', { name: 'Bash tool call' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})
