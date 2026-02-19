import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from '@/components/ui/error-boundary'

beforeEach(() => {
  ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
})

afterEach(() => {
  cleanup()
})

function ProblemChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test explosion')
  }
  return <div>Healthy child</div>
}

describe('ErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    const { container } = render(
      <ErrorBoundary>
        <div>All good</div>
      </ErrorBoundary>
    )

    expect(within(container).getByText('All good')).toBeInTheDocument()
    expect(within(container).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows fallback UI when a child throws', () => {
    const { container } = render(
      <ErrorBoundary label="Terminal">
        <ProblemChild shouldThrow />
      </ErrorBoundary>
    )

    expect(within(container).getByRole('alert')).toBeInTheDocument()
    expect(within(container).getByText('Something went wrong')).toBeInTheDocument()
    expect(within(container).getByText(/Terminal encountered an error/)).toBeInTheDocument()
    expect(within(container).getByText('Try Again')).toBeInTheDocument()
  })

  it('uses default label when none is provided', () => {
    const { container } = render(
      <ErrorBoundary>
        <ProblemChild shouldThrow />
      </ErrorBoundary>
    )

    expect(within(container).getByText(/This section encountered an error/)).toBeInTheDocument()
  })

  it('resets error state when Try Again is clicked', async () => {
    const user = userEvent.setup()
    let shouldThrow = true
    function ToggleChild() {
      if (shouldThrow) throw new Error('Boom')
      return <div>Recovered</div>
    }

    const { container, rerender } = render(
      <ErrorBoundary>
        <ToggleChild />
      </ErrorBoundary>
    )

    expect(within(container).getByRole('alert')).toBeInTheDocument()

    shouldThrow = false
    await user.click(within(container).getByRole('button', { name: 'Try Again' }))
    rerender(
      <ErrorBoundary>
        <ToggleChild />
      </ErrorBoundary>
    )

    expect(within(container).getByText('Recovered')).toBeInTheDocument()
    expect(within(container).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('logs a labeled error in componentDidCatch', () => {
    const errorSpy = vi.spyOn(console, 'error')
    render(
      <ErrorBoundary label="Settings">
        <ProblemChild shouldThrow />
      </ErrorBoundary>
    )

    const ourLog = errorSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('[ErrorBoundary: Settings]')
    )
    expect(ourLog).toBeDefined()
    expect(ourLog?.[1]).toBeInstanceOf(Error)
    expect((ourLog?.[1] as Error).message).toBe('Test explosion')
  })

  it('renders Go to Overview button only when onNavigate exists', () => {
    const { rerender } = render(
      <ErrorBoundary onNavigate={() => {}}>
        <ProblemChild shouldThrow />
      </ErrorBoundary>
    )
    expect(screen.getByRole('button', { name: 'Go to Overview' })).toBeInTheDocument()

    rerender(
      <ErrorBoundary>
        <ProblemChild shouldThrow />
      </ErrorBoundary>
    )
    expect(screen.queryByRole('button', { name: 'Go to Overview' })).not.toBeInTheDocument()
  })

  it('calls onNavigate when Go to Overview is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <ErrorBoundary onNavigate={onNavigate}>
        <ProblemChild shouldThrow />
      </ErrorBoundary>
    )

    await user.click(screen.getByRole('button', { name: 'Go to Overview' }))
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})
