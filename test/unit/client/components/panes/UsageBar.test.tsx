import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import UsageBar from '@/components/ui/usage-bar'

describe('UsageBar', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a progressbar with the correct aria attributes', () => {
    render(<UsageBar percent={50} />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toBeInTheDocument()
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-label', 'Context usage: 50%')
  })

  it('uses green (bg-success) color below 70%', () => {
    const { container } = render(<UsageBar percent={50} />)

    const fill = container.querySelector('[role="progressbar"] > div')
    expect(fill).toHaveClass('bg-success')
  })

  it('uses yellow (bg-warning) color between 70% and 89%', () => {
    const { container } = render(<UsageBar percent={80} />)

    const fill = container.querySelector('[role="progressbar"] > div')
    expect(fill).toHaveClass('bg-warning')
  })

  it('uses red (bg-destructive) color at 90% and above', () => {
    const { container } = render(<UsageBar percent={95} />)

    const fill = container.querySelector('[role="progressbar"] > div')
    expect(fill).toHaveClass('bg-destructive')
  })

  it('clamps percent above 100 to 100', () => {
    render(<UsageBar percent={150} />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '100')
  })

  it('clamps percent below 0 to 0', () => {
    render(<UsageBar percent={-10} />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '0')
  })

  it('rounds non-integer percentages', () => {
    render(<UsageBar percent={85.7} />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '86')
  })

  it('applies custom className', () => {
    render(<UsageBar percent={50} className="ml-2" />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveClass('ml-2')
  })
})
