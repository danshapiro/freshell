import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../../../src/store/tabsSlice'

// Mock api module
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

// Mock ws-client
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    onMessage: () => () => {},
  }),
}))

import { api } from '@/lib/api'
import OverviewView from '../../../../src/components/OverviewView'

const mockGet = api.get as ReturnType<typeof vi.fn>
const mockPost = api.post as ReturnType<typeof vi.fn>
const mockPatch = api.patch as ReturnType<typeof vi.fn>

const terminals = [
  {
    terminalId: 't1',
    title: 'Shell',
    mode: 'shell',
    createdAt: 1000,
    lastActivityAt: 2000,
    status: 'running',
    hasClients: false,
  },
  {
    terminalId: 't2',
    title: 'Claude',
    mode: 'claude',
    resumeSessionId: 'sess-1',
    createdAt: 1000,
    lastActivityAt: 3000,
    status: 'running',
    hasClients: true,
  },
]

function setupDefaultMocks() {
  mockGet.mockResolvedValue([...terminals])
  mockPost.mockResolvedValue({ description: 'AI summary', source: 'heuristic' })
  mockPatch.mockResolvedValue({})
}

function renderWithStore(ui: React.ReactElement) {
  const store = configureStore({
    reducer: { tabs: tabsReducer },
  })
  return render(<Provider store={store}>{ui}</Provider>)
}

async function waitForTerminalsLoaded() {
  await waitFor(() => {
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
  })
}

function getRefreshAllButton(): HTMLElement {
  const buttons = screen.getAllByLabelText('Refresh all summaries')
  return buttons[0]
}

describe('OverviewView Refresh All', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    setupDefaultMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a "Refresh all summaries" button', async () => {
    renderWithStore(<OverviewView />)
    await waitForTerminalsLoaded()
    expect(getRefreshAllButton()).toBeInTheDocument()
  })

  it('dispatches summary requests for all terminals on first click', async () => {
    renderWithStore(<OverviewView />)
    await waitForTerminalsLoaded()

    fireEvent.click(getRefreshAllButton())

    await waitFor(() => {
      const summaryCalls = mockPost.mock.calls.filter((c: any[]) => c[0].includes('/summary'))
      expect(summaryCalls.length).toBe(2)
    })
  })

  it('skips terminals that have not changed since last refresh', async () => {
    renderWithStore(<OverviewView />)
    await waitForTerminalsLoaded()

    // First refresh: should generate summaries for both terminals
    fireEvent.click(getRefreshAllButton())
    await waitFor(() => {
      const summaryCalls = mockPost.mock.calls.filter((c: any[]) => c[0].includes('/summary'))
      expect(summaryCalls.length).toBe(2)
    })

    // Wait for refreshAll to finish completely (button label reverts from "Refreshing...")
    await waitFor(() => {
      expect(screen.getAllByLabelText('Refresh all summaries').length).toBeGreaterThanOrEqual(1)
    })

    // Track only new calls after this point
    const postCallsBeforeSecondClick = mockPost.mock.calls.length

    // Second refresh -- should skip both since lastActivityAt unchanged
    fireEvent.click(getRefreshAllButton())

    // Wait a tick for the synchronous skip logic to complete
    await waitFor(() => {
      const newCalls = mockPost.mock.calls.slice(postCallsBeforeSecondClick)
      const newSummaryCalls = newCalls.filter((c: any[]) => c[0].includes('/summary'))
      expect(newSummaryCalls.length).toBe(0)
    })
  })

  it('handles partial failures gracefully', async () => {
    // Override post to succeed once and fail once
    mockPost
      .mockResolvedValueOnce({ description: 'Summary 1', source: 'ai' })
      .mockRejectedValueOnce(new Error('AI failed'))

    renderWithStore(<OverviewView />)
    await waitForTerminalsLoaded()

    fireEvent.click(getRefreshAllButton())

    // Should not crash; only the successful one gets patched
    await waitFor(() => {
      expect(mockPatch.mock.calls.length).toBe(1)
    })
  })

  it('per-terminal generate summary records in activity map so Refresh All skips it', async () => {
    // Use a single terminal to isolate the per-terminal generate path
    mockGet.mockResolvedValue([
      {
        terminalId: 't1',
        title: 'Shell',
        mode: 'shell',
        createdAt: 1000,
        lastActivityAt: 2000,
        status: 'running',
        hasClients: false,
      },
    ])

    renderWithStore(<OverviewView />)
    await waitFor(() => {
      expect(screen.getByText('Shell')).toBeInTheDocument()
    })

    // Click the per-terminal "Generate summary with AI" button
    const genButton = screen.getByLabelText('Generate summary with AI')
    fireEvent.click(genButton)

    // Wait for the per-terminal summary call to complete
    await waitFor(() => {
      const summaryCalls = mockPost.mock.calls.filter((c: any[]) => c[0].includes('/summary'))
      expect(summaryCalls.length).toBe(1)
    })

    // Wait for the generate to finish (button reverts from "Generating summary...")
    await waitFor(() => {
      expect(screen.getByLabelText('Generate summary with AI')).toBeInTheDocument()
    })

    // Track call count before Refresh All
    const postCallsBefore = mockPost.mock.calls.length

    // Now click Refresh All -- terminal should be skipped since lastActivityAt was recorded
    fireEvent.click(getRefreshAllButton())

    await waitFor(() => {
      const newCalls = mockPost.mock.calls.slice(postCallsBefore)
      const newSummaryCalls = newCalls.filter((c: any[]) => c[0].includes('/summary'))
      expect(newSummaryCalls.length).toBe(0)
    })
  })
})
