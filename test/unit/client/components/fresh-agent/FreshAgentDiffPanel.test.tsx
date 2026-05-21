import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'

describe('FreshAgentDiffPanel', () => {
  it('renders diff entries', () => {
    render(<FreshAgentDiffPanel diffs={[{ id: 'diff-1', title: 'src/app.tsx' }]} />)
    expect(screen.getByText('Diffs')).toBeInTheDocument()
    expect(screen.getByText('src/app.tsx')).toBeInTheDocument()
  })
})
