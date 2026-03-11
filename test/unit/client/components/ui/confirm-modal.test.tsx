import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfirmModal } from '@/components/ui/confirm-modal'

describe('ConfirmModal', () => {
  it('defaults the confirm button to destructive styling', () => {
    render(
      <ConfirmModal
        open
        title="Delete session"
        body="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-destructive')
  })

  it('renders a non-destructive primary button when confirmVariant is default', () => {
    render(
      <ConfirmModal
        open
        title="Administrator approval required"
        body="To complete this, you will need to accept the Windows administrator prompt on the next screen."
        confirmLabel="Continue"
        confirmVariant="default"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('bg-primary')
  })
})
