import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentActionSheet } from '@/components/fresh-agent/FreshAgentActionSheet'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'
import { FreshAgentComposer } from '@/components/fresh-agent/FreshAgentComposer'

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

function stubCoarsePointer(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

const TURNS = [
  {
    id: 'turn-1',
    turnId: 'turn-1',
    role: 'user' as const,
    summary: 'ask',
    items: [{ id: 'item-1', kind: 'text' as const, text: 'fix the bug' }],
  },
  {
    id: 'turn-2',
    turnId: 'turn-2',
    role: 'assistant' as const,
    summary: 'answer',
    items: [{ id: 'item-2', kind: 'text' as const, text: 'done' }],
  },
]

describe('FreshAgentActionSheet', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders items, runs them, and closes', () => {
    const run = vi.fn()
    const onClose = vi.fn()
    render(
      <FreshAgentActionSheet
        title="fix the bug"
        items={[
          { label: 'Copy turn text', run },
          { label: 'Rewind code to here', disabled: true, destructive: true, run: vi.fn() },
        ]}
        onClose={onClose}
      />,
    )

    expect(screen.getByRole('menu', { name: 'fix the bug' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rewind code to here' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy turn text' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('dismisses via backdrop and Escape', () => {
    const onClose = vi.fn()
    render(<FreshAgentActionSheet items={[{ label: 'X', run: vi.fn() }]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('coarse-pointer transcript behavior', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the ⋯ trigger and opens the action sheet instead of the floating menu', () => {
    stubCoarsePointer(true)
    const onFork = vi.fn()
    render(<FreshAgentTranscript turns={TURNS} canFork onForkFromTurn={onFork} />)

    const triggers = screen.getAllByRole('button', { name: 'Turn actions menu' })
    expect(triggers).toHaveLength(2)
    fireEvent.click(triggers[0])

    const sheet = screen.getByRole('menu', { name: /fix the bug/ })
    expect(sheet).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork conversation from here' }))
    expect(onFork).toHaveBeenCalledWith('turn-1')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('routes contextmenu (Android long-press) to the sheet on coarse pointers', () => {
    stubCoarsePointer(true)
    render(<FreshAgentTranscript turns={TURNS} canFork={false} />)

    fireEvent.contextMenu(screen.getByRole('article', { name: 'You transcript turn' }))
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Turn context menu' })).not.toBeInTheDocument()
  })

  it('keeps the floating context menu on fine pointers', () => {
    stubCoarsePointer(false)
    render(<FreshAgentTranscript turns={TURNS} canFork={false} />)

    expect(screen.queryByRole('button', { name: 'Turn actions menu' })).not.toBeInTheDocument()
    fireEvent.contextMenu(screen.getByRole('article', { name: 'You transcript turn' }))
    expect(screen.getByRole('menu', { name: 'Turn context menu' })).toBeInTheDocument()
  })
})

describe('coarse-pointer composer behavior', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('Enter inserts a newline instead of sending on touch keyboards', () => {
    stubCoarsePointer(true)
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={[]} onSend={onSend} />)

    const input = screen.getByRole('textbox', { name: 'Chat message input' })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('hello', [])
  })

  it('Enter still sends on fine pointers', () => {
    stubCoarsePointer(false)
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={[]} onSend={onSend} />)

    const input = screen.getByRole('textbox', { name: 'Chat message input' })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello', [])
  })
})
