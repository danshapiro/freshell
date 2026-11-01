import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FreshAgentNoticeStack } from '@/components/fresh-agent/FreshAgentNoticeStack'
afterEach(cleanup)
it('groups routine notices and preserves recovery behind an error summary', async () => {
 const user = userEvent.setup(); const retry = vi.fn()
 render(<FreshAgentNoticeStack notices={[{id:'restoring',text:'Restoring session...'},{id:'notice',text:'Settings updated'}]} errors={[{id:'load',summary:'Conversation could not load',content:<button onClick={retry}>Retry history</button>}]} />)
 expect(screen.getByRole('status',{name:'Agent notices'})).toBeVisible()
 const button=screen.getByRole('button',{name:'Retry history'})
 expect(button).not.toBeVisible()
 expect(screen.getByRole('region',{name:'Agent errors'})).toContainElement(screen.getByRole('alert'))
 expect(screen.getByRole('alert')).toHaveTextContent('Conversation could not load')
 await user.click(screen.getByText('Conversation could not load'))
 expect(button).toBeVisible(); await user.click(button); expect(retry).toHaveBeenCalledOnce()
})
it('keeps reconciliation and owner transition visible in the compact status row', () => {
 render(<FreshAgentNoticeStack notices={[{id:'reconciliation',text:'Session corrected',prominent:true},{id:'transition',text:'Reopening elsewhere',prominent:true}]} errors={[]} />)
 expect(screen.getByText('Session corrected')).toBeVisible()
 expect(screen.getByText('Reopening elsewhere')).toBeVisible()
 expect(screen.getByRole('status',{name:'Agent notices'})).toHaveTextContent('2 notices')
})
