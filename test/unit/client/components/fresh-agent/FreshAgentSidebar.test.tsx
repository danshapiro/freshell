import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FreshAgentSidebar } from '@/components/fresh-agent/FreshAgentSidebar'

afterEach(cleanup)

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
