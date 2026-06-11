import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FreshAgentComposer } from '@/components/fresh-agent/FreshAgentComposer'
import type { FreshAgentSlashCommand } from '@shared/fresh-agent-slash-commands'

const apiGet = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
  },
}))

const COMMANDS: readonly FreshAgentSlashCommand[] = [
  { name: 'new', description: 'Start a new conversation in this pane', action: 'new' },
  { name: 'compact', description: 'Compact the context', action: 'compact' },
  { name: 'fork', description: 'Fork this conversation', action: 'fork', requiresCapability: 'fork' },
]

function getInput(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
}

describe('FreshAgentComposer', () => {
  beforeEach(() => {
    apiGet.mockReset()
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(() => cleanup())

  it('opens the slash menu when typing / and runs the highlighted command', () => {
    const onCommand = vi.fn()
    render(<FreshAgentComposer commands={COMMANDS} onCommand={onCommand} />)

    fireEvent.change(getInput(), { target: { value: '/for' } })
    const menu = screen.getByRole('menu', { name: 'Slash commands' })
    expect(menu).toHaveTextContent('/fork')
    expect(menu).not.toHaveTextContent('/new')

    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fork' }),
      '',
    )
  })

  it('passes arguments through slash command text', () => {
    const onCommand = vi.fn()
    render(<FreshAgentComposer commands={COMMANDS} onCommand={onCommand} />)

    fireEvent.change(getInput(), { target: { value: '/compact focus on ws-handler' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'compact' }),
      'focus on ws-handler',
    )
  })

  it('completes @ mentions against the files API anchored at the session cwd', async () => {
    apiGet.mockResolvedValue({
      suggestions: [
        { path: '/home/dan/code/freshell/server', isDirectory: true },
        { path: '/home/dan/code/freshell/shared/settings.ts', isDirectory: false },
      ],
    })
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={COMMANDS} onSend={onSend} cwd="/home/dan/code/freshell" />)

    fireEvent.change(getInput(), { target: { value: 'look at @s' } })

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        `/api/files/complete?prefix=${encodeURIComponent('/home/dan/code/freshell/s')}`,
      )
    })
    const menu = await screen.findByRole('menu', { name: 'File suggestions' })
    expect(menu).toHaveTextContent('server')
    expect(menu).toHaveTextContent('shared/settings.ts')

    fireEvent.click(screen.getByRole('menuitem', { name: /shared\/settings\.ts/ }))
    expect(getInput().value).toBe('look at shared/settings.ts ')
  })

  it('descends into directories on selection and keeps completing', async () => {
    apiGet.mockResolvedValue({
      suggestions: [{ path: '/home/dan/code/freshell/server', isDirectory: true }],
    })
    render(<FreshAgentComposer commands={COMMANDS} cwd="/home/dan/code/freshell" />)

    fireEvent.change(getInput(), { target: { value: '@se' } })
    const item = await screen.findByRole('menuitem', { name: /server/ })
    fireEvent.click(item)

    expect(getInput().value).toBe('@server/')
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(
        `/api/files/complete?prefix=${encodeURIComponent('/home/dan/code/freshell/server/')}`,
      )
    })
  })

  it('recalls prompt history with arrow keys from an empty input', () => {
    const onSend = vi.fn()
    render(
      <FreshAgentComposer
        commands={COMMANDS}
        onSend={onSend}
        historyKey="fresh-agent-prompt-history:test"
      />,
    )

    fireEvent.change(getInput(), { target: { value: 'first prompt' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    fireEvent.change(getInput(), { target: { value: 'second prompt' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(2)
    expect(getInput().value).toBe('')

    fireEvent.keyDown(getInput(), { key: 'ArrowUp' })
    expect(getInput().value).toBe('second prompt')
    fireEvent.keyDown(getInput(), { key: 'ArrowUp' })
    expect(getInput().value).toBe('first prompt')
    fireEvent.keyDown(getInput(), { key: 'ArrowDown' })
    expect(getInput().value).toBe('second prompt')
    fireEvent.keyDown(getInput(), { key: 'ArrowDown' })
    expect(getInput().value).toBe('')
  })

  it('persists prompt history per history key', () => {
    const key = 'fresh-agent-prompt-history:persist-test'
    const first = render(
      <FreshAgentComposer commands={COMMANDS} onSend={vi.fn()} historyKey={key} />,
    )
    fireEvent.change(getInput(), { target: { value: 'remembered prompt' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    first.unmount()

    render(<FreshAgentComposer commands={COMMANDS} onSend={vi.fn()} historyKey={key} />)
    fireEvent.keyDown(getInput(), { key: 'ArrowUp' })
    expect(getInput().value).toBe('remembered prompt')
  })

  it('does not hijack ArrowUp while drafting text', () => {
    render(
      <FreshAgentComposer
        commands={COMMANDS}
        onSend={vi.fn()}
        historyKey="fresh-agent-prompt-history:drafting"
      />,
    )
    fireEvent.change(getInput(), { target: { value: 'sent already' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })

    fireEvent.change(getInput(), { target: { value: 'a draft in progress' } })
    fireEvent.keyDown(getInput(), { key: 'ArrowUp' })
    expect(getInput().value).toBe('a draft in progress')
  })

  describe('state-aware disabled behavior', () => {
    it('shows the provided placeholder instead of the generic read-only text', () => {
      render(
        <FreshAgentComposer
          commands={COMMANDS}
          disabled
          placeholder="Starting session…"
        />,
      )
      expect(getInput()).toHaveAttribute('placeholder', 'Starting session…')
    })

    it('falls back to Read-only session when disabled without a placeholder', () => {
      render(<FreshAgentComposer commands={COMMANDS} disabled />)
      expect(getInput()).toHaveAttribute('placeholder', 'Read-only session')
    })

    it('keeps /new reachable from the command menu while disabled', () => {
      const onCommand = vi.fn()
      render(<FreshAgentComposer commands={COMMANDS} disabled onCommand={onCommand} />)

      const browse = screen.getByRole('button', { name: 'Slash commands' })
      expect(browse).toBeEnabled()
      fireEvent.click(browse)
      fireEvent.click(screen.getByRole('menuitem', { name: /\/new/ }))
      expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'new' }), '')

      // Other commands stay blocked while disabled.
      fireEvent.click(browse)
      fireEvent.click(screen.getByRole('menuitem', { name: /\/compact/ }))
      expect(onCommand).toHaveBeenCalledTimes(1)
    })
  })
})
