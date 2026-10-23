import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { TabAttentionIndicator } from '@/components/TabAttentionIndicator'
import { otherTabsNeedAttentionLabel } from '@/lib/tab-attention'

afterEach(() => cleanup())

describe('TabAttentionIndicator', () => {
  it('announces a counted mark as label text inside a polite status, with the visible count hidden from assistive tech', () => {
    render(<TabAttentionIndicator count={2} label={otherTabsNeedAttentionLabel(2)} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    // The label is real text in the region (what a polite region announces),
    // not an aria-label attribute (which live regions do not announce).
    expect(within(status).getByText('2 other tabs need attention')).toBeInTheDocument()
    expect(within(status).getByText('2')).toHaveAttribute('aria-hidden', 'true')
  })

  it('uses the singular wording for one other tab', () => {
    render(<TabAttentionIndicator count={1} label={otherTabsNeedAttentionLabel(1)} />)
    expect(within(screen.getByRole('status')).getByText('1 other tab needs attention')).toBeInTheDocument()
  })

  it('keeps an EMPTY status mounted when the count is zero, so a later mark is announced', () => {
    render(<TabAttentionIndicator count={0} label={otherTabsNeedAttentionLabel(0)} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toBeEmptyDOMElement()
  })

  it('changes the text inside the SAME status element as the count goes 0 → 1 → 2 → 0', () => {
    const { rerender } = render(<TabAttentionIndicator count={0} label={otherTabsNeedAttentionLabel(0)} />)
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()

    rerender(<TabAttentionIndicator count={1} label={otherTabsNeedAttentionLabel(1)} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(within(status).getByText('1 other tab needs attention')).toBeInTheDocument()

    rerender(<TabAttentionIndicator count={2} label={otherTabsNeedAttentionLabel(2)} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(within(status).getByText('2 other tabs need attention')).toBeInTheDocument()
    expect(within(status).queryByText('1 other tab needs attention')).not.toBeInTheDocument()

    rerender(<TabAttentionIndicator count={0} label={otherTabsNeedAttentionLabel(0)} />)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
  })

  it('renders the dot variant hidden from assistive tech (its control carries the meaning)', () => {
    const { container } = render(<TabAttentionIndicator variant="dot" label="An earlier tab needs attention" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const dot = container.firstElementChild
    expect(dot).not.toBeNull()
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })
})
