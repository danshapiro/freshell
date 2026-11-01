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
 expect(screen.queryByText('Notice details')).not.toBeInTheDocument()
 expect(screen.getByRole('status',{name:'Agent notices'}).querySelector('details')).toBeNull()
})

it('names warning disclosures with the message while announcing warning severity', () => {
 const summary = 'Model catalog unavailable — try again'
 render(<FreshAgentNoticeStack notices={[]} errors={[{id:'notice',summary,level:'warning',content:<p>Provider diagnostics</p>}]} />)
 const alert = screen.getByRole('alert',{name:'Agent warning'})
 expect(alert.closest('summary')).toHaveAccessibleName(summary)
 expect(screen.getByRole('region',{name:'Agent errors'})).toHaveTextContent('1 warning')
})

it('lets short warnings expand so wrapped instructions are reachable', async () => {
 const user = userEvent.setup()
 const summary = 'Delivery uncertain: response was lost. Check the conversation before sending again.'
 render(<FreshAgentNoticeStack notices={[]} errors={[{id:'notice',summary,level:'warning',content:null}]} />)
 const alert = screen.getByRole('alert',{name:'Agent warning'})
 const disclosure = alert.closest('details')
 expect(disclosure).not.toBeNull()
 await user.click(alert)
 expect(disclosure).toHaveAttribute('open')
 expect(alert.closest('summary')).toHaveAccessibleName(summary)
})
