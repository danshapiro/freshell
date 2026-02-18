import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PermissionBanner from '../../../../../src/components/claude-chat/PermissionBanner'

describe('PermissionBanner', () => {
  afterEach(() => {
    cleanup()
  })
  const basePermission = {
    requestId: 'perm-1',
    subtype: 'can_use_tool',
    tool: { name: 'Bash', input: { command: 'rm -rf /tmp/test' } },
  }

  it('renders permission request with tool info', () => {
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={() => {}}
        onDeny={() => {}}
      />
    )
    expect(screen.getByText(/Permission requested: Bash/)).toBeInTheDocument()
    expect(screen.getByText(/rm -rf \/tmp\/test/)).toBeInTheDocument()
  })

  it('calls onAllow when Allow is clicked', async () => {
    const onAllow = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={onAllow}
        onDeny={() => {}}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Allow tool use' }))
    expect(onAllow).toHaveBeenCalledOnce()
  })

  it('calls onDeny when Deny is clicked', async () => {
    const onDeny = vi.fn()
    const user = userEvent.setup()
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={() => {}}
        onDeny={onDeny}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Deny tool use' }))
    expect(onDeny).toHaveBeenCalledOnce()
  })

  it('disables buttons when disabled prop is true', () => {
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={() => {}}
        onDeny={() => {}}
        disabled
      />
    )
    expect(screen.getByRole('button', { name: 'Allow tool use' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny tool use' })).toBeDisabled()
  })
})
