import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import PermissionBanner from '@/components/agent-chat/PermissionBanner'

describe('PermissionBanner mobile touch targets', () => {
  const basePermission = {
    requestId: 'req-1',
    tool: { name: 'Bash', input: { command: 'ls' } },
  }

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('Allow and Deny buttons have min-h-11 on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    const allowBtn = screen.getByRole('button', { name: /allow/i })
    const denyBtn = screen.getByRole('button', { name: /deny/i })
    expect(allowBtn.className).toContain('min-h-11')
    expect(denyBtn.className).toContain('min-h-11')
  })

  it('buttons do not have min-h-11 on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    render(
      <PermissionBanner
        permission={basePermission}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    const allowBtn = screen.getByRole('button', { name: /allow/i })
    expect(allowBtn.className).not.toContain('min-h-11')
  })
})
