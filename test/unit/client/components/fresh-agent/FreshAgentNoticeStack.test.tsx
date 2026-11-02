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
it('keeps reconciliation and owner transition visible with nonempty expandable details', async () => {
 const user = userEvent.setup()
 render(<FreshAgentNoticeStack notices={[{id:'reconciliation',text:'Session corrected',prominent:true},{id:'transition',text:'Reopening elsewhere',prominent:true}]} errors={[]} />)
 const status = screen.getByRole('status',{name:'Agent notices'})
 const summary = status.querySelector('summary')!
 expect(summary).toHaveTextContent('Session corrected')
 expect(summary).toHaveTextContent('Reopening elsewhere')
 expect(summary).toBeVisible()
 expect(status).toHaveTextContent('2 notices')
 await user.click(summary)
 const body = status.querySelector('.fresh-agent-diagnostic-body')!
 expect(body).toBeVisible()
 expect(body).toHaveTextContent('Session corrected')
 expect(body).toHaveTextContent('Reopening elsewhere')
})

it('expands prominent-only status to real readable content', async () => {
 const user = userEvent.setup()
 const text = 'Session identity corrected by server — this pane now points at its live session.'
 render(<FreshAgentNoticeStack notices={[{id:'reconciliation',text,prominent:true}]} errors={[]} />)
 const status = screen.getByRole('status', {name:'Agent notices'})
 const summary = status.querySelector('summary')
 expect(summary).not.toBeNull()
 expect(summary).toHaveTextContent(text)
 const body = status.querySelector('.fresh-agent-diagnostic-body')!
 expect(body).not.toBeVisible()
 await user.click(summary!)
 expect(body).toBeVisible()
 expect(body).toHaveTextContent(text)
})

it('names warning disclosures with the message while announcing warning severity', () => {
 const summary = 'Model catalog unavailable — try again'
 render(<FreshAgentNoticeStack notices={[]} errors={[{id:'notice',summary,level:'warning',content:<p>Provider diagnostics</p>}]} />)
 const alert = screen.getByRole('alert',{name:'Agent warning'})
 expect(alert.closest('summary')).toHaveAccessibleName(summary)
 expect(screen.getByLabelText('1 warning')).toBeVisible()
 expect(screen.getByLabelText('1 warning')).toHaveTextContent('1')
})

it('shows the total diagnostic count with its exact severity breakdown', () => {
 render(<FreshAgentNoticeStack notices={[]} errors={[{id:'first',summary:'First error',content:null},{id:'second',summary:'Second warning',content:null,level:'warning'}]} />)
 const count = screen.getByLabelText('1 error, 1 warning')
 expect(count).toBeVisible()
 expect(count).toHaveTextContent('2')
 expect(screen.getByRole('region',{name:'Agent errors'})).toContainElement(count)
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
