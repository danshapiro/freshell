import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const useKeyboardInsetMock = vi.hoisted(() => vi.fn(() => 0))
vi.mock('@/hooks/useKeyboardInset', () => ({ useKeyboardInset: useKeyboardInsetMock }))
import AgentChatSettings from '@/components/agent-chat/AgentChatSettings'
import { AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE } from '@/lib/agent-chat-capabilities'

vi.mock('lucide-react', () => ({
  Settings: (props: any) => <svg data-testid="settings-icon" {...props} />,
}))

import AgentChatSettings from '@/components/agent-chat/AgentChatSettings'

describe('AgentChatSettings mobile layout', () => {
  const defaults = {
    model: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
    permissionMode: 'default',
    effort: '',
    showThinking: true,
    showTools: true,
    showTimecodes: false,
    modelOptions: [
      {
        value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
        label: 'Provider default (track latest Opus)',
        description: 'Tracks latest Opus automatically.',
      },
      {
        value: 'opus[1m]',
        label: 'Opus 1M',
        description: 'Long context window.',
      },
    ],
    effortOptions: ['turbo'],
  }

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('renders a full-width bottom sheet on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
    expect(dialog.className).toContain('fixed')
    expect(dialog.className).toContain('inset-x-0')
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('shows capability load failures and retry controls on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    const onRetryCapabilities = vi.fn()

    render(
      <AgentChatSettings
        {...defaults}
        capabilitiesStatus="failed"
        capabilityError={{ message: 'Capability request failed', retryable: true }}
        onRetryCapabilities={onRetryCapabilities}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Capability request failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry model load' }))
    expect(onRetryCapabilities).toHaveBeenCalledTimes(1)
  })

  it('closes when backdrop is pressed on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(screen.queryByRole('dialog', { name: 'Agent chat settings' })).not.toBeInTheDocument()
  })

  it('applies keyboard inset to bottom sheet on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    useKeyboardInsetMock.mockReturnValue(300)

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
    expect(dialog.style.bottom).toBe('300px')
  })

  it('bottom sheet is at bottom:0 when no keyboard is open on mobile', () => {
    ;(globalThis as any).setMobileForTest(true)
    useKeyboardInsetMock.mockReturnValue(0)

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
    expect(dialog.style.bottom).toBe('0px')
  })
})
