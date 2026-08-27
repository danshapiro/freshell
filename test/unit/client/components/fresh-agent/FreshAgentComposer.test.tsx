import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FreshAgentComposer } from '@/components/fresh-agent/FreshAgentComposer'
import type { FreshAgentSessionMenuRow, FreshAgentSlashCommand } from '@shared/fresh-agent-slash-commands'

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
// The composer prop is the grouped menu: statics under `action`,
// provider-advertised rows under `session`.
const GROUPED_COMMANDS = { action: COMMANDS, session: [] }

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

  it('hides attachment controls and blocks shell escapes without sending', () => {
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onSend={onSend} />)
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull()
    fireEvent.change(getInput(), { target: { value: '!pwd' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('Shell commands are unavailable here; open a shell pane instead')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('opens the slash menu when typing / and runs the highlighted command', () => {
    const onCommand = vi.fn()
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onCommand={onCommand} />)

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
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onCommand={onCommand} />)

    fireEvent.change(getInput(), { target: { value: '/compact focus on ws-handler' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'compact' }),
      'focus on ws-handler',
    )
  })

  it('completes the highlighted slash command with Tab without sending it', () => {
    const onCommand = vi.fn()
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onCommand={onCommand} />)

    fireEvent.change(getInput(), { target: { value: '/for' } })
    fireEvent.keyDown(getInput(), { key: 'Tab' })

    expect(getInput().value).toBe('/fork ')
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('completes @ mentions against the files API anchored at the session cwd', async () => {
    apiGet.mockResolvedValue({
      suggestions: [
        { path: '/home/dan/code/freshell/server', isDirectory: true },
        { path: '/home/dan/code/freshell/shared/settings.ts', isDirectory: false },
      ],
    })
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onSend={onSend} cwd="/home/dan/code/freshell" />)

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
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} cwd="/home/dan/code/freshell" />)

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
        commands={GROUPED_COMMANDS}
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
      <FreshAgentComposer commands={GROUPED_COMMANDS} onSend={vi.fn()} historyKey={key} />,
    )
    fireEvent.change(getInput(), { target: { value: 'remembered prompt' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    first.unmount()

    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onSend={vi.fn()} historyKey={key} />)
    fireEvent.keyDown(getInput(), { key: 'ArrowUp' })
    expect(getInput().value).toBe('remembered prompt')
  })

  it('does not hijack ArrowUp while drafting text', () => {
    render(
      <FreshAgentComposer
        commands={GROUPED_COMMANDS}
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

  it('focuses the chat input by default when requested and enabled', async () => {
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} focusOnReady onSend={vi.fn()} />)

    await waitFor(() => {
      expect(document.activeElement).toBe(getInput())
    })
  })

  it('keeps the subtle thinking bar slot stable when work starts and stops', () => {
    const { rerender } = render(<FreshAgentComposer commands={GROUPED_COMMANDS} onSend={vi.fn()} />)

    expect(screen.getByTestId('fresh-agent-thinking-bar')).toHaveAttribute('data-state', 'idle')

    rerender(<FreshAgentComposer commands={GROUPED_COMMANDS} thinking onSend={vi.fn()} />)
    expect(screen.getByTestId('fresh-agent-thinking-bar')).toBeInTheDocument()
    expect(screen.getByTestId('fresh-agent-thinking-bar')).toHaveAttribute('data-state', 'active')
  })

  it('matches message text sizing and labels the command and send buttons with tooltips', () => {
    render(<FreshAgentComposer commands={GROUPED_COMMANDS} onSend={vi.fn()} />)

    expect(getInput().className).toContain('fresh-agent-composer-input')
    expect(getInput().className).toContain('text-base')
    expect(getInput().className).toContain('sm:text-sm')

    const commandButton = screen.getByRole('button', { name: 'Slash commands' })
    expect(commandButton).toHaveAttribute('title', 'Slash commands')
    expect(commandButton.querySelector('.lucide-list-start')).not.toBeNull()

    fireEvent.mouseEnter(commandButton)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Slash commands')
    fireEvent.mouseLeave(commandButton)

    const sendButton = screen.getByRole('button', { name: 'Send' })
    expect(sendButton).toHaveAttribute('title', 'Send message')
    fireEvent.focus(sendButton)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Send message')
  })

  it('shows queued message counts without pinning queued text above the composer', () => {
    const onCancelQueued = vi.fn()
    render(
      <FreshAgentComposer
        commands={GROUPED_COMMANDS}
        queuedMessages={[
          'Do not pin my newest message at the bottom',
          'Keep this queued follow-up private until expanded',
        ]}
        onCancelQueued={onCancelQueued}
      />,
    )

    const queuedStatus = screen.getByRole('status', { name: 'Queued messages' })
    expect(queuedStatus).toHaveTextContent('2 queued')
    expect(screen.queryByText('Do not pin my newest message at the bottom')).not.toBeInTheDocument()
    expect(screen.queryByText('Keep this queued follow-up private until expanded')).not.toBeInTheDocument()

    const removeButtons = screen.getAllByRole('button', { name: /Remove queued message/ })
    expect(removeButtons).toHaveLength(2)
    fireEvent.click(removeButtons[0])
    expect(onCancelQueued).toHaveBeenCalledWith(0)
  })

  describe('grouped slash menu (provider session commands)', () => {
    const SESSION_ROWS: readonly FreshAgentSessionMenuRow[] = [
      {
        kind: 'session',
        name: 'review',
        description: 'Review the current diff',
        argumentHint: '[file]',
        aliases: ['pr'],
      },
      { kind: 'session', name: 'init', description: 'Scan the project and write AGENTS.md' },
    ]

    it('groups pane actions before provider session rows behind labelled dividers', () => {
      render(
        <FreshAgentComposer
          commands={{ action: COMMANDS, session: SESSION_ROWS }}
          onCommand={vi.fn()}
        />,
      )

      fireEvent.change(getInput(), { target: { value: '/' } })
      const menu = screen.getByRole('menu', { name: 'Slash commands' })

      const paneActions = within(menu).getByRole('group', { name: 'Pane actions' })
      const agentSession = within(menu).getByRole('group', { name: 'Agent session' })
      // Divider labels are visible, static text (not focusable rows).
      expect(within(paneActions).getByText('Pane actions')).toBeInTheDocument()
      expect(within(agentSession).getByText('Agent session')).toBeInTheDocument()

      // Action rows render first, session rows after (flat document order).
      const items = within(menu).getAllByRole('menuitem')
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('/new'),
        expect.stringContaining('/compact'),
        expect.stringContaining('/fork'),
        expect.stringContaining('/review'),
        expect.stringContaining('/init'),
      ])

      // Session rows render name + description + argumentHint.
      const reviewRow = within(agentSession).getByRole('menuitem', { name: /\/review/ })
      expect(reviewRow).toHaveTextContent('/review')
      expect(reviewRow).toHaveTextContent('Review the current diff')
      expect(reviewRow).toHaveTextContent('[file]')
    })

    it('renders colliding action and session rows and keeps typed-Enter dispatching the action', () => {
      const onCommand = vi.fn()
      const onSend = vi.fn()
      render(
        <FreshAgentComposer
          commands={{
            action: [{ name: 'compact', description: 'Compact the context (pane action)', action: 'compact' }],
            session: [{ kind: 'session', name: 'compact', description: 'Provider compact (session command)' }],
          }}
          onCommand={onCommand}
          onSend={onSend}
        />,
      )

      fireEvent.change(getInput(), { target: { value: '/compact' } })
      expect(screen.getAllByRole('menuitem', { name: /\/compact/ })).toHaveLength(2)

      fireEvent.keyDown(getInput(), { key: 'Enter' })
      expect(onCommand).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'compact', action: 'compact' }),
        '',
      )
      expect(onSend).not.toHaveBeenCalled()
      // The action executed; the input was NOT left holding '/compact ' text.
      expect(getInput().value).toBe('')
    })

    it('inserts the canonical session command name on click select and never sends', async () => {
      const onCommand = vi.fn()
      const onSend = vi.fn()
      render(
        <FreshAgentComposer
          commands={{ action: [], session: SESSION_ROWS }}
          onCommand={onCommand}
          onSend={onSend}
        />,
      )

      // The 'review' row carries the alias 'pr'; selection still inserts the
      // canonical catalog name.
      fireEvent.change(getInput(), { target: { value: '/rev' } })
      fireEvent.click(screen.getByRole('menuitem', { name: /\/review/ }))

      expect(getInput().value).toBe('/review ')
      expect(onCommand).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      await waitFor(() => expect(document.activeElement).toBe(getInput()))
    })

    it('inserts the canonical session command name on keyboard select and never sends', async () => {
      const onCommand = vi.fn()
      const onSend = vi.fn()
      render(
        <FreshAgentComposer
          commands={{ action: [], session: SESSION_ROWS }}
          onCommand={onCommand}
          onSend={onSend}
        />,
      )

      fireEvent.change(getInput(), { target: { value: '/rev' } })
      fireEvent.keyDown(getInput(), { key: 'Enter' })

      expect(getInput().value).toBe('/review ')
      expect(onCommand).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      await waitFor(() => expect(document.activeElement).toBe(getInput()))
    })

    it('sends a typed unknown slash command verbatim (session rows never hijack typed-Enter)', () => {
      const onCommand = vi.fn()
      const onSend = vi.fn()
      render(
        <FreshAgentComposer
          commands={{ action: [], session: SESSION_ROWS }}
          onCommand={onCommand}
          onSend={onSend}
        />,
      )

      // '/pr' is only an alias of the 'review' session row: typed-Enter
      // dispatch consults action rows only, so the text ships verbatim.
      fireEvent.change(getInput(), { target: { value: '/pr docs' } })
      fireEvent.keyDown(getInput(), { key: 'Enter' })

      expect(onSend).toHaveBeenCalledWith('/pr docs')
      expect(onCommand).not.toHaveBeenCalled()
    })

    it('describes Enter accurately for the highlighted row kind: runs for pane actions, inserts for session rows', () => {
      render(
        <FreshAgentComposer
          commands={{ action: COMMANDS, session: SESSION_ROWS }}
          onCommand={vi.fn()}
        />,
      )

      fireEvent.change(getInput(), { target: { value: '/' } })
      const menu = screen.getByRole('menu', { name: 'Slash commands' })
      // The highlight opens on the first pane action row: Enter RUNS that action.
      expect(within(menu).getByText('Enter runs')).toBeInTheDocument()

      // Walk the highlight onto the first session row: Enter INSERTS that row's
      // /name text — the hint must not claim it runs anything.
      fireEvent.keyDown(getInput(), { key: 'ArrowDown' })
      fireEvent.keyDown(getInput(), { key: 'ArrowDown' })
      fireEvent.keyDown(getInput(), { key: 'ArrowDown' })
      expect(within(menu).getByText('Enter inserts')).toBeInTheDocument()
      expect(within(menu).queryByText('Enter runs')).toBeNull()

      // Back onto a pane action row, the original hint returns unchanged.
      fireEvent.keyDown(getInput(), { key: 'ArrowUp' })
      expect(within(menu).getByText('Enter runs')).toBeInTheDocument()
      expect(within(menu).queryByText('Enter inserts')).toBeNull()
    })

    it('renders the flat single-list menu structure when no session rows exist', () => {
      render(
        <FreshAgentComposer
          commands={{ action: COMMANDS, session: [] }}
          onCommand={vi.fn()}
        />,
      )

      fireEvent.change(getInput(), { target: { value: '/' } })
      const menu = screen.getByRole('menu', { name: 'Slash commands' })
      expect(within(menu).queryByRole('group')).toBeNull()
      expect(within(menu).queryByText('Pane actions')).toBeNull()
      expect(within(menu).queryByText('Agent session')).toBeNull()
      expect(within(menu).getAllByRole('menuitem')).toHaveLength(3)
    })

    it('matches colliding rows on a name-substring filter and leaves no menu ARIA once closed', () => {
      render(
        <FreshAgentComposer
          commands={{
            action: [{ name: 'compact', description: 'Compact the context (pane action)', action: 'compact' }],
            session: [{ kind: 'session', name: 'compact', description: 'Provider compact (session command)' }],
          }}
          onCommand={vi.fn()}
        />,
      )

      fireEvent.change(getInput(), { target: { value: '/comp' } })
      expect(screen.getAllByRole('menuitem', { name: /\/compact/ })).toHaveLength(2)
      expect(screen.getByRole('group', { name: 'Pane actions' })).toBeInTheDocument()
      expect(screen.getByRole('group', { name: 'Agent session' })).toBeInTheDocument()

      // Clearing the draft closes the menu (Escape in chat mode re-opens
      // immediately while the input still holds '/…' — a pre-existing quirk
      // left alone here). Closed means: no menu roles anywhere, and the input
      // never grew combobox ARIA.
      fireEvent.change(getInput(), { target: { value: '' } })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.queryByRole('menuitem')).toBeNull()
      expect(screen.queryByRole('group')).toBeNull()
      // The input never grows combobox ARIA — the menu owns all of it,
      // only while open.
      expect(getInput()).not.toHaveAttribute('aria-expanded')
      expect(getInput()).not.toHaveAttribute('aria-controls')
      expect(getInput()).not.toHaveAttribute('aria-activedescendant')
    })
  })

  describe('state-aware disabled behavior', () => {
    it('shows the provided placeholder instead of the generic read-only text', () => {
      render(
        <FreshAgentComposer
          commands={GROUPED_COMMANDS}
          disabled
          placeholder="Starting session…"
        />,
      )
      expect(getInput()).toHaveAttribute('placeholder', 'Starting session…')
    })

    it('falls back to Read-only session when disabled without a placeholder', () => {
      render(<FreshAgentComposer commands={GROUPED_COMMANDS} disabled />)
      expect(getInput()).toHaveAttribute('placeholder', 'Read-only session')
    })

    it('keeps /new reachable from the command menu while disabled', () => {
      const onCommand = vi.fn()
      render(<FreshAgentComposer commands={GROUPED_COMMANDS} disabled onCommand={onCommand} />)

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
