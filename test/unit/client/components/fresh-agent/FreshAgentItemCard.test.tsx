import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentItemCard, FreshAgentDelegationBlock, FreshAgentOpenSessionContext, FreshAgentObserveChildContext, FreshAgentToolBlock, stripSystemReminders } from '@/components/fresh-agent/FreshAgentItemCard'
import { formatThoughtDuration } from '@/components/fresh-agent/shared/format-duration'

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

describe('FreshAgentItemCard', () => {
  afterEach(() => cleanup())

  it('shows the actual native sleep duration in the activity preview', () => {
    render(<FreshAgentItemCard item={{ id: 'sleep', kind: 'dynamic_tool', tool: 'Sleep', status: 'completed', arguments: { durationMs: 1250 } }} />)
    expect(screen.getByText('1250 ms')).toBeVisible()
  })

  it('keeps each collaboration receiver outcome and selects its exact child without a resume action', () => {
    const onObserve = vi.fn(), openSession = vi.fn()
    const parent = { parentSessionId: 'parent', provider: 'codex', sessionType: 'freshcodex', observedEpoch: 8, observedGeneration: 9 } as const
    render(<FreshAgentOpenSessionContext.Provider value={openSession}><FreshAgentObserveChildContext.Provider value={{ parent, onObserve }}><FreshAgentItemCard item={{ id: 'collab', kind: 'collab_agent', tool: 'wait', status: 'completed', senderThreadId: 'parent', receiverThreadIds: ['child-one', 'child-two'], agentsStates: { 'child-one': { status: 'completed', result: 'First result', model: 'first-model' }, 'child-two': { status: 'failed', error: 'Second error', model: 'second-model' } } }} /></FreshAgentObserveChildContext.Provider></FreshAgentOpenSessionContext.Provider>)
    expect(screen.getByText(/First result/)).toHaveTextContent('first-model')
    expect(screen.getByText(/Second error/)).toHaveTextContent('second-model')
    fireEvent.click(screen.getByRole('button', { name: 'Observe child child-two' }))
    expect(onObserve).toHaveBeenCalledWith({ type: 'observe-child', parent, childThreadId: 'child-two' })
    expect(openSession).not.toHaveBeenCalled()
  })

  it('renders saved native choices and keeps image output accessible through authenticated file links', () => {
    render(<><FreshAgentItemCard item={{ id: 'choices', kind: 'text', text: 'Choose next', extensions: { codex: { phase: 'commentary', questions: [{ title: 'Next step?', options: ['Inspect', 'Verify'] }] } } }} /><FreshAgentItemCard item={{ id: 'image', kind: 'image_generation', status: 'completed', result: 'native-result', savedPath: '/tmp/generated output.png' }} /></>)
    expect(screen.getByText('Next step?')).toBeVisible()
    expect(screen.getByText('Inspect')).toBeVisible()
    expect(screen.getByText('Verify')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'ImageGeneration tool call' }))
    expect(screen.getByRole('link', { name: '/tmp/generated output.png' })).toHaveAttribute('href', '/api/files/raw?path=%2Ftmp%2Fgenerated%20output.png')
  })

  it('renders a declined command as declined rather than completed', () => {
    render(<FreshAgentItemCard item={{ id: 'cmd-denied', kind: 'command', command: 'touch blocked', status: 'declined', output: 'User declined', exitCode: null }} />)
    expect(screen.getByLabelText('declined')).toBeInTheDocument()
    expect(screen.queryByLabelText('complete')).not.toBeInTheDocument()
    expect(screen.getByText(/declined/i)).toBeInTheDocument()
  })

  it('shows native file-change output progress in its tool disclosure', () => {
    render(<FreshAgentItemCard item={{ id: 'files', kind: 'file_change', status: 'running', changes: [], output: 'Applying patch' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit tool call' }))
    expect(screen.getByText('Applying patch')).toBeVisible()
  })

  it('renders markdown text while preserving XSS defenses through the markdown renderer', () => {
    const { container } = render(
      <FreshAgentItemCard
        markdown
        item={{
          id: 'text-1',
          kind: 'text',
          text: '## Result\n\n<script>alert("XSS")</script>\n\n`safe`',
        }}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Result' })).toBeInTheDocument()
    expect(screen.getByText('safe').tagName).toBe('CODE')
    expect(container.querySelector('script')).toBeNull()
  })

  it('strips system reminders before rendering user-visible text', () => {
    expect(stripSystemReminders('Hello\n<system-reminder>secret</system-reminder>\nworld')).toBe('Hello\n\nworld')
  })

  it('renders Bash tool input/output with copy-target data attributes', () => {
    const { container } = render(
      <FreshAgentToolBlock
        initialExpanded
        tool={{
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'npm test' },
          output: 'PASS fresh-agent',
          status: 'complete',
        }}
      />,
    )

    expect(container.querySelector('[data-tool-input]')).toHaveTextContent('npm test')
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent('PASS fresh-agent')
  })

  it('can collapse and expand tool details without losing the preview', () => {
    const { container } = render(
      <FreshAgentToolBlock
        initialExpanded
        tool={{
          id: 'tool-2',
          name: 'Bash',
          input: { command: 'echo collapse' },
          output: 'done',
          status: 'complete',
        }}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Bash tool call' })
    expect(container.querySelector('[data-tool-output]')).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(container.querySelector('[data-tool-output]')).not.toBeInTheDocument()
    expect(screen.getByText(/echo collapse/)).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(container.querySelector('[data-tool-output]')).toBeInTheDocument()
  })

  describe('tool notification polish (5kxd)', () => {
    it('drops the vertical line from the tool block while keeping trigger padding', () => {
      const { container } = render(
        <FreshAgentToolBlock
          tool={{
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'true' },
            status: 'complete',
          }}
        />,
      )
      const toolBlock = container.querySelector('.fresh-agent-tool-block') as HTMLElement
      expect(toolBlock).toBeTruthy()
      expect(toolBlock.className).not.toContain('border-l-2')
      expect(toolBlock.className).not.toContain('border-l-[')
      const trigger = screen.getByRole('button', { name: 'Bash tool call' })
      expect(trigger.className).toContain('px-2')
    })

    it('preserves error state on the tool block without the vertical line', () => {
      const { container } = render(
        <FreshAgentToolBlock
          tool={{
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'false' },
            output: 'boom',
            isError: true,
            status: 'complete',
          }}
        />,
      )
      const toolBlock = container.querySelector('.fresh-agent-tool-block') as HTMLElement
      expect(toolBlock).toBeTruthy()
      expect(toolBlock.className).not.toContain('border-l-')
      expect(screen.getByLabelText('error')).toBeInTheDocument()
      const summary = screen.getByText('(error)')
      expect(summary.className).toContain('text-destructive')
    })

    it('drops the vertical line from the thinking disclosure', () => {
      const { container } = render(
        <FreshAgentItemCard
          item={{ id: 'think-1', kind: 'thinking', text: 'a thought' }}
        />,
      )
      const disclosure = container.querySelector('.fresh-agent-thinking-details') as HTMLElement
      expect(disclosure).toBeTruthy()
      expect(disclosure.className).not.toContain('border-l-2')
      expect(disclosure.className).not.toContain('border-l-[')
    })

    it('drops the vertical line from the tool result card', () => {
      const { container } = render(
        <FreshAgentItemCard
          item={{ id: 'result-1', kind: 'tool_result', content: 'ok', isError: false }}
        />,
      )
      const card = container.querySelector('.fresh-agent-tool-result') as HTMLElement
      expect(card).toBeTruthy()
      expect(card.className).not.toContain('border-l-2')
      expect(card.className).not.toContain('border-l-')
      expect(card.className).toContain('px-2')
    })
  })

  it('renders the persisted opencode tool error text for a failed dynamic_tool', () => {
    const { container } = render(
      <FreshAgentItemCard
        item={{
          id: 'tool-err',
          kind: 'dynamic_tool',
          namespace: 'opencode',
          tool: 'bash',
          status: 'failed',
          arguments: { command: 'false' },
          contentItems: null,
          success: null,
          error: 'The user has specified a rule which prevents you from using this specific tool call.',
        }}
      />,
    )

    expect(screen.getByLabelText('error')).toBeInTheDocument()
    expect(screen.getByText('(error)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'opencode.bash tool call' }))
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent(
      'The user has specified a rule which prevents you from using this specific tool call.',
    )
  })

  it('keeps rendering contentItems for a dynamic_tool without a persisted error (regression)', () => {
    const { container } = render(
      <FreshAgentItemCard
        item={{
          id: 'tool-ok',
          kind: 'dynamic_tool',
          namespace: 'opencode',
          tool: 'bash',
          status: 'completed',
          arguments: { command: 'true' },
          contentItems: ['PASS'],
          success: true,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'opencode.bash tool call' }))
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent('PASS')
  })
})

const longTaskResult = Array.from({ length: 30 }, (_, i) => `line ${i + 1}: harness output sample`).join('\n')

const delegationItem = {
  id: 'part_t1',
  kind: 'task_delegation' as const,
  status: 'running' as const,
  title: 'General Task — Fix the flaky harness',
  description: 'Fix the flaky harness',
  subagent: 'general',
  childSessionId: 'ses_child_1',
  durationMs: 1755761,
  activity: [
    { tool: 'bash', status: 'completed' as const, preview: 'sed -n 92,112p src/store/paneTypes.ts' },
    { tool: 'grep', status: 'failed' as const, preview: 'reasoningEffort' },
    { tool: 'read', status: 'running' as const, preview: 'src/index.css' },
  ],
  result: longTaskResult,
}

describe('task_delegation rendering', () => {
  afterEach(() => cleanup())

  it('renders the delegation header with title, duration and running spinner', () => {
    render(<FreshAgentDelegationBlock item={delegationItem} />)
    expect(screen.getByText('General Task — Fix the flaky harness')).toBeInTheDocument()
    expect(screen.getByText('29m 16s')).toBeInTheDocument() // formatThoughtDuration(1755761)
    expect(screen.getByLabelText('running')).toBeInTheDocument()
  })

  it('renders nested child rows with title-cased tool labels and (failed) on errors', () => {
    render(<FreshAgentDelegationBlock item={delegationItem} />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('Grep')).toBeInTheDocument()
    expect(screen.getByText(/sed -n 92,112p src\/store\/paneTypes\.ts/)).toBeInTheDocument()
    expect(screen.getByText('(failed)')).toBeInTheDocument()
  })

  it('renders the clamped task result: full content in a bounded, scrollable box', () => {
    render(<FreshAgentDelegationBlock item={delegationItem} />)
    const result = screen.getByTestId('fresh-agent-delegation-result')
    // Content-presence: the LAST line proves the whole result body is carried…
    expect(result).toHaveTextContent('line 30: harness output sample')
    // …and the clamp classes prove the box is bounded + scrollable.
    expect(result.className).toContain('max-h-24')
    expect(result.className).toContain('overflow-y-auto')
  })

  it('renders an Open session button that calls the context handler with the child session', () => {
    const openSession = vi.fn()
    render(
      <FreshAgentOpenSessionContext.Provider value={openSession}>
        <FreshAgentDelegationBlock item={delegationItem} />
      </FreshAgentOpenSessionContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /open session/i }))
    expect(openSession).toHaveBeenCalledWith('ses_child_1', 'Fix the flaky harness')
  })

  it('omits the Open session button without a child session id', () => {
    render(<FreshAgentDelegationBlock item={{ ...delegationItem, childSessionId: undefined }} />)
    expect(screen.queryByRole('button', { name: /open session/i })).not.toBeInTheDocument()
  })

  it('shows completed check and failed cross statuses', () => {
    const { rerender } = render(<FreshAgentDelegationBlock item={delegationItem} />)
    rerender(<FreshAgentDelegationBlock item={{ ...delegationItem, status: 'completed' }} />)
    expect(screen.getByLabelText('complete')).toBeInTheDocument()
    rerender(<FreshAgentDelegationBlock item={{ ...delegationItem, status: 'failed' }} />)
    expect(screen.getByLabelText('error')).toBeInTheDocument()
  })
})

describe('retry rendering', () => {
  afterEach(() => cleanup())

  it('renders a muted retry row with attempt and error text', () => {
    render(<FreshAgentItemCard item={{ id: 'rr', kind: 'retry', attempt: 2, error: 'stream disconnected' }} />)
    expect(screen.getByTestId('fresh-agent-retry-row')).toHaveTextContent('Retrying (attempt 2) — stream disconnected')
  })
})

describe('delegated_task rendering', () => {
  afterEach(() => cleanup())

  it('renders a one-line muted caption with the title-cased agent', () => {
    render(<FreshAgentItemCard item={{ id: 's1', kind: 'delegated_task', agent: 'general', description: 'Fix the flaky harness' }} />)
    expect(screen.getByTestId('fresh-agent-delegated-task')).toHaveTextContent('Delegated — General · Fix the flaky harness')
  })
})

describe('FreshAgentToolBlock previewOverride', () => {
  afterEach(() => cleanup())

  it('prefers previewOverride over the input-derived preview', () => {
    render(
      <FreshAgentToolBlock
        tool={{
          id: 'tool-override-1',
          name: 'Task',
          input: { command: 'ignored raw input' },
          previewOverride: 'General Task — Fix the flaky harness',
          status: 'complete',
        }}
      />,
    )
    expect(screen.getByText('General Task — Fix the flaky harness')).toBeInTheDocument()
    expect(screen.queryByText(/ignored raw input/)).not.toBeInTheDocument()
  })
})

describe('formatThoughtDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatThoughtDuration(1831)).toBe('1.8s')
    expect(formatThoughtDuration(3400)).toBe('3.4s')
    expect(formatThoughtDuration(61_000)).toBe('1m 1s')
    expect(formatThoughtDuration(3_720_000)).toBe('1h 2m')
  })
})
