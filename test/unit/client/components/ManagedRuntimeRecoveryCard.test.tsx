import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedRuntimeRecoverySummary } from '@shared/managed-runtime'
import { ManagedRuntimeRecoveryCard } from '@/components/ManagedRuntimeRecoveryCard'

function summary(recoveryState: ManagedRuntimeRecoverySummary['recoveryState']): ManagedRuntimeRecoverySummary {
  return {
    desiredState: recoveryState === 'stopped' ? 'stopped' : 'running',
    recoveryState,
    durabilityState: 'resume_captured',
    allocationState: 'verified_durable',
  }
}

describe('ManagedRuntimeRecoveryCard', () => {
  afterEach(() => cleanup())

  it.each(['live', 'recovering', 'stopped'] as const)('renders nothing for %s recovery', (recoveryState) => {
    render(
      <ManagedRuntimeRecoveryCard
        recoverySummary={summary(recoveryState)}
        onRetry={vi.fn()}
        onStartFresh={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('managed-runtime-recovery-card')).not.toBeInTheDocument()
  })

  it('renders one amber blocked alert and retries the same recovery', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined)
    render(
      <ManagedRuntimeRecoveryCard
        recoverySummary={{ ...summary('blocked'), reason: 'STORE_UNREADABLE' }}
        onRetry={onRetry}
        onStartFresh={vi.fn()}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Check that the saved conversation store is readable, then retry recovery.')
    expect(alert).toHaveClass('border-amber-500/50', 'bg-amber-500/10')
    expect(screen.getByRole('button', { name: 'Retry recovery' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  })

  it('explains exhausted automatic attempts and allows explicit recovery of the retained conversation', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined)
    const onStartFresh = vi.fn()
    render(<ManagedRuntimeRecoveryCard recoverySummary={{ ...summary('blocked'), reason: 'BLOCKED_RETRY_BUDGET' }}
      onRetry={onRetry} onStartFresh={onStartFresh} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Automatic recovery attempts have been exhausted.')
    expect(screen.getByRole('alert')).not.toHaveTextContent('BLOCKED_RETRY_BUDGET')
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
    expect(onStartFresh).not.toHaveBeenCalled()
  })

  it('keeps the blocked alert and reports retry failures in the same card', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('Provider is unavailable'))
    render(
      <ManagedRuntimeRecoveryCard
        recoverySummary={summary('blocked')}
        onRetry={onRetry}
        onStartFresh={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Provider is unavailable')
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('renders neutral lost copy and waits for an explicit start-new click', () => {
    const onStartFresh = vi.fn()
    render(
      <ManagedRuntimeRecoveryCard
        recoverySummary={summary('lost')}
        onRetry={vi.fn()}
        onStartFresh={onStartFresh}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be recovered/i)
    expect(screen.getByRole('button', { name: 'Start new conversation' })).toBeInTheDocument()
    expect(onStartFresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    expect(onStartFresh).toHaveBeenCalledTimes(1)
  })

  it('waits for start-new cleanup and reports failures in the lost card', async () => {
    let reject!: (error: Error) => void
    const onStartFresh = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise }))
    render(<ManagedRuntimeRecoveryCard recoverySummary={summary('lost')} onRetry={vi.fn()} onStartFresh={onStartFresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Starting…' }))
    expect(onStartFresh).toHaveBeenCalledTimes(1)

    reject(new Error('Cleanup could not be confirmed. Your conversation has been kept. Try again.'))
    expect(await screen.findByRole('status')).toHaveTextContent('Your conversation has been kept')
    expect(screen.getByRole('button', { name: 'Start new conversation' })).toBeEnabled()
  })
})
