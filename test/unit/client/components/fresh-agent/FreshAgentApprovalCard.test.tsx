import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FreshAgentApprovalCard } from '@/components/fresh-agent/FreshAgentApprovalCard'
import type { FreshAgentPendingApproval } from '@shared/fresh-agent-contract'

const NPM_RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' } as const
const READ_RULE = { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//etc/**' }], behavior: 'allow', destination: 'session' } as const
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' } as const
const SRV_DIRECTORY = { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' } as const

function renderCard(approval: FreshAgentPendingApproval, extra: { onAlwaysAllow?: (toolName: string) => void } = {}) {
  const onRespond = vi.fn()
  render(<FreshAgentApprovalCard approval={approval} onRespond={onRespond} {...extra} />)
  return { onRespond }
}

describe('FreshAgentApprovalCard', () => {
  afterEach(() => cleanup())

  it('previews the exact Bash command being approved', () => {
    renderCard({ requestId: 'req-1', toolName: 'Bash', input: { command: 'git push origin main' } })

    expect(screen.getByRole('alert', { name: 'Permission request for Bash' })).toBeInTheDocument()
    expect(screen.getByText('git push origin main')).toBeInTheDocument()
  })

  it('previews Edit approvals as a diff', () => {
    renderCard({ requestId: 'req-2', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'old line', new_string: 'new line' } })

    expect(screen.getByRole('figure', { name: 'diff view' })).toHaveAttribute('data-file-path', 'a.ts')
  })

  it('Allow sends a plain allow and Deny a deny that keeps the turn going', () => {
    const { onRespond } = renderCard({ requestId: 'req-3', toolName: 'Bash', input: { command: 'ls' } })

    fireEvent.click(screen.getByRole('button', { name: 'Allow tool use' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny tool use' }))
    expect(onRespond.mock.calls).toEqual([
      [{ behavior: 'allow' }],
      [{ behavior: 'deny', message: 'Denied by user', interrupt: false }],
    ])
  })

  it('offers Claude\'s own "don\'t ask again", one plain-language line per suggestion, and sends exactly those suggestions', () => {
    const suggestions = [NPM_RULE, READ_RULE, ACCEPT_EDITS, SRV_DIRECTORY]
    const { onRespond } = renderCard({ requestId: 'req-4', toolName: 'Bash', input: { command: 'npm test' }, suggestions: [...suggestions] })

    const remember = screen.getByRole('button', { name: 'Allow and don\'t ask again' })
    const lines = within(screen.getByRole('list', { name: 'What "Allow and don\'t ask again" saves' })).getAllByRole('listitem')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toHaveTextContent('Bash(npm test *)')
    expect(lines[0]).toHaveTextContent('.claude/settings.local.json')
    expect(lines[1]).toHaveTextContent('Read(//etc/**)')
    expect(lines[1]).not.toHaveTextContent('settings')
    expect(lines[3]).toHaveTextContent('/srv/data')
    expect(remember).toHaveAccessibleDescription(lines.map((line) => line.textContent).join(' '))

    fireEvent.click(remember)
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow', updatedPermissions: suggestions })
  })

  it('a suggestion that only switches to accepting edits names the button for it', () => {
    renderCard({ requestId: 'req-5', toolName: 'Write', input: { file_path: 'a.ts', content: 'x' }, suggestions: [ACCEPT_EDITS] })

    expect(screen.getByRole('button', { name: 'Allow and auto-accept edits' })).toBeInTheDocument()
  })

  it('offers no remember button when the CLI suggested nothing', () => {
    renderCard({ requestId: 'req-6', toolName: 'Bash', input: { command: 'ls /' }, blockedPath: '/' })

    expect(screen.queryByRole('button', { name: /don't ask again|auto-accept/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('the pane-only "always allow" exists only when the caller provides it, says it lasts until the pane reloads, and reports the tool', () => {
    renderCard({ requestId: 'req-7', toolName: 'Bash', input: { command: 'ls' } })
    expect(screen.queryByRole('button', { name: /always allow/i })).not.toBeInTheDocument()
    cleanup()

    const onAlwaysAllow = vi.fn()
    const { onRespond } = renderCard({ requestId: 'req-8', toolName: 'Bash', input: { command: 'ls' } }, { onAlwaysAllow })
    const button = screen.getByRole('button', { name: 'Always allow Bash in this pane' })
    expect(button).toHaveAttribute('title', 'Until this pane reloads')
    fireEvent.click(button)
    expect(onAlwaysAllow).toHaveBeenCalledWith('Bash')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('every action is disabled while the pane has no session', () => {
    render(<FreshAgentApprovalCard
      approval={{ requestId: 'req-9', toolName: 'Bash', input: { command: 'pwd' }, suggestions: [NPM_RULE] }}
      disabled
      onRespond={vi.fn()}
      onAlwaysAllow={vi.fn()}
    />)

    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  })

  it('identifies native stdin writes and sends only the offered native decisions', () => {
    const onAlwaysAllow = vi.fn()
    const { onRespond } = renderCard({
      requestId: 'stdin-approval',
      toolName: 'Bash',
      native: { kind: 'writeStdin', command: 'python interactive.py', availableDecisions: ['accept', 'cancel'] },
    }, { onAlwaysAllow })
    const card = within(screen.getByRole('alert', { name: 'Permission request for Bash' }))

    expect(card.getByText('Write to a running command')).toBeVisible()
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual(['Allow', 'Stop'])
    expect(card.queryByRole('button', { name: /always allow/i })).not.toBeInTheDocument()
    fireEvent.click(card.getByRole('button', { name: 'Allow', exact: true }))
    fireEvent.click(card.getByRole('button', { name: 'Stop', exact: true }))

    expect(onRespond.mock.calls).toEqual([[{ nativeDecision: 'accept' }], [{ nativeDecision: 'cancel' }]])
    expect(onAlwaysAllow).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'permissions',
      toolName: 'Additional permissions',
      details: { permissions: { fileSystem: { entries: [
        { path: { type: 'path', path: '/srv/reports' }, access: 'read' },
        { path: { type: 'path', path: '/srv/output' }, access: 'write' },
      ] }, network: { enabled: true } } },
      offered: ['accept', 'decline'],
      actions: [{ label: 'Allow', decision: 'accept' }, { label: 'Decline', decision: 'decline' }],
    },
    {
      name: 'additionalPermissions',
      toolName: 'Bash',
      details: { additionalPermissions: { fileSystem: { entries: [
        { path: { type: 'path', path: '/var/cache/build' }, access: 'write' },
        { path: { type: 'glob_pattern', pattern: '/srv/private/**' }, access: 'deny' },
      ] }, network: { enabled: false } } },
      offered: ['accept', 'cancel', { acceptWithExecpolicyAmendment: { execpolicyAmendment: ['build'] } }],
      actions: [{ label: 'Allow', decision: 'accept' }, { label: 'Stop', decision: 'cancel' }],
    },
    {
      name: 'grantRoot',
      toolName: 'Edit',
      details: { path: '/srv/generated' },
      offered: ['acceptForSession', 'decline'],
      actions: [{ label: 'Allow for this session', decision: 'acceptForSession' }, { label: 'Decline', decision: 'decline' }],
    },
  ])('renders requested $name details and preserves native action callbacks', ({ name, toolName, details, offered, actions }) => {
    const onAlwaysAllow = vi.fn()
    const nativeDetails = name === 'grantRoot' ? { grantRoot: details.path } : details
    const { onRespond } = renderCard({
      requestId: `detail-${name}`,
      toolName,
      native: { ...nativeDetails, availableDecisions: offered },
    }, { onAlwaysAllow })
    const card = within(screen.getByRole('alert', { name: `Permission request for ${toolName}` }))
    const preview = card.getByText((_content, element) => element?.tagName === 'PRE')

    expect(preview).toBeVisible()
    expect(JSON.parse(preview.textContent ?? '')).toEqual(details)
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual(actions.map((action) => action.label))
    expect(card.queryByRole('button', { name: /always allow/i })).not.toBeInTheDocument()
    for (const action of actions) fireEvent.click(card.getByRole('button', { name: action.label, exact: true }))

    expect(onRespond.mock.calls).toEqual(actions.map((action) => [{ nativeDecision: action.decision }]))
    expect(onAlwaysAllow).not.toHaveBeenCalled()
  })

})
