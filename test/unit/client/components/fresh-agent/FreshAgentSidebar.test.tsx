import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentSidebar } from '@/components/fresh-agent/FreshAgentSidebar'
import { FreshAgentObserveChildContext } from '@/components/fresh-agent/FreshAgentItemCard'

afterEach(cleanup)

it('observes the selected Codex identity with its parent fence from the child panel', () => {
  const parent = { parentSessionId: 'parent', provider: 'codex', sessionType: 'freshcodex', observedEpoch: 1, observedGeneration: 2 } as const
  const onObserve = vi.fn()
  render(<FreshAgentObserveChildContext.Provider value={{ parent, onObserve }}><FreshAgentSidebar worktrees={[]} childThreads={[{ id: 'child', threadId: 'child', status: 'failed', error: 'Child failure', model: 'child-model' }]} /></FreshAgentObserveChildContext.Provider>)
  expect(screen.getByText(/Child failure/)).toHaveTextContent('child-model')
  fireEvent.click(screen.getByRole('button', { name: 'Observe child child' }))
  expect(onObserve).toHaveBeenCalledWith({ type: 'observe-child', parent, childThreadId: 'child' })
})

it('renders the latest plan and step statuses, replacing earlier progress', () => {
  const props: any = { worktrees: [], childThreads: [], codexPlan: { explanation: 'Work in order', plan: [{ step: 'Inspect', status: 'inProgress' }, { step: 'Verify', status: 'pending' }] } }
  const { rerender } = render(<FreshAgentSidebar {...props} />)
  expect(screen.getByText('Plan')).toBeVisible()
  expect(screen.getByText('Inspect').closest('li')).toHaveTextContent('In progress')
  expect(screen.getByText('Verify').closest('li')).toHaveTextContent('Pending')
  rerender(<FreshAgentSidebar {...props} codexPlan={{ plan: [{ step: 'Inspect', status: 'completed' }] }} />)
  expect(screen.getByText('Inspect').closest('li')).toHaveTextContent('Completed')
  expect(screen.queryByText('Verify')).toBeNull()
  expect(screen.queryByText('Work in order')).toBeNull()
})
