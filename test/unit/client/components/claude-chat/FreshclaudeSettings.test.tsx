import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import FreshclaudeSettings from '@/components/claude-chat/FreshclaudeSettings'

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Settings: (props: any) => <svg data-testid="settings-icon" {...props} />,
}))

describe('FreshclaudeSettings', () => {
  afterEach(cleanup)

  const defaults = {
    model: 'claude-opus-4-6',
    permissionMode: 'dangerouslySkipPermissions',
    effort: 'high',
    showThinking: true,
    showTools: true,
    showTimecodes: false,
  }

  it('renders the settings gear button', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
  })

  it('opens popover when gear button is clicked', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('Permissions')).toBeInTheDocument()
  })

  it('closes popover on Escape key', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('Model')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Model')).not.toBeInTheDocument()
  })

  it('closes popover on click outside', () => {
    render(
      <div>
        <FreshclaudeSettings
          {...defaults}
          sessionStarted={false}
          defaultOpen={true}
          onChange={vi.fn()}
        />
        <button data-testid="outside">Outside</button>
      </div>
    )
    expect(screen.getByText('Model')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByText('Model')).not.toBeInTheDocument()
  })

  it('allows model and permission changes mid-session, disables effort', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        effort="high"
        sessionStarted={true}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )
    const modelSelect = screen.getByLabelText('Model')
    expect(modelSelect).not.toBeDisabled()
    const permSelect = screen.getByLabelText('Permissions')
    expect(permSelect).not.toBeDisabled()
    const effortSelect = screen.getByLabelText('Effort')
    expect(effortSelect).toBeDisabled()
  })

  it('calls onChange when a display toggle is changed', () => {
    const onChange = vi.fn()
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('switch', { name: /show timecodes/i }))
    expect(onChange).toHaveBeenCalledWith({ showTimecodes: true })
  })

  it('calls onChange when model is changed', () => {
    const onChange = vi.fn()
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-sonnet-4-5-20250929' } })
    expect(onChange).toHaveBeenCalledWith({ model: 'claude-sonnet-4-5-20250929' })
  })

  it('opens automatically when defaultOpen is true', () => {
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('Model')).toBeInTheDocument()
  })

  it('calls onDismiss when closed', () => {
    const onDismiss = vi.fn()
    render(
      <FreshclaudeSettings
        {...defaults}
        sessionStarted={false}
        defaultOpen={true}
        onChange={vi.fn()}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
