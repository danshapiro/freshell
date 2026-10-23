import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import freshAgentLiveReducer, {
  assistantBlockBound,
  liveRetrySet,
  streamOpsApplied,
} from '@/store/freshAgentLiveSlice'
import type { LiveStreamOp } from '@/store/freshAgentLiveTypes'
import { FreshAgentLiveTail } from '@/components/fresh-agent/FreshAgentLiveTail'
import { FreshAgentTranscript, TranscriptFollowContext } from '@/components/fresh-agent/FreshAgentTranscript'
import { landedTranscript, type LandedTranscript } from '@/lib/fresh-agent-landed-transcript'

// Render markdown synchronously (the transcript tests' established mock): the
// real LazyMarkdown swaps a plain fallback for the renderer chunk once loaded.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

const locator = { sessionId: 'tail-1', sessionType: 'freshclaude' as const, provider: 'claude' as const }
const KEY = 'freshclaude:claude:tail-1'
const NONE: LandedTranscript = landedTranscript([])

function createStore() {
  return configureStore({ reducer: { freshAgent: freshAgentReducer, freshAgentLive: freshAgentLiveReducer } })
}

type Store = ReturnType<typeof createStore>

function apply(store: Store, ...ops: LiveStreamOp[]) {
  act(() => {
    store.dispatch(streamOpsApplied({ ...locator, ops }))
  })
}

const start = (index: number, kind: 'text' | 'thinking' | 'tool_use', extra: Record<string, unknown> = {}) => (
  { op: 'start', messageId: 'msg_1', index, kind, ...extra } as LiveStreamOp
)
const delta = (index: number, text: string): LiveStreamOp => ({ op: 'delta', messageId: 'msg_1', index, text })

function renderTail(store: Store, landed: LandedTranscript = NONE) {
  return render(
    <Provider store={store}>
      <FreshAgentLiveTail sessionKey={KEY} landed={landed} agentLabel="Claude" />
    </Provider>,
  )
}

function activityStatus() {
  return within(screen.getByRole('region', { name: 'Activity strip' })).getByRole('status')
}

afterEach(() => {
  cleanup()
})

describe('FreshAgentLiveTail (transcript-live D4)', () => {
  it('renders nothing while the session has nothing live', () => {
    const store = createStore()
    const { container } = renderTail(store)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders streamed text as markdown and grows with each batch', async () => {
    const store = createStore()
    apply(store, start(0, 'text'), delta(0, 'Hello **bold'))
    renderTail(store)
    apply(store, delta(0, ' world** and more'))

    const strong = await screen.findByText('bold world', { selector: 'strong' })
    expect(strong).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Claude live response' })).toHaveTextContent('Hello bold world and more')
  })

  it('shows a live thinking strip while the model is thinking', () => {
    const store = createStore()
    apply(store, start(0, 'thinking'), delta(0, 'considering the files'))
    renderTail(store)
    expect(activityStatus()).toHaveTextContent('Thinking')
    expect(screen.getByLabelText('running')).toBeInTheDocument()
  })

  it('shows a tool by name as soon as its block starts, then its input once the message carries it', () => {
    const store = createStore()
    apply(store, start(0, 'tool_use', { name: 'Read', toolUseId: 'toolu_1' }))
    renderTail(store)
    expect(activityStatus()).toHaveTextContent('Read')

    act(() => {
      store.dispatch(assistantBlockBound({
        ...locator,
        uuid: 'u-tool',
        messageId: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/src/app.ts' } }],
      }))
    })
    expect(activityStatus()).toHaveTextContent('/repo/src/app.ts')
  })

  it('shows the Retrying reel while the CLI retries an API request', () => {
    const store = createStore()
    act(() => {
      store.dispatch(liveRetrySet({ ...locator, attempt: 2, maxRetries: 10, delayMs: 1000, errorStatus: 529, error: 'overloaded' }))
    })
    renderTail(store)
    expect(activityStatus()).toHaveTextContent('Retrying')
    expect(activityStatus()).toHaveTextContent('attempt 2')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByTestId('fresh-agent-retry-row')).toHaveTextContent('Retrying (attempt 2) — overloaded (529) · retrying in 1s')

    // The retried request answers: the reel goes away.
    apply(store, start(0, 'text'), delta(0, 'Back'))
    expect(screen.queryByTestId('fresh-agent-retry-row')).not.toBeInTheDocument()
    expect(screen.queryByText('Retrying')).not.toBeInTheDocument()
  })

  it('hides a block as soon as the snapshot holding its line is rendered', async () => {
    const store = createStore()
    apply(store, start(0, 'thinking'), delta(0, 'planning'), start(1, 'text'), delta(1, 'Final words'))
    act(() => {
      store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-text', messageId: 'msg_1', content: [{ type: 'text', text: 'Final words' }] }))
    })
    const { rerender, container } = renderTail(store)
    await screen.findByText('Final words')

    rerender(
      <Provider store={store}>
        <FreshAgentLiveTail sessionKey={KEY} landed={landedTranscript(['u-text'])} agentLabel="Claude" />
      </Provider>,
    )
    expect(screen.queryByText('Final words')).not.toBeInTheDocument()
    expect(activityStatus()).toHaveTextContent('Thinking')

    act(() => {
      store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-think', messageId: 'msg_1', content: [{ type: 'thinking', thinking: 'planning' }] }))
    })
    rerender(
      <Provider store={store}>
        <FreshAgentLiveTail sessionKey={KEY} landed={landedTranscript(['u-text', 'u-think'])} agentLabel="Claude" />
      </Provider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('hides a block whose assistant frame never arrived once the snapshot holds its message\'s line at its position', async () => {
    const store = createStore()
    apply(store, start(0, 'text'), delta(0, 'Unbound words'))
    const { rerender, container } = renderTail(store)
    await screen.findByText('Unbound words')

    rerender(
      <Provider store={store}>
        <FreshAgentLiveTail sessionKey={KEY} landed={landedTranscript(['u-elsewhere'], { msg_1: ['text'] })} agentLabel="Claude" />
      </Provider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('asks the transcript to follow when it grows', () => {
    const store = createStore()
    const requestFollow = vi.fn()
    apply(store, start(0, 'text'), delta(0, 'one'))
    render(
      <Provider store={store}>
        <TranscriptFollowContext.Provider value={{ requestFollow, lastTurnRole: 'user' }}>
          <FreshAgentLiveTail sessionKey={KEY} landed={NONE} agentLabel="Claude" />
        </TranscriptFollowContext.Provider>
      </Provider>,
    )
    const afterMount = requestFollow.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    apply(store, delta(0, ' two'))
    expect(requestFollow.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('continues the previous assistant turn without a second header', () => {
    const store = createStore()
    apply(store, start(0, 'text'), delta(0, 'more'))
    render(
      <Provider store={store}>
        <TranscriptFollowContext.Provider value={{ requestFollow: () => {}, lastTurnRole: 'assistant' }}>
          <FreshAgentLiveTail sessionKey={KEY} landed={NONE} agentLabel="Claude" />
        </TranscriptFollowContext.Provider>
      </Provider>,
    )
    const article = screen.getByRole('article', { name: 'Claude live response' })
    expect(within(article).queryByText('Claude')).not.toBeInTheDocument()
    // A live response offers no turn actions (it is not a turn yet).
    expect(within(article).queryByRole('button', { name: /copy|fork|undo/i })).not.toBeInTheDocument()
    expect(article).toHaveAttribute('aria-busy', 'true')
  })
})

describe('FreshAgentTranscript live tail slot (transcript-live D4)', () => {
  function setup() {
    const store = createStore()
    apply(store, start(0, 'text'), delta(0, 'line one'))
    const turns = [{
      id: 'turn-1',
      turnId: 'turn-1',
      role: 'user' as const,
      summary: 'question',
      items: [{ id: 'item-1', kind: 'text' as const, text: 'question' }],
    }]
    const view = render(
      <Provider store={store}>
        <FreshAgentTranscript
          turns={turns}
          tail={<FreshAgentLiveTail sessionKey={KEY} landed={NONE} agentLabel="Claude" />}
        />
      </Provider>,
    )
    const scroller = view.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    let scrollHeight = 1000
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    return {
      store,
      scroller,
      grow: (height: number, text: string) => {
        scrollHeight = height
        apply(store, delta(0, text))
      },
    }
  }

  it('renders the tail after the turns', async () => {
    setup()
    const articles = screen.getAllByRole('article')
    expect(articles.at(-1)).toHaveAccessibleName('Claude live response')
    await waitFor(() => expect(articles.at(-1)).toHaveTextContent('line one'))
  })

  it('pins to the bottom as the tail grows while the reader is at the bottom', () => {
    const { scroller, grow } = setup()
    scroller.scrollTop = 800
    fireEvent.scroll(scroller)
    grow(1400, ' and line two')
    expect(scroller.scrollTop).toBe(1400)
  })

  it('leaves the scroll position alone when the reader has scrolled up', () => {
    const { scroller, grow } = setup()
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    grow(1400, ' and line two')
    expect(scroller.scrollTop).toBe(100)
  })
})
