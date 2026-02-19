import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TerminalSearchBar } from '@/components/terminal/TerminalSearchBar'

afterEach(() => cleanup())

describe('TerminalSearchBar mobile touch targets', () => {
  it('search buttons have min-h-11 min-w-11 and aria-labels', () => {
    render(
      <TerminalSearchBar
        query=""
        onQueryChange={() => {}}
        onFindNext={() => {}}
        onFindPrevious={() => {}}
        onClose={() => {}}
      />
    )

    const prevButton = screen.getByRole('button', { name: /previous match/i })
    const nextButton = screen.getByRole('button', { name: /next match/i })
    const closeButton = screen.getByRole('button', { name: /close search/i })

    for (const btn of [prevButton, nextButton, closeButton]) {
      expect(btn.className).toMatch(/min-h-11/)
      expect(btn.className).toMatch(/min-w-11/)
      expect(btn.className).toMatch(/md:min-h-0/)
      expect(btn.className).toMatch(/md:min-w-0/)
    }
  })
})
