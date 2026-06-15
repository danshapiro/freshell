import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'
import DiffView from '@/components/fresh-agent/shared/DiffView'

describe('FreshAgentDiffPanel', () => {
  it('renders diff entries', () => {
    render(<FreshAgentDiffPanel diffs={[{ id: 'diff-1', title: 'src/app.tsx' }]} />)
    expect(screen.getByText('Diffs')).toBeInTheDocument()
    expect(screen.getByText('src/app.tsx')).toBeInTheDocument()
  })

  it('renders the shared diff view with data-file-path copy target metadata', () => {
    const { container } = render(
      <DiffView oldStr="const value = 1\n" newStr="const value = 2\n" filePath="src/app.tsx" />,
    )

    expect(screen.getByRole('figure', { name: 'diff view' })).toBeInTheDocument()
    expect(container.querySelector('[data-diff]')).toHaveAttribute('data-file-path', 'src/app.tsx')
    expect(screen.getByText('const value = 1')).toBeInTheDocument()
    expect(screen.getByText('const value = 2')).toBeInTheDocument()
  })
})
