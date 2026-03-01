import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExtensionError from '@/components/panes/ExtensionError'

afterEach(() => cleanup())

describe('ExtensionError', () => {
  it('renders "Extension not available" heading', () => {
    render(<ExtensionError name="test-ext" />)
    expect(screen.getByText('Extension not available')).toBeInTheDocument()
  })

  it('shows default message with extension name when no message prop', () => {
    render(<ExtensionError name="my-widget" />)
    expect(
      screen.getByText('Extension "my-widget" is not installed or failed to load.'),
    ).toBeInTheDocument()
  })

  it('shows custom message when message prop provided', () => {
    render(<ExtensionError name="my-widget" message="Something went wrong" />)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(
      screen.queryByText(/is not installed or failed to load/),
    ).not.toBeInTheDocument()
  })

  it('renders retry button when onRetry provided', () => {
    render(<ExtensionError name="test-ext" onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not render retry button when onRetry omitted', () => {
    render(<ExtensionError name="test-ext" />)
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('calls onRetry when button clicked', async () => {
    const onRetry = vi.fn()
    render(<ExtensionError name="test-ext" onRetry={onRetry} />)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onRetry).toHaveBeenCalledOnce()
  })
})
