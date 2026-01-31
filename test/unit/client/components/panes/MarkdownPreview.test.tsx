import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownPreview from '../../../../../src/components/panes/MarkdownPreview'

describe('MarkdownPreview', () => {
  it('renders markdown as HTML', () => {
    render(<MarkdownPreview content="# Hello World" />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
  })

  it('renders links', () => {
    render(<MarkdownPreview content="[Click here](https://example.com)" />)

    const link = screen.getByRole('link', { name: /click here/i })
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  it('renders code blocks', () => {
    render(
      <MarkdownPreview
        content={`\`\`\`js
const x = 1
\`\`\``}
      />
    )

    expect(screen.getByText('const x = 1')).toBeInTheDocument()
  })

  it('renders GFM tables', () => {
    render(
      <MarkdownPreview
        content={`
| A | B |
|---|---|
| 1 | 2 |
`}
      />
    )

    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})
