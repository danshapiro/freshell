import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatComposer from '../../../../../src/components/agent-chat/ChatComposer'
import { getDraft, clearDraft } from '@/lib/draft-store'

describe('ChatComposer', () => {
  afterEach(() => {
    cleanup()
    clearDraft('test-pane')
    clearDraft('pane-a')
    clearDraft('pane-b')
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

  describe('draft preservation', () => {
    it('starts empty when no saved draft exists', () => {
      render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
      expect(screen.getByRole('textbox')).toHaveValue('')
    })

    it('restores draft text after unmount and remount', async () => {
      const user = userEvent.setup()
      const { unmount } = render(
        <ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />
      )
      await user.type(screen.getByRole('textbox'), 'work in progress')
      unmount()

      // Remount with the same paneId
      render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
      expect(screen.getByRole('textbox')).toHaveValue('work in progress')
    })

    it('clears draft after sending a message', async () => {
      const user = userEvent.setup()
      render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
      await user.type(screen.getByRole('textbox'), 'sent message{Enter}')
      expect(getDraft('test-pane')).toBe('')
    })

    it('keeps independent drafts per paneId', async () => {
      const user = userEvent.setup()
      const { unmount: unmountA } = render(
        <ChatComposer paneId="pane-a" onSend={() => {}} onInterrupt={() => {}} />
      )
      await user.type(screen.getByRole('textbox'), 'draft A')
      unmountA()

      const { unmount: unmountB } = render(
        <ChatComposer paneId="pane-b" onSend={() => {}} onInterrupt={() => {}} />
      )
      await user.type(screen.getByRole('textbox'), 'draft B')
      unmountB()

      // Remount A — should have its own draft
      render(<ChatComposer paneId="pane-a" onSend={() => {}} onInterrupt={() => {}} />)
      expect(screen.getByRole('textbox')).toHaveValue('draft A')
    })

    it('works without paneId (no persistence, backwards compatible)', async () => {
      const user = userEvent.setup()
      const { unmount } = render(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} />
      )
      await user.type(screen.getByRole('textbox'), 'no pane id')
      unmount()

      // Remount without paneId — starts empty (no crash)
      render(<ChatComposer onSend={() => {}} onInterrupt={() => {}} />)
      expect(screen.getByRole('textbox')).toHaveValue('')
    })
  })
})
