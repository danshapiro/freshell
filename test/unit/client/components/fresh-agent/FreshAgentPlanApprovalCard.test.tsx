import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FreshAgentPlanApprovalCard } from '@/components/fresh-agent/FreshAgentPlanApprovalCard'
import { FreshAgentApprovalCard } from '@/components/fresh-agent/FreshAgentApprovalCard'

// The real markdown renderer, loaded eagerly (production loads it lazily).
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return { LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} /> }
})

// Client-alerts plan G20 (D9): ExitPlanMode is reviewed as a plan, not as a
// tool call: the plan renders as markdown, and each choice is its exact
// decision (decision D4 names the four choices).

const PLAN = '# Ship the parser\n\n1. Edit `parser.ts`\n2. Run the tests'
const PLAN_FILE = '/home/me/.claude/plans/ship-the-parser.md'

function renderPlan(input: Record<string, unknown>, disabled = false) {
  const onRespond = vi.fn()
  render(<FreshAgentPlanApprovalCard approval={{ requestId: 'plan-1', toolName: 'ExitPlanMode', input }} disabled={disabled} onRespond={onRespond} />)
  return { onRespond, card: screen.getByRole('alert', { name: 'Plan approval request' }) }
}

describe('FreshAgentPlanApprovalCard', () => {
  afterEach(() => cleanup())

  it('renders the plan as markdown and shows where the CLI saved it', () => {
    const { card } = renderPlan({ plan: PLAN, planFilePath: PLAN_FILE })

    expect(within(card).getByRole('heading', { name: 'Ship the parser' })).toBeInTheDocument()
    expect(within(card).getByText('parser.ts').tagName).toBe('CODE')
    expect(card).toHaveTextContent(PLAN_FILE)
  })

  it.each([
    ['Approve plan', { behavior: 'allow' }],
    ['Approve and auto-accept edits', { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }],
    ['Approve and stop asking for permission', { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }],
  ])('"%s" sends its exact decision', (name, decision) => {
    const { onRespond } = renderPlan({ plan: PLAN })

    fireEvent.click(screen.getByRole('button', { name }))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith(decision)
  })

  it('"Keep planning" sends the note as the reason, or the default reason without one', () => {
    const { onRespond } = renderPlan({ plan: PLAN })

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change? (optional)' }), { target: { value: 'Split step 2 into two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))
    expect(onRespond.mock.calls).toEqual([
      [{ behavior: 'deny', message: 'The user wants to keep planning.', interrupt: false }],
      [{ behavior: 'deny', message: 'Split step 2 into two', interrupt: false }],
    ])
  })

  it('a request with no plan says so and can still be answered', () => {
    const { card, onRespond } = renderPlan({})

    expect(card).toHaveTextContent(/no plan text was provided/i)
    expect(within(card).queryByRole('heading')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))
    expect(onRespond).toHaveBeenCalledTimes(1)
  })

  it('every choice is a 44 px touch target, and all of them are disabled while the pane has no session', () => {
    renderPlan({ plan: PLAN }, true)

    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Approve plan', 'Approve and auto-accept edits', 'Approve and stop asking for permission', 'Keep planning',
    ])
    for (const button of buttons) {
      expect(button).toBeDisabled()
      expect(button).toHaveClass('min-h-[2.75rem]')
    }
    expect(screen.getByRole('textbox', { name: 'What should change? (optional)' })).toBeDisabled()
  })

  it('the approval card hands an ExitPlanMode request to the plan card', () => {
    const onRespond = vi.fn()
    render(<FreshAgentApprovalCard approval={{ requestId: 'plan-2', toolName: 'ExitPlanMode', input: { plan: PLAN } }} onRespond={onRespond} />)

    expect(screen.getByRole('alert', { name: 'Plan approval request' })).toBeInTheDocument()
    expect(screen.queryByRole('alert', { name: /permission request/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow tool use' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow' })
  })
})
