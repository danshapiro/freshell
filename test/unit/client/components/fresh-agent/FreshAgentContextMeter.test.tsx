import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { freshAgentSnapshotReceived } from '@/store/freshAgentSlice'
import { FreshAgentContextMeter } from '@/components/fresh-agent/FreshAgentContextMeter'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'

function makeStore() {
  return configureStore({
    reducer: {
      freshAgent: freshAgentReducer,
    },
  })
}

const PANE_CONTENT = {
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  sessionId: 'thread-1',
  createRequestId: 'req-1',
  status: 'connected',
} as unknown as FreshAgentPaneContent

function makeSnapshot(tokenUsage: FreshAgentSnapshot['tokenUsage']): FreshAgentSnapshot {
  return {
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: 'thread-1',
    revision: 1,
    status: 'idle',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: true,
      questions: true,
      fork: false,
    },
    tokenUsage,
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [],
    extensions: {},
  } as FreshAgentSnapshot
}

function renderMeter(store: ReturnType<typeof makeStore>) {
  return render(
    <Provider store={store}>
      <FreshAgentContextMeter paneContent={PANE_CONTENT} />
    </Provider>,
  )
}

describe('FreshAgentContextMeter', () => {
  afterEach(() => cleanup())

  it('renders percent of compaction threshold from the snapshot', () => {
    const store = makeStore()
    store.dispatch(freshAgentSnapshotReceived({
      snapshot: makeSnapshot({
        inputTokens: 40_000,
        outputTokens: 14_000,
        totalTokens: 54_000,
        contextTokens: 54_000,
        compactPercent: 27,
        costUsd: 1.23,
      }),
    }))
    renderMeter(store)

    const meter = screen.getByRole('status', { name: 'Context 27% full' })
    expect(meter).toHaveTextContent('27%')
    expect(meter).not.toHaveAttribute('data-warn')
    const toggle = meter.closest('button')
    expect(toggle).toHaveAttribute('title', expect.stringContaining('54k tokens'))
    expect(toggle).toHaveAttribute('title', expect.stringContaining('$1.23'))
  })

  it('switches to the warning treatment near compaction', () => {
    const store = makeStore()
    store.dispatch(freshAgentSnapshotReceived({
      snapshot: makeSnapshot({
        inputTokens: 150_000,
        outputTokens: 22_000,
        totalTokens: 172_000,
        contextTokens: 172_000,
        compactPercent: 86,
      }),
    }))
    renderMeter(store)

    const meter = screen.getByRole('status', { name: 'Context 86% full' })
    expect(meter).toHaveAttribute('data-warn')
    expect(meter.closest('button')).toHaveAttribute('title', expect.stringContaining('Compaction soon'))
  })

  it('falls back to raw context tokens when no percent is reported', () => {
    const store = makeStore()
    store.dispatch(freshAgentSnapshotReceived({
      snapshot: makeSnapshot({
        inputTokens: 9_000,
        outputTokens: 3_000,
        totalTokens: 12_000,
        contextTokens: 12_000,
      }),
    }))
    renderMeter(store)

    expect(screen.getByRole('status', { name: 'Context 12k tokens' })).toHaveTextContent('12k ctx')
  })

  it('renders nothing without usable token data', () => {
    const store = makeStore()
    store.dispatch(freshAgentSnapshotReceived({
      snapshot: makeSnapshot({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }),
    }))
    const { container } = renderMeter(store)
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('renders nothing when the session has no snapshot yet', () => {
    const store = makeStore()
    const { container } = renderMeter(store)
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
