import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FreshAgentAsyncQuestionContext } from '@/components/fresh-agent/FreshAgentItemCard'
import { FreshAgentChildObserver } from '@/components/fresh-agent/FreshAgentChildObserver'
import { api } from '@/lib/api'
import { codexContractSnapshot } from '../../../../fixtures/fresh-agent/codex/contract-fixtures.js'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@/components/markdown/LazyMarkdown', () => ({ LazyMarkdown: ({ content }: { content: string }) => <p>{content}</p> }))
const parent = { parentSessionId: 'parent', provider: 'codex', sessionType: 'freshcodex', observedEpoch: 4, observedGeneration: 7 } as const
const readable = (status: 'live' | 'saved' = 'saved') => ({ parentThreadId: 'parent', childThreadId: 'child', status, snapshot: { ...codexContractSnapshot, threadId: 'child', turns: [{ id: 'answer', turnId: 'answer', role: 'assistant', summary: '', items: [{ id: 'body', kind: 'text', text: 'Exact observed child' }] }] } })

describe('FreshAgentChildObserver', () => {
  afterEach(() => { expect(api.post).not.toHaveBeenCalled(); cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

  it('reads the parent-scoped route with its owner fence and never offers writer controls', async () => {
    vi.mocked(api.get).mockResolvedValue(readable())
    render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText('Exact observed child')).toBeVisible()
    expect(api.get).toHaveBeenCalledWith('/api/fresh-agent/threads/freshcodex/codex/parent/children/child?observedEpoch=4&observedGeneration=7', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.post).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send|stop|configure|resume/i })).not.toBeInTheDocument()
  })

  it('keeps child async questions read-only even under a parent answer context', async () => {
    const onParentAnswer = vi.fn()
    const response = readable()
    response.snapshot.turns[0].items = [{ id: 'child-question', kind: 'text', text: 'A child asks', extensions: { codex: { itemId: 'native-child-question', delivery: 'async', questions: [{ title: 'Child question?', options: ['Child choice'] }] } } }] as never
    vi.mocked(api.get).mockResolvedValue(response)
    render(<FreshAgentAsyncQuestionContext.Provider value={{ onAnswer: onParentAnswer }}><FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} /></FreshAgentAsyncQuestionContext.Provider>)
    expect(await screen.findByText('Child question?')).toBeVisible()
    const choice = screen.queryByRole('button', { name: 'Child choice', exact: true })
    if (choice) fireEvent.click(choice)
    expect(onParentAnswer).not.toHaveBeenCalled()
    expect(choice).not.toBeInTheDocument()
    expect(screen.getByText('Child choice')).toBeVisible()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('retains already available content during a source rebind, then refreshes it without changing identity', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(readable()).mockRejectedValue(new Error('source unavailable'))
    const { rerender } = render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText('Exact observed child')).toBeVisible()
    rerender(<FreshAgentChildObserver parent={{ ...parent, observedGeneration: 8 }} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText(/previously available content/i)).toBeVisible()
    expect(screen.getByText('Exact observed child')).toBeVisible()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('preserves explicit running native MCP outcomes when read-only history becomes unavailable', async () => {
    const response = readable('live')
    const live = { ...response, snapshot: { ...response.snapshot, status: 'running', turns: [{ id: 'tools', turnId: 'tools', role: 'assistant', summary: '', items: [
      { id: 'first', kind: 'mcp_tool', server: 'native', tool: 'first', status: 'running', arguments: {} },
      { id: 'second', kind: 'mcp_tool', server: 'native', tool: 'second', status: 'running', arguments: {} },
    ] }] } }
    vi.mocked(api.get).mockResolvedValueOnce(live).mockRejectedValue(new Error('source unavailable'))
    const { rerender } = render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getAllByLabelText('running')).toHaveLength(2)
    expect(screen.queryByLabelText('complete')).not.toBeInTheDocument()
    rerender(<FreshAgentChildObserver parent={{ ...parent, observedGeneration: 8 }} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText(/previously available content/i)).toBeVisible()
    expect(screen.getAllByLabelText('running')).toHaveLength(2)
    expect(screen.queryByLabelText('complete')).not.toBeInTheDocument()
  })

  it('makes pending materialization finite and can later read saved content', async () => {
    vi.useFakeTimers()
    vi.mocked(api.get).mockResolvedValue({ parentThreadId: 'parent', childThreadId: 'child', status: 'pending', reason: 'history_unmaterialized', retryable: true })
    render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.get).toHaveBeenCalledTimes(5)
    expect(screen.getByText(/history is unavailable/i)).toBeVisible()
    vi.mocked(api.get).mockResolvedValue(readable())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh child history' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Exact observed child')).toBeVisible()
    expect(api.post).not.toHaveBeenCalled()
  })

  it('moves from genuinely pending history to the exact materialized child without a writer', async () => {
    vi.useFakeTimers()
    vi.mocked(api.get).mockResolvedValueOnce({ parentThreadId: 'parent', childThreadId: 'child', status: 'pending', reason: 'history_unmaterialized', retryable: true }).mockResolvedValue(readable())
    render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Waiting for child history to be saved.')).toBeVisible()
    expect(screen.queryByText('Exact observed child')).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('Exact observed child')).toBeVisible()
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('does not poll permanently unavailable ephemeral history or synthesize an empty transcript', async () => {
    vi.mocked(api.get).mockResolvedValue({ parentThreadId: 'parent', childThreadId: 'child', status: 'unavailable', reason: 'ephemeral_history_unavailable', retryable: false })
    render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText(/ephemeral child/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Refresh child history' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Assistant transcript turn')).not.toBeInTheDocument()
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('rejects a response for a different child and returns focus after deliberate close', async () => {
    vi.mocked(api.get).mockResolvedValue({ ...readable(), childThreadId: 'unrelated' })
    const onClose = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={onClose} />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.queryByText('Exact observed child')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('contains Tab and Shift-Tab, uses the latest Escape callback, and returns focus to its opener', async () => {
    vi.mocked(api.get).mockResolvedValue(readable())
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const initialClose = vi.fn()
    const latestClose = vi.fn()
    const { rerender, unmount } = render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={initialClose} />)
    await screen.findByText('Exact observed child')
    const close = screen.getByRole('button', { name: 'Close child conversation' })
    const lastControl = screen.getByRole('button', { name: 'Copy turn', exact: true })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(lastControl).toHaveFocus()
    fireEvent.keyDown(lastControl, { key: 'Tab' })
    expect(close).toHaveFocus()
    rerender(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={latestClose} />)
    expect(close).toHaveFocus()
    fireEvent.keyDown(lastControl, { key: 'Escape' })
    expect(initialClose).not.toHaveBeenCalled()
    expect(latestClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
