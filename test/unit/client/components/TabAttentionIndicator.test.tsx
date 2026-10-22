import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TabAttentionIndicator } from '@/components/TabAttentionIndicator'
import { otherTabsNeedAttentionLabel } from '@/lib/tab-attention'

afterEach(() => cleanup())

describe('TabAttentionIndicator', () => {
  it('announces a counted mark as a polite status with its label and shows the count', () => {
    render(<TabAttentionIndicator count={2} label={otherTabsNeedAttentionLabel(2)} />)
    const status = screen.getByRole('status', { name: '2 other tabs need attention' })
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('2')
  })

  it('uses the singular wording for one other tab', () => {
    render(<TabAttentionIndicator count={1} label={otherTabsNeedAttentionLabel(1)} />)
    expect(screen.getByRole('status', { name: '1 other tab needs attention' })).toBeInTheDocument()
  })

  it('renders nothing when the count is zero', () => {
    const { container } = render(<TabAttentionIndicator count={0} label={otherTabsNeedAttentionLabel(0)} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders the dot variant hidden from assistive tech (its control carries the meaning)', () => {
    const { container } = render(<TabAttentionIndicator variant="dot" label="An earlier tab needs attention" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const dot = container.firstElementChild
    expect(dot).not.toBeNull()
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })
})
