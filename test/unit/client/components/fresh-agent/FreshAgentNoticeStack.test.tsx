import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
it('shows an actionable create failure and retry without requiring disclosure expansion', () => {
 render(<FreshAgentNoticeStack notices={[]} errors={[{id:'create',summary:'Agent could not start',initiallyExpanded:true,content:<><p>Host coding-agent starts are temporarily paused for maintenance.</p><button>Retry</button></>}]} />)
 expect(screen.getByText('Host coding-agent starts are temporarily paused for maintenance.')).toBeVisible()
 expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
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

it('shows a single routine message in its closed summary', () => {
 const text = 'Code rewound to the selected checkpoint'
 render(<FreshAgentNoticeStack notices={[{ id: 'notice', text }]} errors={[]} />)
 const status = screen.getByRole('status', { name: 'Agent notices' })
 expect(status.querySelector('summary')).toHaveTextContent(text)
 expect(status.querySelector('details')).not.toHaveAttribute('open')
})

it('reports the already-open routine surface when a transient joins, then clears ownership', () => {
 const onOpen = vi.fn()
 const restoring = { id: 'restoring', text: 'Restoring session...' }
 const { rerender } = render(<FreshAgentNoticeStack notices={[restoring]} errors={[]} />)
 const details = screen.getByRole('status', { name: 'Agent notices' }).querySelector('details')!
 details.open = true
 fireEvent(details, new Event('toggle', { bubbles: true }))
 rerender(<FreshAgentNoticeStack notices={[restoring, { id: 'notice', text: 'Settings saved' }]} errors={[]} onNoticesExpandedChange={onOpen} />)
 expect(onOpen).toHaveBeenLastCalledWith(true)
 rerender(<FreshAgentNoticeStack notices={[restoring]} errors={[]} />)
 expect(onOpen).toHaveBeenLastCalledWith(false)
})

it('clears a removed diagnostic surface and derives named severity counts after updates', () => {
 const onOpen = vi.fn()
 const first = { id: 'notice', summary: 'Provider warning', level: 'warning' as const, content: <p>Original details</p>, onToggle: onOpen }
 const { rerender } = render(<FreshAgentNoticeStack notices={[]} errors={[first, { id: 'create', summary: 'Agent could not start', content: null }]} />)
 const count = screen.getByRole('img', { name: '1 error, 1 warning' })
 expect(count).toHaveTextContent('2')
 const details = screen.getByRole('alert', { name: 'Agent warning' }).closest('details')!
 details.open = true
 fireEvent(details, new Event('toggle', { bubbles: true }))
 expect(onOpen).toHaveBeenLastCalledWith(true)
 rerender(<FreshAgentNoticeStack notices={[]} errors={[{ id: 'create', summary: 'Agent could not start', content: null }]} />)
 expect(onOpen).toHaveBeenLastCalledWith(false)
 expect(screen.getByRole('img', { name: '1 error' })).toHaveTextContent('1')
 expect(screen.queryByRole('img', { name: '1 error, 1 warning' })).toBeNull()
})
