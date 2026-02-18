import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FreshclaudeSettings from '@/components/claude-chat/FreshclaudeSettings'

vi.mock('lucide-react', () => ({
  Settings: (props: any) => <svg data-testid="settings-icon" {...props} />,
}))

describe('FreshclaudeSettings mobile layout', () => {
  const defaults = {
    model: 'claude-opus-4-6',
    permissionMode: 'default',
    effort: 'high',
    showThinking: true,
    showTools: true,
    showTimecodes: false,
  }

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('renders a full-width bottom sheet on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)

    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'freshclaude settings' })
    expect(dialog.className).toContain('fixed')
    expect(dialog.className).toContain('inset-x-0')
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('closes when backdrop is pressed on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)

    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(screen.queryByRole('dialog', { name: 'freshclaude settings' })).not.toBeInTheDocument()
  })
})
