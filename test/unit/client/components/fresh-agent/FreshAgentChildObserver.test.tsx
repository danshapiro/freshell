import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('retains already available content during a source rebind, then refreshes it without changing identity', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(readable()).mockRejectedValue(new Error('source unavailable'))
    const { rerender } = render(<FreshAgentChildObserver parent={parent} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText('Exact observed child')).toBeVisible()
    rerender(<FreshAgentChildObserver parent={{ ...parent, observedGeneration: 8 }} childThreadId="child" onClose={vi.fn()} />)
    expect(await screen.findByText(/previously available content/i)).toBeVisible()
    expect(screen.getByText('Exact observed child')).toBeVisible()
    expect(api.post).not.toHaveBeenCalled()
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
})
