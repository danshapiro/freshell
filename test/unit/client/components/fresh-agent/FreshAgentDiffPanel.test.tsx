import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FreshAgentDiffPanel } from '@/components/fresh-agent/FreshAgentDiffPanel'
import DiffView from '@/components/fresh-agent/shared/DiffView'

describe('FreshAgentDiffPanel', () => {
  afterEach(() => cleanup())

  it('renders diff entries', () => {
    render(<FreshAgentDiffPanel diffs={[{ id: 'diff-1', title: 'src/app.tsx' }]} />)
    expect(screen.getByText('Diffs')).toBeInTheDocument()
    expect(screen.getByText('src/app.tsx')).toBeInTheDocument()
    expect(screen.getByText('Full diff loading is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Diff:/ })).toBeNull()
  })

  it('renders the shared diff view with data-file-path copy target metadata', () => {
    const { container } = render(
      <DiffView oldStr="const value = 1\n" newStr="const value = 2\n" filePath="src/app.tsx" />,
    )

    const diffView = screen.getByRole('figure', { name: 'diff view' })
    expect(diffView).toBeInTheDocument()
    expect(container.querySelector('[data-diff]')).toHaveAttribute('data-file-path', 'src/app.tsx')
    expect(diffView).toHaveTextContent(/const value = 1/)
    expect(diffView).toHaveTextContent(/const value = 2/)
  })
})
