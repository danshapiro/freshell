import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatComposer from '@/components/agent-chat/ChatComposer'
import { clearHistory } from '@/lib/input-history-store'
import { clearDraft } from '@/lib/draft-store'

const mockDispatch = vi.fn()
vi.mock('@/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: () => ({}),
}))

vi.mock('@/store/tabsSlice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/tabsSlice')>()
  return {
    ...actual,
    switchToNextTab: () => ({ type: 'tabs/switchToNextTab' }),
    switchToPrevTab: () => ({ type: 'tabs/switchToPrevTab' }),
  }
})

describe('agent chat input history flow', () => {
  afterEach(() => {
    cleanup()
    clearHistory('flow-pane')
    clearDraft('flow-pane')
    mockDispatch.mockClear()
  })

  it('end-to-end: send messages, navigate history, verify values', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={onSend} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox', { name: 'Chat message input' })

    await user.type(textarea, 'message alpha{Enter}')
    expect(onSend).toHaveBeenCalledWith('message alpha')
    expect(textarea).toHaveValue('')

    await user.type(textarea, 'message beta{Enter}')
    expect(onSend).toHaveBeenCalledWith('message beta')
    expect(textarea).toHaveValue('')

    await user.click(textarea)
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('message beta')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('message alpha')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('message beta')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('')
  })

  it('preserves draft through navigation cycle', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'existing entry{Enter}')
    await user.type(textarea, 'work in progress')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('existing entry')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('work in progress')
  })

  it('history survives component unmount and remount', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />
    )
    await user.type(screen.getByRole('textbox'), 'persistent message{Enter}')
    unmount()

    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('persistent message')
  })

  it('deduplicates consecutive identical sends', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'same{Enter}')
    await user.type(textarea, 'same{Enter}')
    await user.click(textarea)

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('same')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('')
  })

  it('editing a history entry then navigating away discards the edit', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'original{Enter}')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('original')

    await user.type(textarea, '-modified')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('original')
  })
})
