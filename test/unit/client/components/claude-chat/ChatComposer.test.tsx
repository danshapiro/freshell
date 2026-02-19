import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatComposer from '../../../../../src/components/claude-chat/ChatComposer'

describe('ChatComposer', () => {
  afterEach(() => {
    cleanup()
  })
  it('renders textarea and send button', () => {
    render(<ChatComposer onSend={() => {}} onInterrupt={() => {}} />)
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
  })

  it('sends message on Enter', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer onSend={onSend} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')
    await user.type(textarea, 'Hello world{Enter}')
    expect(onSend).toHaveBeenCalledWith('Hello world')
  })

  it('does not send on Shift+Enter (allows newline)', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer onSend={onSend} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')
    await user.type(textarea, 'line 1{Shift>}{Enter}{/Shift}line 2')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables input when disabled', () => {
    render(<ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled />)
    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  it('shows stop button when running', () => {
    render(<ChatComposer onSend={() => {}} onInterrupt={() => {}} isRunning />)
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
  })

  it('calls onInterrupt when stop button is clicked', async () => {
    const onInterrupt = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer onSend={() => {}} onInterrupt={onInterrupt} isRunning />)
    await user.click(screen.getByRole('button', { name: 'Stop generation' }))
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('send button is disabled with empty text', () => {
    render(<ChatComposer onSend={() => {}} onInterrupt={() => {}} />)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('calls onInterrupt when Escape is pressed while running', async () => {
    const onInterrupt = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer onSend={() => {}} onInterrupt={onInterrupt} isRunning />)
    const textarea = screen.getByRole('textbox')
    await user.click(textarea)
    await user.keyboard('{Escape}')
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('does not call onInterrupt when Escape is pressed while not running', async () => {
    const onInterrupt = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer onSend={() => {}} onInterrupt={onInterrupt} />)
    const textarea = screen.getByRole('textbox')
    await user.click(textarea)
    await user.keyboard('{Escape}')
    expect(onInterrupt).not.toHaveBeenCalled()
  })
})
