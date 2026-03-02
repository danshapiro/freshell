import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatComposer from '../../../../../src/components/agent-chat/ChatComposer'

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

  describe('autoFocus on disabled transition', () => {
    let rafCallbacks: Array<FrameRequestCallback>
    beforeEach(() => {
      rafCallbacks = []
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      })
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    function flushRAF() {
      let safety = 10
      while (rafCallbacks.length > 0 && safety-- > 0) {
        const batch = rafCallbacks.splice(0)
        batch.forEach(cb => cb(performance.now()))
      }
    }

    it('auto-focuses textarea when disabled transitions from true to false with autoFocus=true', () => {
      const { rerender } = render(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={true} autoFocus={true} />
      )

      // Flush any rAF from mount while still disabled — simulates the real
      // scenario where the initial focus attempt fires on a disabled textarea
      flushRAF()

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      const focusSpy = vi.spyOn(textarea, 'focus')

      // Transition: disabled=true → disabled=false
      rerender(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={false} autoFocus={true} />
      )

      flushRAF()
      expect(focusSpy).toHaveBeenCalled()
    })

    it('does NOT auto-focus when autoFocus=false', () => {
      const { rerender } = render(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={true} autoFocus={false} />
      )

      flushRAF()

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      const focusSpy = vi.spyOn(textarea, 'focus')

      rerender(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={false} autoFocus={false} />
      )

      flushRAF()
      expect(focusSpy).not.toHaveBeenCalled()
    })

    it('auto-focus fires only once even if disabled toggles multiple times', () => {
      const { rerender } = render(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={true} autoFocus={true} />
      )

      flushRAF()

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      const focusSpy = vi.spyOn(textarea, 'focus')

      // First transition: disabled → enabled
      rerender(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={false} autoFocus={true} />
      )
      flushRAF()
      expect(focusSpy).toHaveBeenCalledTimes(1)

      focusSpy.mockClear()

      // Second transition: enabled → disabled → enabled
      rerender(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={true} autoFocus={true} />
      )
      rerender(
        <ChatComposer onSend={() => {}} onInterrupt={() => {}} disabled={false} autoFocus={true} />
      )
      flushRAF()
      expect(focusSpy).not.toHaveBeenCalled()
    })
  })
})
