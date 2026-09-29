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
        recoverySummary={summary('blocked')}
        onRetry={onRetry}
        onStartFresh={vi.fn()}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveClass('border-amber-500/50', 'bg-amber-500/10')
    expect(screen.getByRole('button', { name: 'Retry recovery' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
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
})
