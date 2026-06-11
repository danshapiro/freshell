import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentApprovalCard } from '@/components/fresh-agent/FreshAgentApprovalCard'
import { attachmentRejection } from '@/components/fresh-agent/FreshAgentComposer'

describe('FreshAgentApprovalCard', () => {
  afterEach(() => cleanup())

  it('previews the exact Bash command being approved', () => {
    render(
      <FreshAgentApprovalCard
        approval={{
          requestId: 'req-1',
          toolName: 'Bash',
          input: { command: 'git push origin main' },
        }}
        onAllow={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert', { name: 'Permission request for Bash' })).toBeInTheDocument()
    expect(screen.getByText('git push origin main')).toBeInTheDocument()
  })

  it('previews Edit approvals as a diff', () => {
    render(
      <FreshAgentApprovalCard
        approval={{
          requestId: 'req-2',
          toolName: 'Edit',
          input: { file_path: 'a.ts', old_string: 'old line', new_string: 'new line' },
        }}
        onAllow={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )

    expect(screen.getByRole('figure', { name: 'diff view' })).toHaveAttribute('data-file-path', 'a.ts')
  })

  it('wires allow / always-allow / deny', () => {
    const onAllow = vi.fn()
    const onAlwaysAllow = vi.fn()
    const onDeny = vi.fn()
    render(
      <FreshAgentApprovalCard
        approval={{ requestId: 'req-3', toolName: 'Bash', input: { command: 'ls' } }}
        onAllow={onAllow}
        onAlwaysAllow={onAlwaysAllow}
        onDeny={onDeny}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Allow tool use' }))
    fireEvent.click(screen.getByRole('button', { name: 'Always allow Bash this session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny tool use' }))
    expect(onAllow).toHaveBeenCalledTimes(1)
    expect(onAlwaysAllow).toHaveBeenCalledWith('Bash')
    expect(onDeny).toHaveBeenCalledTimes(1)
  })
})

describe('attachmentRejection', () => {
  it('always allows textual files and images', () => {
    expect(attachmentRejection('codex', 'notes.md')).toBeNull()
    expect(attachmentRejection('opencode', 'data.csv')).toBeNull()
    expect(attachmentRejection('claude', 'shot.png')).toBeNull()
    expect(attachmentRejection('codex', 'shot.jpeg')).toBeNull()
  })

  it('allows pdf only for claude', () => {
    expect(attachmentRejection('claude', 'spec.pdf')).toBeNull()
    expect(attachmentRejection('codex', 'spec.pdf')).toMatch(/can’t read \.pdf/)
  })

  it('rejects unsupported media with a actionable message', () => {
    expect(attachmentRejection('claude', 'demo.mov')).toMatch(/isn’t supported/)
    expect(attachmentRejection('codex', 'song.mp3')).toMatch(/isn’t supported/)
  })
})
