import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import AgentChatSettings from '@/components/agent-chat/AgentChatSettings'
import { AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE } from '@/lib/agent-chat-capabilities'

vi.mock('lucide-react', () => ({
  Settings: (props: any) => <svg data-testid="settings-icon" {...props} />,
}))

const MODEL_OPTIONS = [
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
  {
    value: 'haiku',
    label: 'Haiku',
    description: 'Fast path.',
  },
]

describe('AgentChatSettings', () => {
  afterEach(cleanup)

  const defaults = {
    model: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
    permissionMode: 'default',
    effort: '',
    showThinking: true,
    showTools: true,
    showTimecodes: false,
    modelOptions: MODEL_OPTIONS,
    effortOptions: ['turbo', 'warp'],
  }

  it('renders the settings gear button', () => {
    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders provider-default plus live capability rows only', () => {
    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    const modelSelect = screen.getByLabelText('Model')
    const labels = Array.from(modelSelect.querySelectorAll('option')).map((option) => option.textContent)

    expect(labels).toEqual([
      'Provider default (track latest Opus)',
      'Opus 1M',
      'Haiku',
    ])
    expect(screen.getByText('Tracks latest Opus automatically.')).toBeInTheDocument()
    expect(screen.queryByText('Opus 4.6')).not.toBeInTheDocument()
    expect(screen.queryByText('Sonnet 4.6')).not.toBeInTheDocument()
  })

  it('keeps an unavailable exact model visible and selected until the user changes it', () => {
    render(
      <AgentChatSettings
        {...defaults}
        model="claude-opus-4-6"
        modelOptions={[
          ...MODEL_OPTIONS,
          {
            value: 'claude-opus-4-6',
            label: 'claude-opus-4-6 (Unavailable)',
            description: 'Saved legacy model is no longer available.',
            unavailable: true,
          },
        ]}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement
    expect(modelSelect.value).toBe('claude-opus-4-6')
    expect(screen.getByRole('option', { name: 'claude-opus-4-6 (Unavailable)' })).toBeInTheDocument()
    expect(screen.getByText('Saved legacy model is no longer available.')).toBeInTheDocument()
  })

  it('renders effort choices from the selected capability payload only', () => {
    render(
      <AgentChatSettings
        {...defaults}
        model="opus[1m]"
        effortOptions={['turbo', 'warp']}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    const effortSelect = screen.getByLabelText('Effort')
    const labels = Array.from(effortSelect.querySelectorAll('option')).map((option) => option.textContent)

    expect(labels).toEqual(['Model default', 'turbo', 'warp'])
    expect(screen.queryByRole('option', { name: 'Low' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument()
  })

  it('hides the effort selector when the selected model does not support effort', () => {
    render(
      <AgentChatSettings
        {...defaults}
        model="haiku"
        effortOptions={[]}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument()
    expect(screen.getByText('This model uses its own default effort behavior.')).toBeInTheDocument()
  })

  it('shows an explicit loading state while capabilities are loading', () => {
    render(
      <AgentChatSettings
        {...defaults}
        capabilitiesStatus="loading"
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Loading available models...')
  })

  it('shows a retryable error state when capability loading fails', () => {
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

  it('hides stale capability-driven controls when capability loading fails after a prior success', () => {
    render(
      <AgentChatSettings
        {...defaults}
        capabilitiesStatus="failed"
        capabilityError={{ message: 'Capability request failed', retryable: true }}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Capability request failed')
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument()
    expect(screen.queryByText('Opus 1M')).not.toBeInTheDocument()
    expect(screen.queryByText('This model uses its own default effort behavior.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Permissions')).toBeInTheDocument()
  })

  it('allows model and permission changes mid-session while keeping effort read-only', () => {
    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={true}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Model')).not.toBeDisabled()
    expect(screen.getByLabelText('Permissions')).not.toBeDisabled()
    expect(screen.getByLabelText('Effort')).toBeDisabled()
  })

  it('calls onChange when a display toggle is changed', () => {
    const onChange = vi.fn()

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('switch', { name: /show timecodes/i }))
    expect(onChange).toHaveBeenCalledWith({ showTimecodes: true })
  })

  it('calls onChange when model is changed', () => {
    const onChange = vi.fn()

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus[1m]' } })
    expect(onChange).toHaveBeenCalledWith({ model: 'opus[1m]' })
  })

  it('calls onChange when provider-default is selected', () => {
    const onChange = vi.fn()

    render(
      <AgentChatSettings
        {...defaults}
        model="opus[1m]"
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE },
    })
    expect(onChange).toHaveBeenCalledWith({ model: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE })
  })

  it('opens automatically when defaultOpen is true', () => {
    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Model')).toBeInTheDocument()
  })

  it('closes popover on Escape key', () => {
    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Model')).not.toBeInTheDocument()
  })

  it('calls onDismiss when closed', () => {
    const onDismiss = vi.fn()

    render(
      <AgentChatSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
