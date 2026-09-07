import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// Provenance: pins the panel's already-present inline-error/loading behavior
// that AGENT-13's Rust port relies on — plan docs/plans/2026-09-06-ekc6.md
// Task 3 (work item ekc6); the route it fetches is now ported in
// crates/freshell-server/src/fresh_agent_extras.rs.
const mockApiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: any[]) => mockApiGet(...args),
  },
}))

import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'

describe('FreshAgentDiffPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a fetch error inline instead of loading forever', async () => {
    mockApiGet.mockRejectedValue(
      new Error('git diff failed: Command failed: git diff --no-color\nwarning: Not a git repository...')
    )

    render(
      <FreshAgentDiffPanel
        diffs={[{ id: 'd1', path: 'a.txt', status: 'modified' }]}
        cwd="/repo"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Diff: a.txt' }))

    await screen.findByText(/git diff failed: Command failed: git diff --no-color/)

    expect(screen.queryByText('Loading diff…')).toBeNull()
    expect(mockApiGet).toHaveBeenCalledWith('/api/fresh-agent/diff?cwd=%2Frepo&path=a.txt')
  })

  it('renders added and removed diff lines on success', async () => {
    mockApiGet.mockResolvedValue({ diff: '@@ -1 +1 @@\n-one\n+two' })

    render(
      <FreshAgentDiffPanel
        diffs={[{ id: 'd1', path: 'a.txt', status: 'modified' }]}
        cwd="/repo"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Diff: a.txt' }))

    await screen.findByText('+two')
    expect(screen.getByText('-one')).toBeInTheDocument()

    expect(screen.queryByText('Loading diff…')).toBeNull()
    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })
})
