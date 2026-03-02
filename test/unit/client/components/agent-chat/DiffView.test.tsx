import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DiffView from '../../../../../src/components/agent-chat/DiffView'

describe('DiffView', () => {
  afterEach(cleanup)

  it('renders removed and added lines', () => {
    const { container } = render(
      <DiffView oldStr="const foo = 1" newStr="const bar = 1" />
    )
    // Should show removed line with - prefix or red styling
    expect(container.textContent).toContain('foo')
    expect(container.textContent).toContain('bar')
  })

  it('renders with line numbers and diff prefixes', () => {
    const oldStr = ['line1', 'line2', 'line3'].join('\n')
    const newStr = ['line1', 'changed', 'line3'].join('\n')
    render(<DiffView oldStr={oldStr} newStr={newStr} />)

    const figure = screen.getByRole('figure', { name: /diff/i })

    // DiffView renders each diff line as div.flex > [span(lineNo), span(prefix), span(text)].
    // For this diff: context(line1), removed(line2), added(changed), context(line3) = 4 line divs.
    // Each line div has exactly 3 child spans.
    const lineDivs = Array.from(figure.querySelectorAll('.leading-relaxed > div'))
    expect(lineDivs).toHaveLength(4)

    // Extract line numbers and prefixes from each line div
    const parsed = lineDivs.map(div => {
      const spans = div.querySelectorAll('span')
      return {
        lineNo: spans[0]?.textContent?.trim(),
        prefix: spans[1]?.textContent?.trim(),
        text: spans[2]?.textContent?.trim(),
      }
    })

    // Context line1: line 1, space prefix
    expect(parsed[0]).toEqual({ lineNo: '1', prefix: '', text: 'line1' })
    // Removed line2: old line 2, minus prefix
    expect(parsed[1]).toEqual({ lineNo: '2', prefix: '−', text: 'line2' })
    // Added changed: new line 2, plus prefix
    expect(parsed[2]).toEqual({ lineNo: '2', prefix: '+', text: 'changed' })
    // Context line3: line 3, space prefix
    expect(parsed[3]).toEqual({ lineNo: '3', prefix: '', text: 'line3' })
  })

  it('shows no-changes message when strings are identical', () => {
    render(<DiffView oldStr="same" newStr="same" />)
    expect(screen.getByText(/no changes/i)).toBeInTheDocument()
  })

  it('uses semantic role', () => {
    render(<DiffView oldStr="a" newStr="b" />)
    expect(screen.getByRole('figure', { name: /diff/i })).toBeInTheDocument()
  })

  // --- data-* attribute tests for context menu ---

  it('tags diff container with data-diff and data-file-path', () => {
    const oldStr = ['line1', 'line2'].join('\n')
    const newStr = ['line1', 'changed'].join('\n')
    render(<DiffView oldStr={oldStr} newStr={newStr} filePath="/tmp/test.ts" />)
    const diffEl = document.querySelector('[data-diff]')
    expect(diffEl).not.toBeNull()
    expect(diffEl?.getAttribute('data-file-path')).toBe('/tmp/test.ts')
  })
})
